#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import copy
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

METHODS = [
    "social_work_default",
    "adaptive_vp",
    "consistent_mi",
    "patient_psi_context",
    "roleplay_doh",
    "annaagent_memory",
]


def load_session_smoke_module():
    path = ROOT / "scripts" / "session-smoke-test.py"
    spec = importlib.util.spec_from_file_location("session_smoke_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load session-smoke-test.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def main() -> None:
    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    module = load_session_smoke_module()
    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")
    coordinator = SocialWorkCoordinatorAgent(ROOT)
    summaries = []
    for method in METHODS:
        method_rows = []
        for case_type, turns in module.SESSION_PLANS.items():
            case_profile = module.load_case(case_type)
            session = coordinator.start_session({"caseProfile": copy.deepcopy(case_profile)})
            history = []
            for index, student_text in enumerate(turns[:2], start=1):
                history_with_student = [
                    *history,
                    {"speaker": "student", "text": student_text, "timestamp": "2026-06-15T00:00:00Z"},
                ]
                response = await coordinator.interview_turn(
                    {
                        "sessionId": session["sessionId"],
                        "caseProfile": copy.deepcopy(case_profile),
                        "studentText": student_text,
                        "history": history_with_student,
                        "simulationMethod": method,
                    }
                )
                if response.get("simulationMethod") != method:
                    raise RuntimeError(f"{method}/{case_type} round {index}: method was not preserved")
                if not response.get("simulationStrategySnapshot"):
                    raise RuntimeError(f"{method}/{case_type} round {index}: missing strategy snapshot")
                module.validate_turn(case_type, index, student_text, response)
                case_profile = module.apply_response(case_profile, response)
                history = [
                    *history_with_student,
                    {"speaker": "client", "text": response.get("clientText", ""), "timestamp": "2026-06-15T00:00:00Z"},
                ]
            method_rows.append({"caseType": case_type, "rounds": 2})
        summaries.append({"simulationMethod": method, "cases": method_rows})
    print(json.dumps({"ok": True, "methods": summaries}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
