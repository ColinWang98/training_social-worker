#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import (
    StudentMoveAnalyzerAgent,
    build_session_continuity,
    build_disclosure_ledger,
    client_disclosed_risk_signals,
    progression_snapshot,
    safe_repair_text,
    score_client_realism,
    semantic_repeat_risk,
    semantic_response_fingerprint,
)


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_student_move_analyzer() -> None:
    analyzer = StudentMoveAnalyzerAgent()

    empathy = analyzer.run("我能理解你")
    expect(empathy["genericEmpathy"], "我能理解你 should be tagged as genericEmpathy.")
    expect(empathy["reflectiveListening"], "我能理解你 should be treated as reflective-lite.")

    doubt = analyzer.run("不会吧")
    expect(doubt["doubtOrInvalidating"], "不会吧 should be tagged as doubtOrInvalidating.")
    expect(not doubt["minimalBackchannel"], "不会吧 should not be treated as a neutral backchannel.")


def test_semantic_repeat_detection() -> None:
    previous = "嗯…其實都冇咩嘅，可能老師講得誇張咗啲啫。"
    current = "吓…其實都冇咩嘅，可能老師講到太嚴重啫。"
    case_type = "student_depression_bullying"

    expect(
        semantic_response_fingerprint(previous, case_type) == "minimize_referrer_overreacted",
        "previous response should map to minimize_referrer_overreacted.",
    )
    expect(
        semantic_response_fingerprint(current, case_type) == "minimize_referrer_overreacted",
        "current response should map to minimize_referrer_overreacted.",
    )
    expect(
        semantic_repeat_risk(current, [previous], case_type),
        "same defensive meaning with light paraphrase should trigger semanticRepeatRisk.",
    )

    payload = {
        "responseLanguage": "cantonese",
        "caseProfile": {
            "caseType": case_type,
            "psychologicalState": {"clientOpenness": 2},
            "socialWorkContextModel": {"coreBeliefs": [], "disclosureRules": []},
        },
        "studentAnalysis": {"genericEmpathy": True, "reflectiveListening": True},
        "adaptivePolicy": {"progressionStage": "presenting_issue", "progressionSignals": []},
        "history": [
            {"speaker": "student", "text": "你好"},
            {"speaker": "client", "text": previous},
            {"speaker": "student", "text": "我能理解你"},
        ],
    }
    response = {
        "clientText": current,
        "affect": "withdrawn",
        "resistanceLevel": "moderate",
        "riskSignals": [],
        "revealedFacts": [],
        "changeTalk": [],
        "stateDelta": {"clientOpenness": 0.1},
        "motionCue": "avoid_eye_contact",
    }
    realism = score_client_realism(payload, response)
    expect(realism["semanticRepeatRisk"], "score_client_realism should expose semanticRepeatRisk.")
    expect(realism["semanticFingerprint"] == "minimize_referrer_overreacted", "semantic fingerprint should be retained for debug.")


def test_single_session_progression() -> None:
    analyzer = StudentMoveAnalyzerAgent()
    case_profile = {
        "caseType": "student_depression_bullying",
        "psychologicalState": {"clientOpenness": 2},
        "issueProgressionChain": [
            {
                "stage": "initial_contact",
                "allowedDisclosureDepth": 1,
                "surfaceCues": ["referral concern"],
                "transitionSignals": ["genericEmpathy"],
                "pauseSignals": ["doubtOrInvalidating"],
                "nextAffordance": "Ask how the client understands the referral.",
            },
            {
                "stage": "presenting_issue",
                "allowedDisclosureDepth": 1,
                "surfaceCues": ["school scene"],
                "transitionSignals": ["openQuestion"],
                "pauseSignals": ["mockingOrDismissive"],
                "nextAffordance": "Ask about one recent school moment.",
            },
        ],
        "socialWorkContextModel": {"shameTriggers": ["被質疑"]},
    }

    empathy_policy = progression_snapshot(case_profile, analyzer.run("我能理解你"), {})
    expect(empathy_policy["progressionStage"] == "presenting_issue", "generic empathy should move from initial contact to presenting issue.")
    expect(empathy_policy["requiredFollowUpAffordance"], "progression should expose a required follow-up affordance.")

    prior_events = [
        {
            "payload": {
                "studentAnalysis": analyzer.run("你好"),
                "adaptivePolicy": {"progressionStage": "presenting_issue", "issueStageReason": "test transition"},
                "clientResponse": {"clientText": "我唔係好想講學校啲嘢。", "stateDelta": {"clientOpenness": 0.2}},
            }
        }
    ]
    continuity = build_session_continuity(case_profile, [], prior_events)
    expect(continuity["currentIssueStage"] == "presenting_issue", "continuity should retain current issue stage within the session.")
    expect(continuity["recentSemanticFingerprints"], "continuity should retain recent semantic fingerprints.")
    expect(continuity["stageTransitionHistory"], "continuity should record stage transition history.")

    doubt_policy = progression_snapshot(case_profile, analyzer.run("不会吧"), continuity)
    expect(doubt_policy["progressionStage"] == "presenting_issue", "invalidating turn should pause rather than reset issue stage.")
    expect(doubt_policy["progressionPaused"], "invalidating turn should pause progression.")
    expect(doubt_policy["progressionPausedReason"], "paused progression should expose a reason for instructor debug.")


def test_disclosure_ledger() -> None:
    case_profile = {
        "hiddenFacts": [
            {"id": "school_scene", "label": "午饭时独自坐", "disclosed": False},
            {"id": "sleep", "label": "睡眠受影响", "disclosed": True},
        ]
    }
    ledger = build_disclosure_ledger(case_profile, {
        "revealedFacts": ["school_scene", "sleep"],
        "riskSignals": ["passive_self_harm_language"],
    })
    by_id = {entry["id"]: entry for entry in ledger}
    expect(by_id["referral_context"]["kind"] == "referral_known", "referral context must not be counted as newly disclosed")
    expect(by_id["school_scene"]["kind"] == "newly_disclosed", "first hidden fact disclosure must be new")
    expect(by_id["sleep"]["kind"] == "client_confirmed", "already disclosed fact must be confirmation")
    expect(not by_id["risk:passive_self_harm_language"]["traineeVisible"], "risk ledger details must remain hidden from trainee")


def test_safety_repair_stays_in_client_voice() -> None:
    text = safe_repair_text({"caseType": "alcohol_misuse"}, {}, "cantonese")
    expect("你可以" not in text and "問我" not in text, "safety repair must not coach the trainee from the client voice")
    expect("唔知可以同邊個講" in text, "safety repair should leave a natural support affordance")

    signals = client_disclosed_risk_signals({
        "clientText": "夜晚一個人嗰陣，我會覺得心口好緊。",
        "riskSignals": ["social_withdrawal"],
        "revealedFacts": [],
    }, "anxiety_family_invalidated")
    expect("social_withdrawal" not in signals, "being alone at a time or place is not by itself social withdrawal")


def main() -> None:
    test_student_move_analyzer()
    test_semantic_repeat_detection()
    test_single_session_progression()
    test_disclosure_ledger()
    test_safety_repair_stays_in_client_voice()
    print("client-detemplate-test ok")


if __name__ == "__main__":
    main()
