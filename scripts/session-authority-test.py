from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.case_registry import PROFILES, case_view, client_view, trainee_report_view
from adk_service.session_authority import SessionAuthority, SessionError


class SQLiteStore:
    pg_pool = None

    def __init__(self, path: Path):
        self.db_path = path
        with self._connect() as db:
            db.execute("""CREATE TABLE simulator_events (
                session_id TEXT, agent_trace_id TEXT, event_type TEXT,
                payload_json TEXT, created_at TEXT)""")

    def _connect(self):
        return sqlite3.connect(self.db_path, timeout=10)

    def start_session(self, case, session_id):
        return None


class SessionAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = SQLiteStore(Path(self.temp.name) / "sessions.sqlite")
        self.authority = SessionAuthority(self.store)
        self.case = {"id": "case-one", "psychologicalState": {"clientOpenness": 3.0}}
        self.session = self.authority.start(self.case, "owner-a")

    def tearDown(self):
        self.temp.cleanup()

    def test_commit_is_atomic_and_same_turn_is_idempotent(self):
        sid = self.session["sessionId"]
        snapshot, token, cached = self.authority.reserve(sid, "owner-a", "turn-1", 0)
        self.assertEqual(snapshot["stateVersion"], 0)
        self.assertIsNone(cached)
        next_case = {"id": "case-one", "psychologicalState": {"clientOpenness": 2.2}}
        state = {"caseProfile": next_case, "continuity": {"turns": 1}, "history": []}
        response = {"clientText": "嗯。", "agentTraceId": "trace-1"}
        committed = self.authority.commit(sid, "owner-a", "turn-1", token, 0, state, response, {"studentText": "你好"})

        current, token, cached = self.authority.reserve(sid, "owner-a", "turn-1", 0)
        self.assertEqual(current["stateVersion"], 1)
        self.assertIsNone(token)
        self.assertEqual(cached["stateVersion"], committed["stateVersion"])
        self.assertEqual(current["caseProfile"]["psychologicalState"]["clientOpenness"], 2.2)
        with self.store._connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM simulator_events WHERE session_id=?", (sid,)).fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT COUNT(*) FROM training_turns WHERE session_id=? AND status='committed'", (sid,)).fetchone()[0], 1)

    def test_version_conflict_cancel_and_owner_isolation(self):
        sid = self.session["sessionId"]
        with self.assertRaises(SessionError) as conflict:
            self.authority.reserve(sid, "owner-a", "stale", 9)
        self.assertEqual(conflict.exception.code, "state_version_conflict")
        with self.assertRaises(SessionError) as denied:
            self.authority.read(sid, "owner-b")
        self.assertEqual(denied.exception.code, "session_not_found")

        _, token, _ = self.authority.reserve(sid, "owner-a", "cancel-me", 0)
        self.authority.cancel(sid, "owner-a", "cancel-me")
        with self.assertRaises(SessionError):
            self.authority.commit(sid, "owner-a", "cancel-me", token, 0,
                                  {"caseProfile": self.case, "continuity": {}, "history": []},
                                  {"clientText": "discard", "agentTraceId": "trace-cancel"}, {})
        self.assertEqual(self.authority.read(sid, "owner-a")["stateVersion"], 0)


class ProjectionTests(unittest.TestCase):
    def test_trainee_views_include_only_referral_and_disclosed_facts(self):
        case = json.loads(json.dumps(PROFILES[0]))
        case["hiddenFacts"][0]["disclosed"] = True
        trainee = case_view(case, "trainee")
        self.assertEqual([fact["id"] for fact in trainee["hiddenFacts"]], [case["hiddenFacts"][0]["id"]])
        for forbidden in ("persona", "riskProfile", "eventTimeline", "socialWorkContextModel", "relationships", "issueTags", "source"):
            self.assertNotIn(forbidden, trainee)

        response = {"clientText": "嗯。", "riskSignals": ["private-risk"], "revealedFacts": ["secret"],
                    "adaptivePolicySnapshot": {"targetResistanceLevel": "high"},
                    "sessionContinuitySnapshot": {"ruptureEvents": ["private"]},
                    "evidenceSummary": {"cards": [{"id": "private-card"}]},
                    "avatarDirective": {"motionCue": "look_down", "basis": [{"reason": "private"}],
                                        "expressionPlan": {"templateId": "withdrawn", "basis": "private"}}}
        projected = client_view(response, "trainee")
        self.assertEqual(projected["clientText"], "嗯。")
        self.assertEqual(projected["riskSignals"], [])
        self.assertEqual(projected["revealedFacts"], [])
        for forbidden in ("adaptivePolicySnapshot", "sessionContinuitySnapshot", "evidenceSummary"):
            self.assertNotIn(forbidden, projected)
        self.assertNotIn("basis", projected["avatarDirective"])
        self.assertIn("riskProfile", case_view(case, "instructor"))

    def test_trainee_report_projection_matches_report_contract(self):
        report = {
            "overallSummary": "Session summary",
            "competencyScores": {"engagement": 6},
            "suggestedPracticeGoals": ["Practice reflective listening"],
            "instructorDebug": {"private": "omit"},
            "processReview": {"turningPoints": [{"turnId": "turn-1", "whatHappened": "Student reflected", "privateFact": "omit"}],
                              "effectiveMoments": [], "missedOpportunities": []},
            "caseSpecificFeedback": {"frameworkUsed": [], "learningObjectivesMet": [], "learningObjectivesNotMet": []},
            "hkPcfAssessment": {
                "frameworkLabel": "HK practice framework", "frameworkBasis": ["instructor-only"],
                "scores": {"engagementAndRelationship": 6},
                "domainAssessments": {"engagementAndRelationship": {"status": "observed", "confidence": 0.7, "evidenceTurnIds": ["turn-1"]}},
                "evidence": {"strengths": [], "concerns": [], "turningPoints": [], "missedOpportunities": []},
                "practiceRecommendations": [], "disclaimer": "Training prototype",
                "microMesoMacroCoverage": {"private": True},
            },
        }
        projected = trainee_report_view(report)
        self.assertEqual(projected["hkPcfAssessment"]["frameworkBasis"], [])
        self.assertIn("concerns", projected["hkPcfAssessment"]["evidence"])
        self.assertNotIn("instructorDebug", projected)
        self.assertNotIn("microMesoMacroCoverage", projected["hkPcfAssessment"])
        self.assertNotIn("privateFact", projected["processReview"]["turningPoints"][0])


if __name__ == "__main__":
    unittest.main()
