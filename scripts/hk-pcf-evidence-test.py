#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import build_hk_pcf_assessment, build_post_session_supervisor_prompt  # noqa: E402


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    short_trace = {
        "turns": [
            {
                "turnId": "turn-1",
                "studentText": "你好，可以講下最近點樣嗎？",
                "studentAnalysis": {"openQuestion": True},
                "riskSignals": [],
                "revealedFacts": [],
            },
            {
                "turnId": "turn-2",
                "studentText": "我聽到你好似唔係好想嚟。",
                "studentAnalysis": {"reflectiveListening": True},
                "riskSignals": [],
                "revealedFacts": [],
            },
            {
                "turnId": "turn-3",
                "studentText": "最近學校有咩令你唔舒服？",
                "studentAnalysis": {"openQuestion": True},
                "riskSignals": [],
                "revealedFacts": ["school_context"],
            },
        ]
    }
    assessment = build_hk_pcf_assessment({"caseType": "student_depression_bullying"}, short_trace)
    domains = assessment["domainAssessments"]
    expect(domains["engagementAndRelationship"]["status"] == "observed", "engagement should be observed")
    expect(domains["riskSafetyAndSafeguarding"]["status"] == "insufficient_evidence", "three-turn risk domain should be insufficient, not a fabricated mid score")
    expect(domains["riskSafetyAndSafeguarding"]["evidenceTurnIds"] == [], "risk domain must not cite nonexistent evidence")

    long_trace = {"turns": [*short_trace["turns"], {"turnId": "turn-4", "studentText": "你想由邊部分開始？", "studentAnalysis": {}, "riskSignals": [], "revealedFacts": []}]}
    long_assessment = build_hk_pcf_assessment({"caseType": "student_depression_bullying"}, long_trace)
    expect(long_assessment["domainAssessments"]["riskSafetyAndSafeguarding"]["status"] == "not_observed", "four-turn session should distinguish not observed from insufficient evidence")

    protected_prompt = build_post_session_supervisor_prompt({
        "caseProfile": {
            "caseType": "student_depression_bullying",
            "issueLabel": "學生抑鬱與欺凌",
            "simulatorStage": "presenting_issue",
            "hiddenFacts": [
                {"id": "known", "label": "午膳時獨處", "disclosed": True},
                {"id": "private", "label": "母親有表達關心", "disclosed": False},
            ],
            "riskProfile": {"protectiveFactors": ["母親有表達關心"]},
        },
        "responseLanguage": "cantonese",
        "trace": short_trace,
        "hkPcfAssessmentSeed": assessment,
    })
    expect("母親有表達關心" not in protected_prompt, "final review prompt must not contain undisclosed protective factors")
    expect("riskProfile" not in protected_prompt, "final review prompt must not serialize the private risk profile")
    expect("午膳時獨處" in protected_prompt, "final review prompt should retain client-confirmed facts")
    print("hk-pcf-evidence-test ok")


if __name__ == "__main__":
    main()
