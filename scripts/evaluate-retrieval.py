#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import EvidenceRetrievalAgent  # noqa: E402


CASES: list[dict[str, Any]] = [
    {
        "id": "eval-student",
        "caseType": "student_depression_bullying",
        "simulatorStage": "defensive",
        "client": {"presentingContext": "老師轉介，近期缺課和被同學排擠。"},
        "persona": {"currentStressors": ["school bullying", "academic pressure", "sleep"]},
        "hiddenFacts": [{"label": "group chat exclusion", "disclosed": False}],
        "query": "同學喺群組排擠我，我最近唔係好想返學。",
    },
    {
        "id": "eval-alcohol",
        "caseType": "alcohol_misuse",
        "simulatorStage": "denial",
        "client": {"presentingContext": "家人擔心飲酒增加。"},
        "persona": {"currentStressors": ["alcohol", "stress", "sleep"]},
        "hiddenFacts": [{"label": "drinking after work", "disclosed": False}],
        "query": "我只係夜晚飲兩杯放鬆，唔覺得自己失控。",
    },
    {
        "id": "eval-anxiety",
        "caseType": "anxiety_family_invalidated",
        "simulatorStage": "hesitant",
        "client": {"presentingContext": "家庭覺得焦慮只是想太多。"},
        "persona": {"currentStressors": ["family invalidation", "panic", "therapy access"]},
        "hiddenFacts": [{"label": "panic symptoms", "disclosed": False}],
        "query": "屋企人成日話我諗太多，但我個心跳得好快。",
    },
    {
        "id": "eval-substance",
        "caseType": "substance_recovery_meth",
        "simulatorStage": "shame",
        "client": {"presentingContext": "想停止使用但害怕戒斷。"},
        "persona": {"currentStressors": ["meth", "withdrawal", "relapse"]},
        "hiddenFacts": [{"label": "withdrawal fear", "disclosed": False}],
        "query": "我驚戒斷頂唔住，又怕自己復發。",
    },
    {
        "id": "eval-trauma",
        "caseType": "trauma_sleep_low_self_worth",
        "simulatorStage": "avoidant",
        "client": {"presentingContext": "長期失眠和低自我價值。"},
        "persona": {"currentStressors": ["trauma", "sleep", "self-worth"]},
        "hiddenFacts": [{"label": "sleep disruption", "disclosed": False}],
        "query": "我成晚醒咗瞓唔返，覺得自己好冇用。",
    },
]


def run_case(retriever: EvidenceRetrievalAgent, case_profile: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    cards = retriever.run(
        case_profile=case_profile,
        student_text=case_profile["query"],
        history=[],
        student_analysis={"riskExploration": False},
        simulation_strategy=None,
    )
    elapsed_ms = round((time.time() - started) * 1000, 1)
    return {
        "caseType": case_profile["caseType"],
        "query": case_profile["query"],
        "elapsedMs": elapsed_ms,
        "sources": {source: sum(1 for card in cards if card.get("source") == source) for source in sorted({card.get("source") for card in cards})},
        "issueTags": sorted({tag for card in cards for tag in (card.get("issueTags") or [])})[:12],
        "riskSignals": sorted({signal for card in cards for signal in (card.get("riskSignals") or [])})[:8],
        "cardIds": [card.get("id") for card in cards],
        "debug": retriever.last_debug,
    }


def markdown_report(payload: dict[str, Any]) -> str:
    lines = [
        "# Retrieval Evaluation",
        "",
        f"- generatedAt: `{payload['generatedAt']}`",
        f"- hybridAvailable: `{payload['hybridAvailable']}`",
        "",
        "| case | fts ms | hybrid ms | fts sources | hybrid sources |",
        "| --- | ---: | ---: | --- | --- |",
    ]
    for item in payload["cases"]:
        fts = item["ftsOnly"]
        hybrid = item.get("hybridLocal")
        lines.append(
            "| {case} | {fts_ms} | {hybrid_ms} | {fts_sources} | {hybrid_sources} |".format(
                case=item["caseType"],
                fts_ms=fts["elapsedMs"],
                hybrid_ms=hybrid["elapsedMs"] if hybrid else "n/a",
                fts_sources=", ".join(f"{k}:{v}" for k, v in fts["sources"].items()) or "-",
                hybrid_sources=", ".join(f"{k}:{v}" for k, v in (hybrid or {}).get("sources", {}).items()) or "-",
            )
        )
    return "\n".join(lines) + "\n"


def main() -> None:
    reports_dir = ROOT / "data" / "corpus" / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    fts_retriever = EvidenceRetrievalAgent(ROOT)
    fts_retriever.embedding_store.enabled = False

    hybrid_retriever = EvidenceRetrievalAgent(ROOT)
    hybrid_retriever.embedding_store.enabled = True
    hybrid_available = hybrid_retriever.embedding_store.available

    results: list[dict[str, Any]] = []
    for case_profile in CASES:
        item = {
            "caseType": case_profile["caseType"],
            "ftsOnly": run_case(fts_retriever, case_profile),
        }
        if hybrid_available:
            item["hybridLocal"] = run_case(hybrid_retriever, case_profile)
        results.append(item)

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "embeddingModel": os.environ.get("LOCAL_EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"),
        "hybridAvailable": hybrid_available,
        "hybridStatus": hybrid_retriever.embedding_store.status,
        "cases": results,
    }
    json_path = reports_dir / "retrieval-evaluation.json"
    md_path = reports_dir / "retrieval-evaluation.md"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    md_path.write_text(markdown_report(payload), "utf-8")
    print(json.dumps({"json": str(json_path), "markdown": str(md_path), "hybridAvailable": hybrid_available}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
