#!/usr/bin/env python3
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import context_expression_policy


def run_case(name, *, response=None, student_analysis=None, risk_signals=None, affect="neutral", intensity=0.7, basis=None):
    performance_plan = {}
    result = context_expression_policy(
        response=response or {},
        case_profile={"caseType": "student_depression_bullying", "avatarBaseline": {"baselineMood": "withdrawn"}},
        student_analysis=student_analysis or {},
        risk_signals=risk_signals or [],
        affect=affect,
        intensity=intensity,
        basis=basis or [],
        performance_plan=performance_plan,
    )
    plan = result["plan"]
    if result["basis"].get("sourceType") != "expression_rule":
        raise AssertionError(f"{name}: basis sourceType must be expression_rule")
    if not plan.get("templateId"):
        raise AssertionError(f"{name}: expression plan must include templateId")
    if not performance_plan.get("expressionTimeline"):
        raise AssertionError(f"{name}: performance plan must receive expressionTimeline")
    return plan


def assert_template(name, expected, **kwargs):
    plan = run_case(name, **kwargs)
    actual = plan["templateId"]
    if actual != expected:
        raise AssertionError(f"{name}: expected {expected}, got {actual}")
    return plan


def main():
    risk_plan = assert_template(
        "risk",
        "risk_low_intensity",
        risk_signals=["passive_self_harm_language"],
        affect="withdrawn",
        intensity=0.9,
    )
    if risk_plan["mouthPolicy"] != "risk_suppressed" or risk_plan["intensity"] > 0.5:
        raise AssertionError("risk: must suppress mouth and cap intensity")

    assert_template(
        "mocking",
        "defensive_micro",
        student_analysis={"mockingOrDismissive": True},
        affect="irritated",
    )
    assert_template(
        "apology",
        "guarded_repair",
        student_analysis={"apologyRepair": True},
        affect="defensive",
    )
    assert_template(
        "reflective",
        "reflective_soft",
        response={"changeTalk": ["想試下少啲"]},
        affect="reflective",
    )
    assert_template("neutral", "neutral_listening", affect="neutral", intensity=0.4)
    print("Validated context expression policy templates.")


if __name__ == "__main__":
    main()
