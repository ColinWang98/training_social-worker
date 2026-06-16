#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILE_DIR = ROOT / "data" / "profiles"
METHOD_ADAPTATIONS = {
    "adaptive_vp": {
        "focus": "trainee-driven response boundaries",
        "notes": [
            "學生每一句話術都應影響本輪阻抗、信任修復或透露上限。",
            "嘲笑、評判、過早建議要優先反映在微觀關係破裂。",
        ],
    },
    "consistent_mi": {
        "focus": "MI resistance/change talk transition",
        "notes": [
            "保留 sustain talk 和 ambivalence；change talk 只可由反映、矛盾探索或低壓力選擇逐步出現。",
            "酒精/藥物個案優先使用動機式訪談脈絡。",
        ],
    },
    "patient_psi_context": {
        "focus": "cognitive/context grounding",
        "notes": [
            "回應需嚴格貼合核心信念、自我敘事、羞恥觸發和求助阻抗。",
            "Person-in-Environment / micro-meso-macro context 是主要 grounding。",
        ],
    },
    "roleplay_doh": {
        "focus": "natural roleplay fidelity",
        "notes": [
            "避免完整、理性、教科書式自述；保持短句、停頓、情緒殘留。",
            "只讓服務對象說自己此刻可承受的內容。",
        ],
    },
    "annaagent_memory": {
        "focus": "session continuity and relationship memory",
        "notes": [
            "關係破裂、修復、已透露資訊和避開話題必須跨輪延續。",
            "道歉不可令信任立刻完全回復。",
        ],
    },
}


def load_or_generate(case_type: str) -> dict:
    candidates = [
        PROFILE_DIR / case_type / "active.json",
        PROFILE_DIR / case_type / f"{case_type}-case_spec_corpus.json",
        PROFILE_DIR / case_type / f"{case_type}-synthetic_interview.json",
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


def adapt_to_method(source: dict, method: str) -> dict:
    spec = METHOD_ADAPTATIONS.get(method)
    if not spec:
        raise SystemExit(f"Unsupported method: {method}")
    adapted = json.loads(json.dumps(source, ensure_ascii=False))
    adapted["profileId"] = f"{source.get('caseType')}-{method}-adapted"
    adapted["generationMode"] = f"method_adapted:{method}"
    adapted["simulationMethodFit"] = {
        "method": method,
        "focus": spec["focus"],
        "notes": spec["notes"],
    }
    reflections = adapted.setdefault("caseReflections", {})
    reflections.setdefault("strategyFit", [])
    reflections["strategyFit"] = [*reflections.get("strategyFit", []), *spec["notes"]]
    pie = adapted.setdefault("personInEnvironment", {})
    pie.setdefault("fitTensions", [])
    pie["fitTensions"] = [*pie.get("fitTensions", []), f"Simulation method {method}: {spec['focus']}"]
    adapted["adaptationLog"] = [
        *source.get("adaptationLog", []),
        {
            "type": "method_adaptation",
            "method": method,
            "changedFields": ["simulationMethodFit", "caseReflections.strategyFit", "personInEnvironment.fitTensions"],
            "note": "Adapted profile emphasis for instructor-selected simulation method; original case grounding is preserved.",
        },
    ]
    return adapted


def main() -> None:
    parser = argparse.ArgumentParser(description="Adapt grounding profiles across case types or simulation methods.")
    parser.add_argument("--case", required=True, help="Source case type")
    parser.add_argument("--target", help="Target case type for cross-case adaptation")
    parser.add_argument("--method", choices=sorted(METHOD_ADAPTATIONS.keys()), help="Simulation method to emphasize")
    args = parser.parse_args()
    if not args.target and not args.method:
        raise SystemExit("Use --target for cross-case adaptation or --method for method adaptation.")
    if args.target and args.method:
        raise SystemExit("Use only one of --target or --method.")

    source = load_or_generate(args.case)
    if args.method:
        adapted = adapt_to_method(source, args.method)
        out_dir = PROFILE_DIR / str(source.get("caseType"))
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{source.get('caseType')}-{args.method}-adapted.json"
        out_path.write_text(json.dumps(adapted, ensure_ascii=False, indent=2) + "\n", "utf-8")
        print(json.dumps({"ok": True, "path": str(out_path), "profileId": adapted["profileId"]}, ensure_ascii=False, indent=2))
        return

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

    out_dir = PROFILE_DIR / str(target.get("caseType"))
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.case}-to-{args.target}.json"
    out_path.write_text(json.dumps(adapted, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), "profileId": adapted["profileId"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
