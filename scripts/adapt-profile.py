#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "data" / "profiles"


def load_or_generate(case_type: str) -> dict:
    candidates = [
        PROFILE_DIR / f"{case_type}-case_spec_corpus.json",
        PROFILE_DIR / f"{case_type}-synthetic_interview.json",
    ]
    for path in candidates:
        if path.exists():
            return json.loads(path.read_text("utf-8"))
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate-profile.py"), "--from-case-spec", "--case", case_type],
        check=True,
    )
    return json.loads(candidates[0].read_text("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Adapt one grounding profile to another case type.")
    parser.add_argument("--case", required=True, help="Source case type")
    parser.add_argument("--target", required=True, help="Target case type")
    args = parser.parse_args()

    source = load_or_generate(args.case)
    target = load_or_generate(args.target)
    adapted = {
        **source,
        "profileId": f"{source.get('caseType')}-adapted-to-{target.get('caseType')}",
        "caseType": target.get("caseType"),
        "caseId": target.get("caseId"),
        "generationMode": "adapted_profile",
        "selfReportGrounding": target.get("selfReportGrounding"),
        "sourceEvidenceSummary": target.get("sourceEvidenceSummary"),
        "adaptationLog": [
            *source.get("adaptationLog", []),
            {
                "fromCaseType": source.get("caseType"),
                "toCaseType": target.get("caseType"),
                "changedFields": [
                    "caseType",
                    "caseId",
                    "selfReportGrounding",
                    "sourceEvidenceSummary",
                    "caseReflections",
                ],
                "note": "Adaptation preserves the source profile structure but swaps target case grounding and evidence summary.",
            },
        ],
        "caseReflections": target.get("caseReflections"),
    }

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    out_path = PROFILE_DIR / f"{args.case}-to-{args.target}.json"
    out_path.write_text(json.dumps(adapted, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), "profileId": adapted["profileId"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
