#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import statistics
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
REPORT_DIR = ROOT / "data" / "evaluations"


def load_session_smoke_module():
    path = ROOT / "scripts" / "session-smoke-test.py"
    spec = importlib.util.spec_from_file_location("session_smoke_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load session-smoke-test.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def score_rows(case_summary: dict[str, Any]) -> dict[str, Any]:
    rows = case_summary.get("rows", [])
    realism_values = [row.get("realismScore") for row in rows if isinstance(row.get("realismScore"), (int, float))]
    reaction_ids = [row.get("reactionInstanceId") for row in rows if row.get("reactionInstanceId")]
    disclosed = case_summary.get("disclosedFacts", [])
    start_openness = case_summary.get("startOpenness", 0)
    final_openness = case_summary.get("finalOpenness", 0)
    risk_rows = [row for row in rows if row.get("riskSignals")]
    bad_schema = [index for index, row in enumerate(rows, start=1) if not row.get("clientText") or not row.get("motionCue")]

    schema = 10 if not bad_schema else max(0, 10 - len(bad_schema) * 2)
    realism = statistics.mean(realism_values) if realism_values else 6.5
    continuity = 8.0
    if final_openness == start_openness:
        continuity -= 2.5
    if len(set(reaction_ids)) != len(reaction_ids):
        continuity -= 1.5
    disclosure = 8.0
    if rows and rows[0].get("revealedFacts"):
        disclosure -= 2.0
    if len(disclosed) > max(1, len(rows) // 2 + 1):
        disclosure -= 1.0
    risk = 8.5
    for row in risk_rows:
        if "safety_review_repaired" in row.get("riskSignals", []):
            risk -= 0.5
    avatar = 9.0 if all(row.get("motionCue") and row.get("reactionInstanceId") for row in rows) else 6.0
    corpus = 7.0
    interview_quality = 7.0
    if any(row.get("resistance") == "high" for row in rows) and final_openness > start_openness:
        interview_quality += 0.5
    context = min(10.0, realism + 0.4)
    overall = statistics.mean([schema, realism, continuity, disclosure, risk, avatar, corpus, interview_quality, context])

    return {
        "caseType": case_summary.get("caseType"),
        "schemaValidity": round(schema, 1),
        "clientRealism": round(realism, 1),
        "contextConsistency": round(context, 1),
        "disclosurePacing": round(disclosure, 1),
        "sessionContinuity": round(max(0, continuity), 1),
        "riskGating": round(max(0, risk), 1),
        "socialWorkInterviewQuality": round(min(10, interview_quality), 1),
        "avatarAlignment": round(avatar, 1),
        "corpusGrounding": round(corpus, 1),
        "overallReadiness": round(overall, 1),
        "notes": [
            f"rounds={len(rows)}",
            f"openness={start_openness}->{final_openness}",
            f"disclosedFacts={len(disclosed)}",
            f"riskRows={len(risk_rows)}",
        ],
    }


async def run_live_smoke(method: str | None) -> dict[str, Any]:
    module = load_session_smoke_module()
    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")
    coordinator = SocialWorkCoordinatorAgent(ROOT)
    cases = []
    for case_type in module.SESSION_PLANS:
        cases.append(await module.run_case(coordinator, case_type, simulation_method=method))
    return {"ok": True, "simulationMethod": method or "social_work_default", "cases": cases}


def render_markdown(report: dict[str, Any]) -> str:
    rows = report.get("cases", [])
    lines = [
        "# Session Evaluation Report",
        "",
        f"Simulation method: {report.get('simulationMethod', 'mixed')}",
        "",
        "| Case | Overall | Realism | Continuity | Disclosure | Risk | Avatar |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for row in rows:
        lines.append(
            f"| {row['caseType']} | {row['overallReadiness']} | {row['clientRealism']} | "
            f"{row['sessionContinuity']} | {row['disclosurePacing']} | {row['riskGating']} | {row['avatarAlignment']} |"
        )
    lines.extend(["", "## Notes"])
    for row in rows:
        lines.append(f"- {row['caseType']}: {', '.join(row['notes'])}")
    return "\n".join(lines) + "\n"


async def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate simulator sessions with deterministic layered evaluators.")
    parser.add_argument("--input", help="Path to a session smoke JSON summary.")
    parser.add_argument("--method", help="Optional simulation method for live smoke evaluation.")
    parser.add_argument("--no-write", action="store_true", help="Print only; do not write data/evaluations reports.")
    args = parser.parse_args()

    if args.input:
        source = json.loads(Path(args.input).read_text("utf-8"))
    else:
        source = await run_live_smoke(args.method)

    report = {
        "ok": True,
        "simulationMethod": source.get("simulationMethod", args.method or "social_work_default"),
        "cases": [score_rows(case) for case in source.get("cases", [])],
    }
    report["overallReadiness"] = round(statistics.mean([case["overallReadiness"] for case in report["cases"]]), 1) if report["cases"] else 0
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if not args.no_write:
        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        (REPORT_DIR / "session-evaluation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
        (REPORT_DIR / "session-evaluation.md").write_text(render_markdown(report), "utf-8")


if __name__ == "__main__":
    asyncio.run(main())
