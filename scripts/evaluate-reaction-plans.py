"""Explicit paid A/B evaluation. No TTS; isolated sessions and private local reports."""
import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import runpy
import sys
import tempfile
import time
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


async def evaluate():
    from adk_service.runtime import SocialWorkCoordinatorAgent, EvidenceRetrievalAgent, load_local_env
    from adk_service.reaction_planning import FACTS
    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service/.env")
    helpers = runpy.run_path(str(ROOT / "scripts/session-smoke-test.py"))
    records = []
    with tempfile.TemporaryDirectory(prefix="reaction-evaluation-") as temp, patch("adk_service.runtime.supabase_database_url", return_value=""):
        coordinator = SocialWorkCoordinatorAgent(Path(temp))
        coordinator.root_dir = ROOT
        coordinator.evidence_retriever = EvidenceRetrievalAgent(ROOT)
        if not coordinator.llm.enabled:
            raise RuntimeError("DeepSeek credentials are required for the explicitly requested evaluation.")
        for case_type in FACTS:
            turns = ["你好", "我能理解你", "不会吧", "抱歉，我頭先處理得唔好"] + helpers["SESSION_PLANS"][case_type][:4]
            for mode in (False, True):
                with patch.dict(os.environ, CLIENT_REACTION_PLAN_ENABLED=str(mode).lower()):
                    case = helpers["load_case"](case_type)
                    session = coordinator.start_session({"caseProfile": case})
                    history = []
                    for index, text in enumerate(turns):
                        started = time.monotonic()
                        entry = {"caseType": case_type, "enabled": mode, "turn": index + 1, "studentText": text}
                        try:
                            result = await coordinator.interview_turn({"sessionId": session["sessionId"],
                                "caseProfile": case, "history": history, "studentText": text,
                                "retrievalOptions": {"embeddingEnabled": False}})
                            entry["response"] = result
                            case = helpers["apply_response"](case, result)
                            history += [{"speaker": "student", "text": text}, {"speaker": "client", "text": result["clientText"]}]
                        except Exception as exc:
                            entry["errorType"] = type(exc).__name__  # Never print provider error bodies/credentials.
                        entry["elapsedMs"] = round((time.monotonic() - started) * 1000)
                        records.append(entry)
    summary = {}
    for mode in (False, True):
        rows = [r for r in records if r["enabled"] == mode]
        success = [r for r in rows if "response" in r]
        times = sorted(r["elapsedMs"] for r in success)
        summary[str(mode).lower()] = {"turns": len(rows), "errors": len(rows) - len(success),
            "p95Ms": times[math.ceil(.95 * len(times)) - 1] if times else None,
            **{key: sum(bool(r["response"].get("realismAssessment", {}).get(key)) for r in success)
               for key in ("repairApplied", "semanticRepeatRisk", "avoidanceOveruseRisk")}}
    old, new = summary["false"], summary["true"]
    automatic = (not new["errors"] and bool(old["p95Ms"]) and bool(new["p95Ms"])
                 and new["p95Ms"] <= old["p95Ms"] * 1.15
                 and all(new[k] <= old[k] for k in ("semanticRepeatRisk", "avoidanceOveruseRisk")))
    report = {"summary": summary, "automaticGatePassed": automatic, "humanReviewRequired": True,
              "humanReview": {"topicSpecificity": None, "continuity": None, "planDialogueAlignment": None}, "records": records}
    directory = ROOT / "data/reports/reaction-plans"
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"comparison-{time.time_ns()}.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"summary": summary, "privateReport": str(target), "humanReviewRequired": True}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--allow-paid", action="store_true", help="Authorize 80 DeepSeek turns plus at most one repair per turn")
    args = parser.parse_args()
    if not args.allow_paid:
        parser.error("Pass --allow-paid explicitly; this benchmark sends five synthetic case sessions to DeepSeek.")
    asyncio.run(evaluate())
