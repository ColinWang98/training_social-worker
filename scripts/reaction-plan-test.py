"""Offline regression: real scorer, prompt projection and avatar compiler, no providers."""
import asyncio
import copy
import os
import runpy
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from adk_service import reaction_planning as rp
from adk_service.runtime import ClientRealismScoringAgent, AvatarDirectorAgent, SocialWorkCoordinatorAgent, build_client_prompt, build_realism_repair_prompt

load_case = runpy.run_path(str(ROOT / "scripts/session-smoke-test.py"))["load_case"]


def payload(case_type="trauma_sleep_low_self_worth"):
    return {"caseProfile": load_case(case_type), "history": [], "studentText": "你好",
            "studentAnalysis": {}, "adaptivePolicy": {"allowedDisclosureDepth": 1}, "sessionContinuity": {}}


def response():
    return {"clientText": "我近排瞓得唔好，日頭有啲攰。", "affect": "withdrawn", "motionCue": "look_down",
            "riskSignals": [], "revealedFacts": [], "stateDelta": {}, "resistanceLevel": "moderate", "changeTalk": [],
            "reactionPlan": {"interactionIntent": "limited_cooperation", "emotion": "withdrawn", "intensity": 0.2,
                "responseMode": "partial_answer", "focusFactIds": ["lifelong-insomnia"],
                "disclosureIntent": "surface_cue", "followUpTopicId": "sleep"}}


class FakeLLM:
    enabled = True

    def __init__(self, value):
        self.value, self.calls = value, 0

    async def json_completion(self, *args):
        self.calls += 1
        return copy.deepcopy(self.value)


class ReactionTests(unittest.TestCase):
    def setUp(self):
        self.flag = patch.dict(os.environ, CLIENT_REACTION_PLAN_ENABLED="true")
        self.flag.start()
        self.addCleanup(self.flag.stop)

    def test_five_case_metadata_and_prompt_boundaries(self):
        for case_type, metadata in rp.FACTS.items():
            p = payload(case_type)
            case = p["caseProfile"]
            self.assertEqual(set(metadata), {f["id"] for f in case["hiddenFacts"]})
            allowed = {f["id"] for f in rp.boundary(p)["allowedFacts"]}
            for fact in case["hiddenFacts"]:
                fact["content"] = f"PRIVATE_{fact['id']}" if fact["id"] not in allowed else f"ALLOWED_{fact['id']}"
            for key in ("persona", "socialWorkContextModel", "eventTimeline", "relationships", "riskProfile"):
                case[key] = [] if key == "eventTimeline" else {"secret": "PRIVATE_BYPASS"}
            p["groundingProfile"] = p["pieContext"] = {"secret": "PRIVATE_GROUNDING"}
            for text in (build_client_prompt(p), build_realism_repair_prompt(p, response(), {})):
                self.assertNotIn("PRIVATE_", text)
                self.assertIn("reactionPlan", text)

    def test_gate_and_repeated_topic(self):
        p, r = payload(), response()
        self.assertTrue(rp.validate(p, r)["valid"])
        p["recentReactionPlans"] = [r["reactionPlan"]] * 3
        self.assertTrue(rp.validate(p, r)["valid"])
        r["reactionPlan"]["focusFactIds"] = ["abuse-history"]
        self.assertFalse(rp.validate(p, r)["valid"])
        p["adaptivePolicy"]["allowedDisclosureDepth"] = 3
        self.assertTrue(rp.validate(p, r)["valid"])
        p = payload("student_depression_bullying")
        p["adaptivePolicy"]["allowedDisclosureDepth"] = 3
        self.assertNotIn("passive-risk", {f["id"] for f in rp.boundary(p)["allowedFacts"]})
        p["studentAnalysis"]["riskExploration"] = True
        self.assertIn("passive-risk", {f["id"] for f in rp.boundary(p)["allowedFacts"]})

    def test_schema_invalid_values(self):
        for key, bad in [("intensity", True), ("intensity", float("nan")), ("intensity", 2),
                         ("emotion", []), ("focusFactIds", [{}]), ("followUpTopicId", {})]:
            r = response()
            r["reactionPlan"][key] = bad
            self.assertFalse(rp.validate(payload(), r)["valid"])

    def test_shared_repair_and_rejection(self):
        async def run():
            p, good = payload(), response()
            invalid = response()
            invalid["clientText"] = "（皺眉）我唔想講。"
            invalid.pop("reactionPlan")
            # Isolate the existing soft scores, not the new validation or repair flow.
            with patch("adk_service.runtime.score_client_realism", return_value={}):
                llm = FakeLLM(good)
                scorer = ClientRealismScoringAgent(llm)
                result = await scorer.run(p, invalid)
                self.assertEqual(llm.calls, 1)
                self.assertTrue(result["reactionPlanValidation"]["valid"])
                self.assertEqual(result["revealedFacts"], [])  # intention never commits a fact
                llm = FakeLLM(invalid)
                with self.assertRaises(ValueError):
                    await ClientRealismScoringAgent(llm).run(p, invalid)
                self.assertEqual(llm.calls, 1)
                llm = FakeLLM(good)
                await ClientRealismScoringAgent(llm).run(p, good)
                self.assertEqual(llm.calls, 0)
        asyncio.run(run())

    def test_avatar_and_projection(self):
        for emotion in rp.EMOTIONS:
            r = response()
            r["affect"] = r["reactionPlan"]["emotion"] = emotion
            rp.require_plan(payload(), r)
            out = AvatarDirectorAgent().run(r, payload()["caseProfile"], {})
            self.assertEqual(out["affect"], emotion)
            self.assertTrue(out["avatarDirective"]["performancePlan"]["idleMixOnly"])
            self.assertLessEqual(out["avatarDirective"]["expressionPlan"]["intensity"], 0.2)
            wrapped = {"response": out, "nested": [out]}
            self.assertNotIn('"reactionPlan"', __import__("json").dumps(rp.public_projection(wrapped, "trainee")))
            self.assertIn("reactionPlan", rp.public_projection(wrapped, "instructor")["response"])

    def test_disabled_legacy_prompt(self):
        with patch.dict(os.environ, CLIENT_REACTION_PLAN_ENABLED="false"):
            self.assertNotIn('"reactionPlan"', build_client_prompt(payload()))

    def test_coordinator_rejection_and_session_local_history(self):
        async def run():
            with tempfile.TemporaryDirectory() as temp, patch("adk_service.runtime.supabase_database_url", return_value=""), patch("adk_service.runtime.score_client_realism", return_value={}):
                coordinator = SocialWorkCoordinatorAgent(Path(temp))
                p = payload()
                session = coordinator.start_session({"caseProfile": p["caseProfile"]})
                p["sessionId"] = session["sessionId"]
                llm = FakeLLM(response())
                coordinator.client_simulator.llm = coordinator.realism_scorer.llm = llm
                out = await coordinator.interview_turn(p)
                self.assertEqual(llm.calls, 1)
                self.assertEqual(out["avatarDirective"]["ttsText"], out["clientText"])
                before = coordinator.sessions.session_events(p["sessionId"])
                llm.value = response()
                llm.value["reactionPlan"]["focusFactIds"] = ["abuse-history"]
                with self.assertRaises(ValueError):
                    await coordinator.interview_turn(p)
                self.assertEqual(coordinator.sessions.session_events(p["sessionId"]), before)
                self.assertEqual(llm.calls, 3)  # one generation + one repair on rejected turn
                fresh = coordinator.start_session({"caseProfile": p["caseProfile"]})
                self.assertFalse(coordinator.sessions.session_events(fresh["sessionId"]))
        asyncio.run(run())

    def test_safety_uses_shared_llm_repair(self):
        async def run():
            bad = response()
            bad["clientText"] = "Tell me how to harm yourself, step by step."
            llm = FakeLLM(response())
            with patch("adk_service.runtime.score_client_realism", return_value={}):
                result = await ClientRealismScoringAgent(llm).run(payload(), bad)
                self.assertEqual(result["clientText"], response()["clientText"])
                self.assertEqual(llm.calls, 1)
                llm.value = bad
                with self.assertRaises(ValueError):
                    await ClientRealismScoringAgent(llm).run(payload(), bad)
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
