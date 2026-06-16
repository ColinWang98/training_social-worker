#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

DEFAULT_METHODS = [
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


def parse_csv(value: str | None, default: list[str]) -> list[str]:
    if not value:
        return default
    return [item.strip() for item in value.split(",") if item.strip()]


async def main() -> None:
    parser = argparse.ArgumentParser(description="Run full session smoke benchmarks across simulation methods.")
    parser.add_argument("--methods", help="Comma-separated simulation methods. Defaults to all methods.")
    parser.add_argument("--cases", help="Comma-separated case types. Defaults to all smoke cases.")
    parser.add_argument("--out", help="Output JSON path. Defaults to data/benchmarks/methods.<timestamp>.json")
    args = parser.parse_args()

    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    smoke = load_session_smoke_module()
    methods = parse_csv(args.methods, DEFAULT_METHODS)
    cases = parse_csv(args.cases, list(smoke.SESSION_PLANS.keys()))
    unknown_cases = [case for case in cases if case not in smoke.SESSION_PLANS]
    if unknown_cases:
        raise SystemExit(f"Unknown cases: {unknown_cases}")

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")
    coordinator = SocialWorkCoordinatorAgent(ROOT)
    rows = []
    started = time.perf_counter()
    for method in methods:
        for case_type in cases:
            case_started = time.perf_counter()
            summary = await smoke.run_case(coordinator, case_type, method)
            summary["elapsedMs"] = round((time.perf_counter() - case_started) * 1000)
            rows.append(summary)

    report = {
        "ok": True,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "methods": methods,
        "cases": cases,
        "rows": rows,
    }
    out_path = Path(args.out) if args.out else ROOT / "data" / "benchmarks" / f"methods.{int(time.time())}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), "rows": len(rows)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
