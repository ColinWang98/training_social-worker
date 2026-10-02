"""Transactional training state. Provider invocations never hold a database lock."""
from contextlib import contextmanager
from copy import deepcopy
import json
import sqlite3
import time
import uuid


class SessionError(ValueError):
    def __init__(self, code, status=409):
        super().__init__(code)
        self.code, self.status = code, status


class SessionAuthority:
    def __init__(self, store):
        self.store = store
        if not store.pg_pool:
            backup = store.db_path.with_suffix('.pre-authority.sqlite')
            with store._connect() as db:
                exists = db.execute("SELECT name FROM sqlite_master WHERE name='training_state'").fetchone()
                if not exists and not backup.exists():
                    with sqlite3.connect(backup) as dest:
                        db.backup(dest)
        with self.transaction() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS training_state (
                session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, initial_json TEXT NOT NULL,
                state_json TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL)''')
            db.execute('''CREATE TABLE IF NOT EXISTS training_turns (
                session_id TEXT NOT NULL, turn_id TEXT NOT NULL, status TEXT NOT NULL,
                token TEXT NOT NULL, deadline DOUBLE PRECISION NOT NULL,
                response_json TEXT, PRIMARY KEY(session_id, turn_id))''')

    @contextmanager
    def transaction(self):
        if self.store.pg_pool:
            with self.store.pg_pool.connection() as conn, conn.transaction():
                class Adapter:
                    def execute(self, sql, args=()):
                        return conn.execute(sql.replace('?', '%s'), args)
                yield Adapter()
        else:
            with self.store._connect() as conn:
                conn.row_factory = sqlite3.Row
                conn.execute('BEGIN IMMEDIATE')
                yield conn

    def _read(self, db, sid, owner):
        suffix = ' FOR UPDATE' if self.store.pg_pool else ''
        row = db.execute('SELECT * FROM training_state WHERE session_id=?' + suffix, (sid,)).fetchone()
        if not row or row['owner'] != owner:
            raise SessionError('session_not_found', 404)
        return row

    def start(self, case, owner, sid=None):
        if sid:
            return self.read(sid, owner)
        sid = 'session-' + uuid.uuid4().hex
        state = {'caseProfile': deepcopy(case), 'continuity': {}, 'history': []}
        with self.transaction() as db:
            db.execute('INSERT INTO training_state VALUES (?,?,?,?,?,?)',
                       (sid, owner, json.dumps(case), json.dumps(state), 0, 'active'))
        self.store.start_session(case, sid)
        return self.read(sid, owner)

    def read(self, sid, owner):
        with self.transaction() as db:
            row = self._read(db, sid, owner)
            return self._view(row)

    @staticmethod
    def _view(row):
        return {**json.loads(row['state_json']), 'sessionId': row['session_id'],
                'stateVersion': row['version'], 'status': row['status'],
                'initialCase': json.loads(row['initial_json'])}

    def reserve(self, sid, owner, tid, expected=None):
        now, token = time.time(), uuid.uuid4().hex
        with self.transaction() as db:
            row = self._read(db, sid, owner)
            prior = db.execute('SELECT * FROM training_turns WHERE session_id=? AND turn_id=?', (sid, tid)).fetchone()
            if prior and prior['status'] == 'committed':
                return self._view(row), None, json.loads(prior['response_json'])
            if prior and prior['status'] == 'cancelled':
                raise SessionError('turn_cancelled')
            if row['status'] != 'active':
                raise SessionError('session_closed')
            if expected is not None and expected != row['version']:
                raise SessionError('state_version_conflict')
            active = db.execute("SELECT turn_id FROM training_turns WHERE session_id=? AND status='generating' AND deadline>?", (sid, now)).fetchone()
            if active:
                raise SessionError('session_busy')
            db.execute("UPDATE training_turns SET status='expired' WHERE session_id=? AND status='generating'", (sid,))
            db.execute('''INSERT INTO training_turns VALUES (?,?,?,?,?,NULL)
                ON CONFLICT(session_id,turn_id) DO UPDATE SET status=excluded.status,
                token=excluded.token,deadline=excluded.deadline,response_json=NULL''',
                       (sid, tid, 'generating', token, now + 180))
            return self._view(row), token, None

    def cancel(self, sid, owner, tid):
        with self.transaction() as db:
            self._read(db, sid, owner)
            db.execute("UPDATE training_turns SET status='cancelled' WHERE session_id=? AND turn_id=? AND status='generating'", (sid, tid))

    def fail(self, sid, tid, token):
        with self.transaction() as db:
            db.execute("UPDATE training_turns SET status='failed' WHERE session_id=? AND turn_id=? AND token=? AND status='generating'", (sid, tid, token))

    def commit(self, sid, owner, tid, token, version, state, response, event):
        with self.transaction() as db:
            row = self._read(db, sid, owner)
            turn = db.execute('SELECT * FROM training_turns WHERE session_id=? AND turn_id=?', (sid, tid)).fetchone()
            if not turn or turn['status'] != 'generating' or turn['token'] != token or turn['deadline'] < time.time():
                raise SessionError('turn_cancelled_or_expired')
            if row['version'] != version or row['status'] != 'active':
                raise SessionError('state_version_conflict')
            response.update(turnId=tid, responseId=response.get('responseId') or 'resp-' + uuid.uuid4().hex,
                            sessionId=sid, stateVersion=version + 1, sessionView=state['caseProfile'])
            db.execute('UPDATE training_state SET state_json=?,version=? WHERE session_id=?', (json.dumps(state), version + 1, sid))
            db.execute("UPDATE training_turns SET status='committed',response_json=? WHERE session_id=? AND turn_id=?", (json.dumps(response), sid, tid))
            payload = {**event, 'clientResponse': response}
            encoded = json.dumps(payload, ensure_ascii=False)
            if self.store.pg_pool:
                from psycopg.types.json import Jsonb
                encoded = Jsonb(payload)
            now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            db.execute('INSERT INTO simulator_events(session_id,agent_trace_id,event_type,payload_json,created_at) VALUES (?,?,?,?,?)',
                       (sid, response['agentTraceId'], 'interview_turn', encoded, now))
        return response

    def close(self, sid, owner):
        with self.transaction() as db:
            self._read(db, sid, owner)
            active = db.execute("SELECT turn_id FROM training_turns WHERE session_id=? AND status='generating' AND deadline>?", (sid, time.time())).fetchone()
            if active:
                raise SessionError('session_busy')
            db.execute("UPDATE training_state SET status='closed' WHERE session_id=?", (sid,))
