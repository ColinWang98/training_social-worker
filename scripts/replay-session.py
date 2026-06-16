#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_export(path: Path) -> dict:
    value = json.loads(path.read_text("utf-8"))
    if not isinstance(value, dict):
        raise SystemExit("Session export must be a JSON object.")
    return value


def count_mentions(text: str, words: list[str]) -> int:
    return sum(text.count(word) for word in words)


def build_replay_report(record: dict) -> dict:
    trace = record.get("trace") if isinstance(record.get("trace"), dict) else {}
    turns = trace.get("turns") if isinstance(trace.get("turns"), list) else []
    transcript = []
    risk_signals: list[str] = []
    revealed_facts: list[str] = []
    for turn in turns:
        transcript.append(
            {
                "turnId": turn.get("turnId"),
                "studentText": turn.get("studentText", ""),
                "clientText": turn.get("clientText", ""),
                "riskSignals": turn.get("riskSignals", []),
                "revealedFacts": turn.get("revealedFacts", []),
                "resistanceLevel": turn.get("resistanceLevel"),
                "affect": turn.get("affect"),
            }
        )
        risk_signals.extend(str(item) for item in turn.get("riskSignals", []) if item)
        revealed_facts.extend(str(item) for item in turn.get("revealedFacts", []) if item)

    student_text_blob = " ".join(str(turn.get("studentText", "")) for turn in turns)
    return {
        "sessionId": record.get("sessionId"),
        "caseId": record.get("caseId"),
        "turnCount": len(turns),
        "transcript": transcript,
        "riskSignals": sorted(set(risk_signals)),
        "revealedFacts": sorted(set(revealed_facts)),
        "microMesoMacroSignals": {
            "micro": count_mentions(student_text_blob, ["家人", "爸爸", "媽媽", "父母", "朋友", "同學", "屋企"]),
            "meso": count_mentions(student_text_blob, ["老師", "學校", "工作", "服務", "轉介", "支援", "醫生"]),
            "macro": count_mentions(student_text_blob, ["社區", "制度", "文化", "污名", "歧視", "香港", "權力"]),
        },
        "replayNotes": [
            "Replay is offline and deterministic; it does not call DeepSeek or mutate session state.",
            "Use this report to compare transcript continuity, disclosure pacing, risk signals, and PIE coverage.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay an exported session trace into a compact benchmark report.")
    parser.add_argument("--input", required=True, help="Path to an exported session JSON")
    parser.add_argument("--out", help="Optional output JSON path")
    args = parser.parse_args()

    record = load_export(Path(args.input))
    report = build_replay_report(record)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
