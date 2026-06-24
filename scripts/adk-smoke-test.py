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


def load_case(case_type: str) -> dict:
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
    snippet = source[object_start:object_end]
    return ts_object_to_json(snippet)


def ts_object_to_json(snippet: str) -> dict:
    text = snippet
    text = text.replace("'", '"')
    text = text.replace("undefined", "null")
    text = text.replace("true", "true").replace("false", "false")
    text = reformat_keys(text)
    text = remove_trailing_commas(text)
    return json.loads(text)


def reformat_keys(text: str) -> str:
    import re

    return re.sub(r"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', text)


def remove_trailing_commas(text: str) -> str:
    import re

    return re.sub(r",(\s*[}\]])", r"\1", text)


async def main() -> None:
    if importlib.util.find_spec("fastapi") is None:
        print("fastapi not installed; testing coordinator runtime without HTTP app.")

    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")

    coordinator = SocialWorkCoordinatorAgent(ROOT)
    case_profile = load_case("student_depression_bullying")
    session = coordinator.start_session({"caseProfile": copy.deepcopy(case_profile)})
    response = await coordinator.interview_turn(
        {
            "sessionId": session["sessionId"],
            "caseProfile": copy.deepcopy(case_profile),
            "studentText": "你願唔願意講下最近最辛苦係邊一刻？有冇試過覺得自己唔安全？",
            "history": [
                {
                    "speaker": "student",
                    "text": "你願唔願意講下最近最辛苦係邊一刻？有冇試過覺得自己唔安全？",
                    "timestamp": "2026-06-13T00:00:00Z",
                }
            ],
            "simulationMethod": "social_work_default",
        }
    )
    required = ["clientText", "affect", "riskSignals", "revealedFacts", "stateDelta", "motionCue", "agentTraceId"]
    missing = [key for key in required if key not in response]
    if missing:
        raise RuntimeError(f"Missing response keys: {missing}")
    if response["motionCue"] not in {"neutral", "look_down", "avoid_eye_contact", "rub_hands", "lean_back", "slow_nod"}:
        raise RuntimeError(f"Unexpected motionCue: {response['motionCue']}")
    if response.get("simulationMethod") != "social_work_default":
        raise RuntimeError("simulationMethod must default to social_work_default.")
    if not response.get("simulationStrategySnapshot"):
        raise RuntimeError("simulationStrategySnapshot is required.")
    directive = response.get("avatarDirective") or {}
    basis = directive.get("basis") or []
    if not basis:
        raise RuntimeError("avatarDirective.basis must include at least one policy rule.")
    expression_plan = directive.get("expressionPlan") or {}
    if not expression_plan.get("templateId"):
        raise RuntimeError("avatarDirective.expressionPlan.templateId is required.")
    if not any(item.get("sourceType") == "expression_rule" for item in basis):
        raise RuntimeError("avatarDirective.basis must include an expression_rule entry.")
    if not isinstance(directive.get("intensity"), (int, float)):
        raise RuntimeError("avatarDirective.intensity must be numeric.")
    if not isinstance(directive.get("transitionMs"), (int, float)):
        raise RuntimeError("avatarDirective.transitionMs must be numeric.")
    if not isinstance(directive.get("holdMs"), (int, float)):
        raise RuntimeError("avatarDirective.holdMs must be numeric.")
    if directive.get("priority") not in {"safety", "reaction", "speaking", "idle"}:
        raise RuntimeError("avatarDirective.priority must be a known priority.")
    realism = response.get("realismAssessment") or {}
    if not isinstance(realism.get("realismScore"), (int, float)):
        raise RuntimeError("realismAssessment.realismScore must be numeric.")
    if not isinstance(realism.get("matchedRealismAnchors"), list):
        raise RuntimeError("realismAssessment.matchedRealismAnchors must be a list.")
    high_risk_signals = {"passive_self_harm_language", "substance_withdrawal", "violence_risk", "safety_review_repaired"}
    if set(response["riskSignals"]) & high_risk_signals and not any(item.get("ruleId") == "safety_low_intensity" for item in basis):
        raise RuntimeError("Risk responses must include safety_low_intensity basis.")
    performance_plan = directive.get("performancePlan") or {}
    if performance_plan.get("playbackMask") != "upper_body":
        raise RuntimeError("avatarDirective.performancePlan.playbackMask must be upper_body.")
    if performance_plan.get("seatedRuntime") is not True:
        raise RuntimeError("avatarDirective.performancePlan.seatedRuntime must be true.")
    if not isinstance(performance_plan.get("reactionInstanceId"), str):
        raise RuntimeError("avatarDirective.performancePlan.reactionInstanceId must be a string.")
    if not isinstance(performance_plan.get("baselineIdleClipId"), str):
        raise RuntimeError("avatarDirective.performancePlan.baselineIdleClipId must be a string.")
    if not isinstance(performance_plan.get("reactionDurationMs"), (int, float)):
        raise RuntimeError("avatarDirective.performancePlan.reactionDurationMs must be numeric.")
    if not isinstance(performance_plan.get("releaseMs"), (int, float)):
        raise RuntimeError("avatarDirective.performancePlan.releaseMs must be numeric.")
    final_history = [
        {
            "id": "student-smoke",
            "speaker": "student",
            "text": "你願唔願意講下最近最辛苦係邊一刻？有冇試過覺得自己唔安全？",
            "timestamp": "2026-06-13T00:00:00Z",
        },
        {
            "id": "client-smoke",
            "speaker": "client",
            "text": response["clientText"],
            "timestamp": "2026-06-13T00:01:00Z",
            "revealedFacts": response.get("revealedFacts", []),
        },
    ]
    final_report = await coordinator.final_review(
        {
            "sessionId": session["sessionId"],
            "caseProfile": copy.deepcopy(case_profile),
            "history": final_history,
        }
    )
    if not isinstance(final_report.get("overallSummary"), str):
        raise RuntimeError("final-review overallSummary is required.")
    if not isinstance(final_report.get("competencyScores", {}).get("engagement"), (int, float)):
        raise RuntimeError("final-review competencyScores.engagement must be numeric.")
    if not isinstance(final_report.get("processReview", {}).get("turningPoints"), list):
        raise RuntimeError("final-review processReview.turningPoints must be a list.")
    hk_pcf = final_report.get("hkPcfAssessment") or {}
    hk_scores = hk_pcf.get("scores") or {}
    if not isinstance(hk_scores.get("engagementAndRelationship"), (int, float)):
        raise RuntimeError("final-review hkPcfAssessment.scores.engagementAndRelationship must be numeric.")
    if not isinstance(hk_scores.get("riskSafetyAndSafeguarding"), (int, float)):
        raise RuntimeError("final-review hkPcfAssessment.scores.riskSafetyAndSafeguarding must be numeric.")
    if not isinstance(hk_pcf.get("disclaimer"), str) or "SWRB" not in hk_pcf.get("disclaimer", ""):
        raise RuntimeError("final-review hkPcfAssessment.disclaimer must state SWRB limitation.")
    print(
        json.dumps(
            {
                "ok": True,
                "sessionId": session["sessionId"],
                "adkAvailable": coordinator.health()["adkAvailable"],
                "deepSeekEnabled": coordinator.health()["deepSeekEnabled"],
                "evidenceCardCount": coordinator.health()["evidenceCardCount"],
                "affect": response["affect"],
                "motionCue": response["motionCue"],
                "intensity": directive.get("intensity"),
                "transitionMs": directive.get("transitionMs"),
                "holdMs": directive.get("holdMs"),
                "priority": directive.get("priority"),
                "clipId": performance_plan.get("reactionClipId") or performance_plan.get("baselineClipId"),
                "playbackMask": performance_plan.get("playbackMask"),
                "clipSource": performance_plan.get("clipSource"),
                "fallbackUsed": performance_plan.get("fallbackUsed"),
                "basisRules": [item.get("ruleId") for item in basis],
                "realismScore": realism.get("realismScore"),
                "realismAnchors": realism.get("matchedRealismAnchors", []),
                "riskSignals": response["riskSignals"],
                "safetyFlags": response.get("safetyFlags", []),
                "finalReview": {
                    "overallSummary": final_report.get("overallSummary"),
                    "engagement": final_report.get("competencyScores", {}).get("engagement"),
                    "hkPcfEngagement": hk_scores.get("engagementAndRelationship"),
                    "hkPcfRiskSafety": hk_scores.get("riskSafetyAndSafeguarding"),
                    "turningPoints": len(final_report.get("processReview", {}).get("turningPoints", [])),
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
