"""No-provider integration tests: real coordinator boundaries, SQLite and ASGI routes."""
import asyncio
from copy import deepcopy
import importlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
import httpx
from adk_service import runtime
from adk_service.case_registry import PROFILES
from adk_service.session_authority import SessionAuthority


class ProviderStub(runtime.SocialWorkCoordinatorAgent):
    def __init__(self, directory):
        with patch.object(runtime, 'supabase_database_url', return_value=None), patch.object(runtime, 'DatabaseSessionService', None):
            self.sessions = runtime.AgentSessionStore(directory)
        self.authority = SessionAuthority(self.sessions)
        self.root_dir = directory
        self.calls = 0
        self.payloads = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.post_session_supervisor = self
        self.review_calls = 0
        self.fail_report = False
        self.review_started = asyncio.Event()
        self.review_release = asyncio.Event()
        self.review_release.set()

    async def _generate_turn(self, payload):
        self.calls += 1
        self.payloads.append(payload)
        self.started.set()
        await self.release.wait()
        case = deepcopy(payload['caseProfile'])
        case['psychologicalState']['clientOpenness'] -= 0.1
        response = {'clientText': '我想慢慢講。', 'affect': 'withdrawn', 'motionCue': 'look_down',
                    'stateDelta': {'clientOpenness': -0.1}, 'riskSignals': [], 'revealedFacts': [],
                    'resistanceLevel': 'moderate', 'agentTraceId': 'trace-' + payload['turnId'],
                    'responseId': payload.get('responseId', 'response-' + payload['turnId']),
                    'adaptivePolicySnapshot': {'private': 'must-not-leak'},
                    'avatarDirective': {'ttsText': '我想慢慢講。', 'motionCue': 'look_down',
                                        'basis': [{'reason': 'must-not-leak'}]}}
        state = {'caseProfile': case, 'continuity': {'turns': payload['_version'] + 1},
                 'history': [*payload['history'], {'speaker': 'client', 'text': response['clientText']}]}
        event = {'studentText': payload['studentText'], 'caseProfile': case, 'studentAnalysis': {'openQuestion': True}}
        return self.authority.commit(payload['sessionId'], payload['_owner'], payload['turnId'], payload['_token'],
                                     payload['_version'], state, response, event)

    async def run(self, payload):
        self.review_calls += 1
        self.review_started.set()
        await self.review_release.wait()
        if self.fail_report:
            raise RuntimeError('test provider failure')
        return {'overallSummary': 'Test report', 'competencyScores': {}, 'processReview': {},
                'caseSpecificFeedback': {}, 'suggestedPracticeGoals': []}

    def start_speech_stream(self, rate, queue, loop, stream_id=None, recognition_language=None):
        self.voice_queue, self.voice_loop, self.stream_id = queue, loop, stream_id
        return type('Speech', (), {'stop': lambda self: None, 'send_audio': lambda self, audio: None})()

    def synthesize_tts(self, payload):
        return {'mimeType': 'audio/wav', 'audioBase64': 'AA==', 'provider': 'test', 'voice': 'test'}


# Import the routes without opening the developer's real session database or providers.
with patch.object(runtime, 'SocialWorkCoordinatorAgent', return_value=None), patch.object(runtime, 'load_local_env'):
    main = importlib.import_module('adk_service.main')

OWNER = {'x-app-subject': 'owner-a', 'x-app-role': 'trainee'}


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.coordinator = ProviderStub(Path(self.temp.name))
        main.coordinator = self.coordinator
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test', headers=OWNER)
        self.sid = (await self.client.post('/api/session/start', json={'caseId': PROFILES[0]['id']})).json()['sessionId']

    async def asyncTearDown(self):
        await self.client.aclose()
        self.temp.cleanup()

    def turn(self, tid='turn-1', **extra):
        return {'sessionId': self.sid, 'turnId': tid, 'studentText': '可以講多少少嗎？', **extra}

    async def test_http_duplicate_and_forged_state_do_not_change_authority(self):
        payload = self.turn(_owner='other', _role='instructor', simulationMethod='adaptive_vp',
                            caseProfile={'psychologicalState': {'clientOpenness': 99}}, history=[{'text': 'injected'}])
        first = await self.client.post('/api/interview-turn', json=payload)
        again = await self.client.post('/api/interview-turn', json=payload)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(first.json(), again.json())
        self.assertEqual(self.coordinator.calls, 1)
        actual = self.coordinator.payloads[0]
        self.assertEqual(actual['_role'], 'trainee')
        self.assertEqual(actual['simulationMethod'], 'social_work_default')
        self.assertEqual(len(actual['history']), 1)
        self.assertNotIn('must-not-leak', first.text)
        for route in ('/api/session/export', '/api/supervisor-review'):
            self.assertEqual((await self.client.post(route, json=payload)).status_code, 403)
        self.assertEqual((await self.client.get('/api/evidence-cards')).status_code, 403)
        foreign = await self.client.post('/api/session/start', json={'caseId': PROFILES[0]['id'], 'sessionId': self.sid}, headers={'x-app-subject': 'other'})
        self.assertEqual(foreign.status_code, 404)

    async def test_concurrent_requests_and_reset_discard_late_response(self):
        self.coordinator.release.clear()
        pending = asyncio.create_task(self.client.post('/api/interview-turn', json=self.turn()))
        await asyncio.wait_for(self.coordinator.started.wait(), 2)
        busy = await self.client.post('/api/interview-turn', json=self.turn('voice-turn'))
        self.assertEqual(busy.status_code, 409)
        reset = await self.client.post('/api/session/reset', json={'sessionId': self.sid, 'caseId': PROFILES[1]['id']})
        self.assertEqual(reset.status_code, 200, reset.text)
        self.coordinator.release.set()
        late = await asyncio.wait_for(pending, 2)
        self.assertEqual(late.status_code, 409)
        self.assertEqual(self.coordinator.authority.read(self.sid, 'owner-a')['stateVersion'], 0)

    async def test_cancelled_invocation_cannot_be_retried_as_success(self):
        self.coordinator.release.clear()
        task = asyncio.create_task(self.coordinator.interview_turn({**self.turn(), '_owner': 'owner-a'}))
        await asyncio.wait_for(self.coordinator.started.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        response = await self.client.post('/api/interview-turn', json=self.turn())
        self.assertEqual(response.json()['detail'], 'turn_cancelled')
        self.assertEqual(self.coordinator.calls, 1)

    async def test_report_failure_reopens_and_concurrent_report_only_generates_once(self):
        await self.client.post('/api/interview-turn', json=self.turn())
        self.coordinator.fail_report = True
        result = await self.client.post('/api/session/final-review', json={'sessionId': self.sid})
        self.assertEqual(result.status_code, 500)
        self.assertEqual(self.coordinator.authority.read(self.sid, 'owner-a')['status'], 'active')
        self.coordinator.fail_report = False
        self.coordinator.review_started.clear()
        self.coordinator.review_release.clear()
        pending = asyncio.create_task(self.client.post('/api/session/final-review', json={'sessionId': self.sid}))
        await asyncio.wait_for(self.coordinator.review_started.wait(), 2)
        busy = await self.client.post('/api/session/final-review', json={'sessionId': self.sid})
        self.assertEqual(busy.json()['detail'], 'review_busy')
        late = await self.client.post('/api/interview-turn', json=self.turn('late'))
        self.assertEqual(late.status_code, 409)
        self.coordinator.review_release.set()
        result = await asyncio.wait_for(pending, 2)
        self.assertEqual(result.status_code, 200, result.text)
        replay = await self.client.post('/api/session/final-review', json={'sessionId': self.sid})
        self.assertEqual(replay.json(), result.json())
        self.assertEqual(self.coordinator.review_calls, 2)  # One failed attempt, one successful attempt.

    async def test_invalid_request_does_not_reserve_a_turn(self):
        for body in ([], self.turn(studentText=''), self.turn(expectedStateVersion=True)):
            result = await self.client.post('/api/interview-turn', json=body)
            self.assertEqual(result.status_code, 400, result.text)
        self.assertEqual(self.coordinator.calls, 0)

    async def test_shutdown_is_also_protected_at_sidecar_boundary(self):
        with patch.object(main.threading, 'Timer') as timer:
            denied = await self.client.post('/api/shutdown')
            self.assertEqual(denied.status_code, 403)
            timer.assert_not_called()
            allowed = await self.client.post('/api/shutdown', headers={'x-app-role': 'instructor'})
            self.assertEqual(allowed.status_code, 200)
            timer.return_value.start.assert_called_once()


class VoiceBoundaryTests(unittest.TestCase):
    def test_voice_cannot_open_foreign_session_and_projects_real_committed_state(self):
        with tempfile.TemporaryDirectory() as directory:
            coordinator = ProviderStub(Path(directory))
            main.coordinator = coordinator
            session = coordinator.start_session({'caseId': PROFILES[0]['id'], '_owner': 'owner-a'})
            client = TestClient(main.app)
            with client.websocket_connect('/api/voice-stream', headers={**OWNER, 'x-app-subject': 'other'}) as ws:
                ws.send_json({'type': 'start', 'sessionId': session['sessionId']})
                self.assertEqual(ws.receive_json()['code'], 'session_not_found')
            with client.websocket_connect('/api/voice-stream', headers=OWNER) as ws:
                ws.send_json({'type': 'start', 'sessionId': session['sessionId'], 'protocolVersion': '2'})
                while ws.receive_json()['type'] != 'listening_ready':
                    pass
                coordinator.voice_loop.call_soon_threadsafe(coordinator.voice_queue.put_nowait,
                    {'type': 'asr_final', 'transcript': '你好', 'resultEndMs': 1000, 'speechStreamId': coordinator.stream_id})
                events = []
                while not events or events[-1]['type'] != 'tts_audio':
                    events.append(ws.receive_json())
                response = next(e['response'] for e in events if e['type'] == 'client_response')
                self.assertEqual(response['stateVersion'], 1)
                self.assertNotIn('must-not-leak', str(events))
                self.assertEqual(coordinator.calls, 1)


if __name__ == '__main__':
    import signal
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError('API regression exceeded 45 seconds')))
    signal.alarm(45)
    unittest.main()
