#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "profiles"


def load_case(case_type: str) -> dict:
    source = (ROOT / "src" / "lib" / "caseProfile.ts").read_text("utf-8")
    marker = f"caseType: '{case_type}'"
    start = source.find(marker)
    if start == -1:
        raise SystemExit(f"Missing case type: {case_type}")
    object_start = source.rfind("{", 0, start)
    depth = 0
    for index in range(object_start, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return ts_object_to_json(source[object_start:index + 1])
    raise SystemExit(f"Could not parse case object: {case_type}")


def ts_object_to_json(snippet: str) -> dict:
    text = snippet.replace("'", '"').replace("undefined", "null")
    text = re.sub(r"([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def corpus_summary(case_profile: dict) -> dict:
    path = ROOT / "data" / "corpus" / "social-work-client-corpus.jsonl"
    if not path.exists():
        path = ROOT / "data" / "corpus" / "seed-evidence-cards.json"
        cards = json.loads(path.read_text("utf-8")) if path.exists() else []
    else:
        cards = [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]
    wanted_tags = set(case_profile.get("issueTags", []))
    matched = [
        card for card in cards
        if wanted_tags & set(card.get("issueTags", [])) or card.get("clientGroup") in {"student", "substance_use", "depression", "anxiety", "trauma"}
    ][:80]
    sources: dict[str, int] = {}
    tags: dict[str, int] = {}
    for card in matched:
        sources[card.get("source", "unknown")] = sources.get(card.get("source", "unknown"), 0) + 1
        for tag in card.get("issueTags", []):
            tags[tag] = tags.get(tag, 0) + 1
    return {
        "cardCount": len(matched),
        "sources": sources,
        "topIssueTags": [tag for tag, _ in sorted(tags.items(), key=lambda item: (-item[1], item[0]))[:12]],
    }


def synthetic_interview(case_profile: dict) -> list[dict[str, str]]:
    context = case_profile.get("socialWorkContextModel", {})
    persona = case_profile.get("persona", {})
    return [
        {"question": "你會點樣形容而家最大壓力？", "answer": context.get("selfNarrative", "")},
        {"question": "屋企、學校或工作入面，邊啲關係最影響你？", "answer": "；".join(context.get("relationshipExpectations", []))},
        {"question": "你最怕別人點樣睇你？", "answer": "；".join(context.get("shameTriggers", []))},
        {"question": "你通常點避開難講嘅事？", "answer": "；".join(context.get("avoidancePatterns", []))},
        {"question": "你希望求助係點樣先會安全？", "answer": "；".join(context.get("helpSeekingBeliefs", []))},
        {"question": "你平時講嘢大概係咩風格？", "answer": "；".join(persona.get("speechStyleExamples", []))},
    ]


def build_profile(case_profile: dict, use_synthetic: bool) -> dict:
    context = case_profile.get("socialWorkContextModel", {})
    persona = case_profile.get("persona", {})
    interview = synthetic_interview(case_profile) if use_synthetic else []
    summary = corpus_summary(case_profile)
    relationships = case_profile.get("relationships", [])
    events = sorted(case_profile.get("eventTimeline", []), key=lambda event: event.get("day", 0), reverse=True)
    hidden_facts = case_profile.get("hiddenFacts", [])
    issue_tags = case_profile.get("issueTags", [])
    return {
        "profileId": f"{case_profile.get('caseType')}-grounding",
        "caseId": case_profile.get("id"),
        "caseType": case_profile.get("caseType"),
        "generationMode": "synthetic_interview" if use_synthetic else "case_spec_corpus",
        "selfReportGrounding": {
            "sourceType": "synthetic_interview" if use_synthetic else "case_spec",
            "syntheticInterview": interview,
            "presentingContext": case_profile.get("client", {}).get("presentingContext"),
        },
        "lifeHistory": persona.get("background", ""),
        "familySchoolWorkContext": "；".join(persona.get("currentStressors", [])),
        "relationshipHistory": "；".join(
            f"{item.get('person')}({item.get('role')}): trust {item.get('trust')}, conflict {item.get('conflict')}"
            for item in case_profile.get("relationships", [])
        ),
        "valuesFearsShameTriggers": {
            "coreBeliefs": context.get("coreBeliefs", []),
            "shameTriggers": context.get("shameTriggers", []),
            "helpSeekingBeliefs": context.get("helpSeekingBeliefs", []),
        },
        "avoidancePatterns": context.get("avoidancePatterns", []),
        "speechStyle": "；".join(persona.get("speechStyleExamples", [])),
        "caseReflections": {
            "pie": [context.get("selfNarrative", ""), "從家庭、學校/工作、朋輩和服務系統脈絡理解服務對象。"],
            "riskProtective": [
                f"baselineRisk: {case_profile.get('riskProfile', {}).get('baselineRisk')}",
                "protectiveFactors: " + "；".join(case_profile.get("riskProfile", {}).get("protectiveFactors", [])),
            ],
            "traumaInformed": context.get("disclosureRules", []),
            "motivationalInterviewing": persona.get("changeTalkSignals", []),
            "languageStyle": persona.get("speechStyleExamples", []),
        },
        "personInEnvironment": {
            "person": {
                "selfNarrative": context.get("selfNarrative", ""),
                "coreBeliefs": context.get("coreBeliefs", []),
                "stressResponseStyle": context.get("stressResponseStyle", ""),
                "valuesAndFears": context.get("shameTriggers", []),
            },
            "environment": {
                "familySchoolWorkContext": "；".join(persona.get("currentStressors", [])),
                "relationshipExpectations": context.get("relationshipExpectations", []),
                "helpSeekingBeliefs": context.get("helpSeekingBeliefs", []),
                "issueTags": issue_tags,
            },
            "fitTensions": [
                "服務對象的自我敘事與家庭/學校/服務系統互動一同影響透露節奏。",
                "訪談回應應先反映目前 micro/meso/macro 壓力，而非只套用 diagnosis-like persona。",
            ],
        },
        "microSystem": {
            "definition": "直接接觸的人際環境，例如家人、同學、朋友、照顧者。",
            "relationships": [
                {
                    "person": item.get("person"),
                    "role": item.get("role"),
                    "closeness": item.get("closeness"),
                    "trust": item.get("trust"),
                    "conflict": item.get("conflict"),
                }
                for item in relationships
            ],
            "likelyTriggers": context.get("shameTriggers", []),
            "protectiveSignals": case_profile.get("riskProfile", {}).get("protectiveFactors", []),
        },
        "mesoSystem": {
            "definition": "學校、工作、服務系統與家庭/朋輩之間的互動。",
            "recentEvents": [
                {
                    "type": event.get("type"),
                    "description": event.get("description"),
                    "participants": event.get("participants", []),
                    "impactScore": event.get("impactScore"),
                }
                for event in events[:8]
            ],
            "servicePathways": [
                case_profile.get("client", {}).get("presentingContext", ""),
                *context.get("helpSeekingBeliefs", []),
            ],
            "disclosureRules": context.get("disclosureRules", []),
        },
        "macroSystem": {
            "definition": "更大層面的制度、文化、污名、經濟或社區因素。",
            "hongKongContextNotes": [
                "本地訓練語境以香港繁中/口語粵語呈現，並避免把求助困難個人化。",
                "回應需保留污名、權力差異、學校/家庭/服務制度壓力的影響。",
            ],
            "structuralRisks": unique_preserve_order([
                *issue_tags,
                *case_profile.get("riskProfile", {}).get("watchFor", []),
            ])[:10],
        },
        "disclosureDevelopment": {
            "hiddenFactCount": len(hidden_facts),
            "coreDisclosureRules": context.get("disclosureRules", []),
            "pacePrinciple": "每輪最多透露 0-1 個核心 hidden fact；先建立信任、再探索風險和脈絡。",
        },
        "adaptationLog": [],
        "sourceEvidenceSummary": summary,
    }


def unique_preserve_order(values: list) -> list:
    seen = set()
    result = []
    for value in values:
        text = str(value).strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate grounding profiles for social-work simulator cases.")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--from-case-spec", action="store_true")
    mode.add_argument("--synthetic-interview", action="store_true")
    parser.add_argument("--case", required=True, help="Case type, e.g. student_depression_bullying")
    args = parser.parse_args()

    case_profile = load_case(args.case)
    profile = build_profile(case_profile, use_synthetic=args.synthetic_interview)
    case_dir = OUT_DIR / case_profile["caseType"]
    case_dir.mkdir(parents=True, exist_ok=True)
    out_path = case_dir / f"{case_profile['caseType']}-{profile['generationMode']}.json"
    out_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", "utf-8")
    active_path = case_dir / "active.json"
    active_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), "activePath": str(active_path), "profileId": profile["profileId"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
