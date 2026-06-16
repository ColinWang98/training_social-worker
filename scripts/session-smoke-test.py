#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import copy
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STATE_KEYS = [
    "distressLevel",
    "stressLevel",
    "selfEsteem",
    "socialConnection",
    "academicPressure",
    "clientOpenness",
]

SESSION_PLANS: dict[str, list[str]] = {
    "student_depression_bullying": [
        "我知道你可能唔係自願嚟，我哋可以慢慢嚟。今日你可以選擇講幾多；老師叫你嚟，你自己點睇？",
        "聽落你唔想件事被講到好大。最近喺學校，有冇一個時刻係特別想避開人？",
        "如果講同學太快可以停。你想避開人嗰刻，比較似尷尬、驚、嬲，定係覺得自己好冇用？",
        "我做一個安全確認：最難頂嗰陣，有冇試過覺得自己唔安全，或者唔想醒返？",
        "今日先唔逼你講晒。我哋可唔可以約下一次，慢慢諗點樣安全同低調咁處理學校嗰邊？",
    ],
    "alcohol_misuse": [
        "我唔會一開始叫你戒酒。你自己點睇醫生話你飲酒偏多？",
        "聽落酒係幫你頂住工作壓力。邊啲晚上最容易飲多？",
        "一方面你覺得未至於失控，另一方面醫生有啲擔心。你有冇試過第二朝覺得情緒或者身體更差？",
        "如果唔講戒酒，只講一個細改變，你覺得有冇可能試下減少屋企存酒？",
    ],
    "anxiety_family_invalidated": [
        "你唔需要證明自己好嚴重。焦慮嚟嗰陣，身體最明顯係邊度唔舒服？",
        "聽落身體反應真係好強。通常發作前一刻，屋企有冇發生咩事？",
        "家人話你諗多咗嗰陣，你會唔會覺得自己好麻煩？",
        "如果搵支援，你最擔心係家人反對，定係怕拖累身邊人？",
    ],
    "substance_recovery_meth": [
        "我唔會要求你即刻保證停到。你最怕嘅係被人睇低，定係戒斷頂唔住？",
        "聽落你唔係唔想改，而係以前失敗過。最容易令你返轉頭係咩時候？",
        "我唔問具體用法。只想了解安全：如果減少或停，最擔心身體或情緒有咩反應？",
        "如果自己硬頂未必安全，聽到醫療或戒毒支援，你會覺得有希望定更驚？",
    ],
    "trauma_sleep_low_self_worth": [
        "今日唔需要講任何細節。可以只由睡眠開始：最辛苦係入睡、半夜醒，定係醒咗好攰？",
        "睡眠係比較安全嘅入口。瞓唔到嗰陣，個腦係空白、好亂，定係會責怪自己？",
        "你講到問題太多，好難攤開。你最驚我哋傾落去會發生咩？",
        "我尊重你唔講細節。只想知道，最難嗰晚你點樣令自己撐過去？",
    ],
}


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
    return ts_object_to_json(source[object_start:object_end])


def ts_object_to_json(snippet: str) -> dict:
    text = snippet.replace("'", '"').replace("undefined", "null")
    text = re.sub(r"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def apply_response(case_profile: dict, response: dict) -> dict:
    next_case = copy.deepcopy(case_profile)
    state = next_case.get("psychologicalState", {})
    for key in STATE_KEYS:
        delta = response.get("stateDelta", {}).get(key)
        if isinstance(delta, (int, float)) and isinstance(state.get(key), (int, float)):
            max_value = 4 if key == "distressLevel" else 10
            state[key] = min(max_value, max(0, round((state[key] + delta) * 10) / 10))
    if response.get("affect") and response["affect"] != "neutral":
        state["emotion"] = response["affect"]
    revealed = {str(item).lower() for item in response.get("revealedFacts", [])}
    for fact in next_case.get("hiddenFacts", []):
        if str(fact.get("id", "")).lower() in revealed or str(fact.get("label", "")).lower() in revealed:
            fact["disclosed"] = True
    return next_case


async def run_case(coordinator, case_type: str, simulation_method: str | None = None) -> dict:
    case_profile = load_case(case_type)
    session = coordinator.start_session({"caseProfile": copy.deepcopy(case_profile)})
    history: list[dict] = []
    rows = []
    start_openness = case_profile.get("psychologicalState", {}).get("clientOpenness", 0)

    for index, student_text in enumerate(SESSION_PLANS[case_type], start=1):
        history_with_student = [
            *history,
            {"speaker": "student", "text": student_text, "timestamp": "2026-06-15T00:00:00Z"},
        ]
        started = time.perf_counter()
        response = await coordinator.interview_turn(
            {
                "sessionId": session["sessionId"],
                "caseProfile": copy.deepcopy(case_profile),
                "studentText": student_text,
                "history": history_with_student,
                "simulationMethod": simulation_method or "social_work_default",
            }
        )
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        validate_turn(case_type, index, student_text, response)
        case_profile = apply_response(case_profile, response)
        history = [
            *history_with_student,
            {
                "speaker": "client",
                "text": response.get("clientText", ""),
                "timestamp": "2026-06-15T00:00:00Z",
                "revealedFacts": response.get("revealedFacts", []),
            },
        ]
        rows.append(
            {
                "round": index,
                "elapsedMs": elapsed_ms,
                "clientText": response.get("clientText"),
                "resistance": response.get("resistanceLevel"),
                "affect": response.get("affect"),
                "openness": case_profile.get("psychologicalState", {}).get("clientOpenness"),
                "riskSignals": response.get("riskSignals", []),
                "revealedFacts": response.get("revealedFacts", []),
                "realismScore": (response.get("realismAssessment") or {}).get("realismScore"),
                "repairApplied": bool((response.get("realismAssessment") or {}).get("repairApplied")),
                "motionCue": (response.get("avatarDirective") or {}).get("motionCue"),
                "clipId": ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("reactionClipId")
                or ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("baselineClipId"),
                "baselineIdleClipId": ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("baselineIdleClipId"),
                "reactionInstanceId": ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("reactionInstanceId"),
                "playbackMask": ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("playbackMask"),
                "clipSource": ((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("clipSource"),
                "fallbackUsed": bool(((response.get("avatarDirective") or {}).get("performancePlan") or {}).get("fallbackUsed")),
                "simulationMethod": response.get("simulationMethod"),
            }
        )

    final_openness = case_profile.get("psychologicalState", {}).get("clientOpenness", 0)
    if final_openness == start_openness:
        raise RuntimeError(f"{case_type}: openness did not change across the session")

    return {
        "caseType": case_type,
        "simulationMethod": simulation_method or "social_work_default",
        "sessionId": session["sessionId"],
        "startOpenness": start_openness,
        "finalOpenness": final_openness,
        "disclosedFacts": [fact["id"] for fact in case_profile.get("hiddenFacts", []) if fact.get("disclosed")],
        "rows": rows,
    }


def validate_turn(case_type: str, index: int, student_text: str, response: dict) -> None:
    required = ["clientText", "affect", "riskSignals", "revealedFacts", "stateDelta", "motionCue", "agentTraceId"]
    missing = [key for key in required if key not in response]
    if missing:
        raise RuntimeError(f"{case_type} round {index}: missing response keys {missing}")
    directive = response.get("avatarDirective") or {}
    if not directive.get("basis"):
        raise RuntimeError(f"{case_type} round {index}: avatarDirective.basis is required")
    if not isinstance(directive.get("intensity"), (int, float)):
        raise RuntimeError(f"{case_type} round {index}: avatar intensity must be numeric")
    if response.get("sessionContinuitySnapshot") is None:
        raise RuntimeError(f"{case_type} round {index}: sessionContinuitySnapshot is required")
    if response.get("simulationMethod") is None:
        raise RuntimeError(f"{case_type} round {index}: simulationMethod is required")
    if response.get("simulationStrategySnapshot") is None:
        raise RuntimeError(f"{case_type} round {index}: simulationStrategySnapshot is required")
    performance_plan = directive.get("performancePlan") or {}
    if performance_plan.get("playbackMask") != "upper_body":
        raise RuntimeError(f"{case_type} round {index}: performancePlan.playbackMask must be upper_body")
    if performance_plan.get("seatedRuntime") is not True:
        raise RuntimeError(f"{case_type} round {index}: performancePlan.seatedRuntime must be true")
    if not (performance_plan.get("reactionClipId") or performance_plan.get("baselineClipId")):
        raise RuntimeError(f"{case_type} round {index}: performancePlan must include a clip id")
    if not isinstance(performance_plan.get("reactionInstanceId"), str):
        raise RuntimeError(f"{case_type} round {index}: performancePlan.reactionInstanceId must be a string")
    if not isinstance(performance_plan.get("baselineIdleClipId"), str):
        raise RuntimeError(f"{case_type} round {index}: performancePlan.baselineIdleClipId must be a string")
    if not isinstance(performance_plan.get("reactionDurationMs"), (int, float)):
        raise RuntimeError(f"{case_type} round {index}: performancePlan.reactionDurationMs must be numeric")
    if not isinstance(performance_plan.get("releaseMs"), (int, float)):
        raise RuntimeError(f"{case_type} round {index}: performancePlan.releaseMs must be numeric")
    asked_passive_risk = "唔想醒返" in student_text or "唔使醒" in student_text
    client_text = response.get("clientText", "")
    risk_evidence = f"{client_text} {' '.join(str(item) for item in response.get('revealedFacts', []))}"
    if asked_passive_risk and "passive_self_harm_language" in response.get("riskSignals", []):
        if not re.search(
            r"唔想醒|唔使醒|醒返|唔喺度|唔存在|消失|冇咁辛苦|死咗|死左|不想活|自殺|自杀|傷害自己|伤害自己|not wake|kill myself|suicid|passive-risk",
            risk_evidence,
            re.I,
        ):
            raise RuntimeError(f"{case_type} round {index}: risk inquiry was treated as client disclosure")
    high_risk_signals = {"passive_self_harm_language", "substance_withdrawal", "violence_risk", "safety_review_repaired"}
    if set(response.get("riskSignals", [])) & high_risk_signals and not any(
        item.get("ruleId") == "safety_low_intensity"
        for item in directive.get("basis", [])
    ):
        raise RuntimeError(f"{case_type} round {index}: risk response missing safety_low_intensity basis")


async def main() -> None:
    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")

    coordinator = SocialWorkCoordinatorAgent(ROOT)
    summaries = []
    for case_type in SESSION_PLANS:
        summaries.append(await run_case(coordinator, case_type))
    print(json.dumps({"ok": True, "simulationMethod": "social_work_default", "cases": summaries}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
