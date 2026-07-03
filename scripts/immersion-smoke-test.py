#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import copy
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_case(case_type: str) -> dict[str, Any]:
    source = (ROOT / "src" / "lib" / "caseProfile.ts").read_text("utf-8")
    marker = f"caseType: '{case_type}'"
    start = source.find(marker)
    if start == -1:
        raise RuntimeError(f"Missing case type {case_type}")
    object_start = source.rfind("{", 0, start)
    depth = 0
    object_end = object_start
    for index in range(object_start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                object_end = index + 1
                break
    return ts_object_to_json(source[object_start:object_end])


def ts_object_to_json(snippet: str) -> dict[str, Any]:
    text = snippet.replace("'", '"').replace("undefined", "null")
    text = re.sub(r"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


async def main() -> None:
    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")

    coordinator = SocialWorkCoordinatorAgent(ROOT)
    case_profile = load_case("student_depression_bullying")
    session = coordinator.start_session({"caseProfile": copy.deepcopy(case_profile)})
    history: list[dict[str, Any]] = []
    prompts = [
        "你好。",
        "可以講多啲最近發生咩事嗎？",
        "哈哈哈哈。",
        "抱歉，我頭先處理得唔好。",
        "我想了解你最近最難受係咩。",
    ]
    rows: list[dict[str, Any]] = []
    tts_summary: dict[str, Any] | None = None

    for index, prompt in enumerate(prompts, start=1):
        started = time.perf_counter()
        response = await coordinator.interview_turn({
            "sessionId": session["sessionId"],
            "caseProfile": copy.deepcopy(case_profile),
            "studentText": prompt,
            "history": [*history, {"speaker": "student", "text": prompt}],
            "simulationMethod": "social_work_default",
            "responseLanguage": "cantonese",
        })
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        directive = response.get("avatarDirective") or {}
        plan = directive.get("performancePlan") or {}
        expression_plan = directive.get("expressionPlan") or {}
        if not plan.get("reactionInstanceId"):
            raise RuntimeError(f"Turn {index} missing performancePlan.reactionInstanceId.")
        if not expression_plan.get("templateId"):
            raise RuntimeError(f"Turn {index} missing expressionPlan.templateId.")
        rows.append({
            "turn": index,
            "studentText": prompt,
            "elapsedMs": elapsed_ms,
            "clientText": response.get("clientText", ""),
            "motionFamily": plan.get("reactionFamily"),
            "idleMixOnly": plan.get("idleMixOnly"),
            "motionEnergy": plan.get("motionEnergy"),
            "reactionReason": plan.get("reactionReason"),
            "expressionTemplate": expression_plan.get("templateId"),
            "mouthPolicy": expression_plan.get("mouthPolicy"),
            "riskSignals": response.get("riskSignals", []),
        })
        history.extend([
            {"speaker": "student", "text": prompt},
            {"speaker": "client", "text": response.get("clientText", ""), "revealedFacts": response.get("revealedFacts", [])},
        ])
        case_profile = coordinator.case_state.apply_response(case_profile, response)

        if index == 1:
            try:
                tts = coordinator.synthesize_tts({
                    "text": directive.get("ttsText") or response.get("clientText", ""),
                    "affect": response.get("affect"),
                    "voiceStyle": directive.get("voiceStyle"),
                    "language": "cantonese",
                })
                tts_summary = {
                    "provider": tts.get("provider"),
                    "voice": tts.get("voice"),
                    "voiceGender": tts.get("voiceGender"),
                    "lipSyncProvider": (tts.get("lipSync") or {}).get("provider"),
                    "lipSyncCueCount": len((tts.get("lipSync") or {}).get("mappedVisemes", [])),
                }
            except Exception as exc:
                tts_summary = {"provider": "unavailable", "error": str(exc)}

    if not any(row["idleMixOnly"] for row in rows[:2]):
        raise RuntimeError("Early neutral turns should include at least one idleMixOnly avatar plan.")
    if not any(row["reactionReason"] == "rupture" or row["motionFamily"] == "defensive" for row in rows):
        raise RuntimeError("Mocking turn should produce a defensive/rupture motion plan.")

    print(json.dumps({
        "ok": True,
        "sessionId": session["sessionId"],
        "turns": rows,
        "tts": tts_summary,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
