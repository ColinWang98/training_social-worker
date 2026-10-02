from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

try:
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
    from psycopg_pool import ConnectionPool

    POSTGRES_AVAILABLE = True
except Exception:  # pragma: no cover - optional Supabase dependency
    psycopg = None
    dict_row = None
    Jsonb = None
    ConnectionPool = None
    POSTGRES_AVAILABLE = False

try:  # Optional at import time so static checks still work before deps are installed.
    from google.adk.agents import LlmAgent
    from google.adk.models.lite_llm import LiteLlm
    from google.adk.runners import Runner
    from google.adk.sessions import DatabaseSessionService, InMemorySessionService
    from google.genai.types import Content, GenerateContentConfig, Part

    ADK_AVAILABLE = True
except Exception:  # pragma: no cover - depends on local Python environment
    LlmAgent = None
    LiteLlm = None
    Runner = None
    DatabaseSessionService = None
    InMemorySessionService = None
    Content = None
    GenerateContentConfig = None
    Part = None
    ADK_AVAILABLE = False


ALLOWED_AFFECTS = {
    "neutral",
    "defensive",
    "ashamed",
    "anxious",
    "reflective",
    "withdrawn",
    "irritated",
    "sad",
}
ALLOWED_MOTIONS = {"neutral", "look_down", "avoid_eye_contact", "rub_hands", "lean_back", "slow_nod"}
RHUBARB_SHAPE_TO_VISEME = {
    "A": "closed",
    "B": "soft",
    "C": "open",
    "D": "wide",
    "E": "rounded",
    "F": "rounded",
    "G": "fv",
    "H": "front",
    "X": "rest",
}
NUMERIC_STATE_KEYS = [
    "distressLevel",
    "stressLevel",
    "selfEsteem",
    "socialConnection",
    "academicPressure",
    "clientOpenness",
]
SUBSTANCE_CASE_TYPES = {"substance_recovery_meth", "alcohol_misuse"}
SIMULATION_METHODS = {
    "social_work_default",
    "adaptive_vp",
    "consistent_mi",
    "patient_psi_context",
    "roleplay_doh",
    "annaagent_memory",
}
HK_PCF_DOMAINS = [
    "engagementAndRelationship",
    "assessmentAndInformationGathering",
    "personInEnvironmentAndHongKongContext",
    "ethicsConfidentialityAndBoundaries",
    "selfDeterminationAndInformedChoice",
    "diversityAntiDiscriminationAndCulturalSensitivity",
    "riskSafetyAndSafeguarding",
    "interventionPlanningAndReferral",
    "professionalReflectionAndUseOfSupervision",
]
HK_PCF_FRAMEWORK_LABEL = "參考香港社工專業操守、社工教育能力要求及本地實務語境的訓練評估"
HK_PCF_DISCLAIMER = "此報告為本地教學/研究 prototype，不代表 SWRB 官方評核或註冊資格判定。"
HK_PCF_FRAMEWORK_BASIS = [
    "SWRB Code of Practice：專業操守、保密、自決、文化敏感、界線與服務對象利益。",
    "SWRB PCS 8th Edition：ethical practice、human rights/social justice、diversity、knowledge and skills for practice、professional development。",
    "本地社工訪談訓練脈絡：人在情境、風險與保護因素、轉介及安全下一步。",
]

METHOD_STRATEGIES: dict[str, dict[str, Any]] = {
    "social_work_default": {
        "label": "Social Work Default",
        "promptFocus": ["person_in_environment", "trainee_skill_response", "risk_protective_factors"],
        "responseConstraints": ["保持現有社工訓練主流程。"],
        "retrievalBoostSources": [],
        "retrievalBoostTags": [],
        "evaluatorFocus": ["clientRealism", "riskGating", "socialWorkInterviewQuality"],
    },
    "adaptive_vp": {
        "label": "Adaptive-VP",
        "promptFocus": ["trainee_driven_response", "resistance_shift", "disclosure_boundary"],
        "responseConstraints": ["學生話術必須明顯影響阻抗、開放度和透露深度。"],
        "retrievalBoostSources": ["esconv", "annomi"],
        "retrievalBoostTags": ["resistance", "support", "reflection", "ambivalence"],
        "evaluatorFocus": ["disclosurePacing", "sessionContinuity", "socialWorkInterviewQuality"],
    },
    "consistent_mi": {
        "label": "Consistent MI",
        "promptFocus": ["motivational_interviewing", "change_talk", "sustain_talk"],
        "responseConstraints": ["change talk 只能由同理、反映或矛盾探索逐步引出。"],
        "retrievalBoostSources": ["annomi", "multilingual_therapy"],
        "retrievalBoostTags": ["alcohol", "ambivalence", "change talk", "substance_use"],
        "evaluatorFocus": ["clientRealism", "disclosurePacing", "socialWorkInterviewQuality"],
    },
    "patient_psi_context": {
        "label": "Patient-PSI Context",
        "promptFocus": ["cognitive_context_model", "self_report_grounding", "core_beliefs"],
        "responseConstraints": ["回答必須符合個案自我敘事、核心信念、羞恥觸發和求助信念。"],
        "retrievalBoostSources": ["multilingual_therapy", "counsel_chat"],
        "retrievalBoostTags": ["family", "trauma", "self-worth", "anxiety", "sleep"],
        "evaluatorFocus": ["contextConsistency", "clientRealism", "corpusGrounding"],
    },
    "roleplay_doh": {
        "label": "Roleplay DOH",
        "promptFocus": ["roleplay_fidelity", "natural_cantonese", "non_textbook_client_voice"],
        "responseConstraints": ["避免旁白、治療師語氣、完整理性分析；保持服務對象口語短句。"],
        "retrievalBoostSources": ["esconv", "empathetic_dialogues"],
        "retrievalBoostTags": ["ashamed", "afraid", "angry", "sad", "avoidance"],
        "evaluatorFocus": ["clientRealism", "avatarAlignment", "corpusGrounding"],
    },
    "annaagent_memory": {
        "label": "AnnaAgent Memory",
        "promptFocus": ["session_memory", "relationship_memory", "rupture_repair"],
        "responseConstraints": ["必須延續前文關係記憶，尤其是冒犯、道歉、已透露 facts 和迴避話題。"],
        "retrievalBoostSources": ["esconv", "annomi"],
        "retrievalBoostTags": ["rupture", "repair", "trust", "avoidance", "support"],
        "evaluatorFocus": ["sessionContinuity", "contextConsistency", "avatarAlignment"],
    },
}


def load_local_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


class PromptRegistry:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.registry_dir = root_dir / "adk_service" / "prompt_registry"
        self._cache: dict[str, Any] = {}

    def load(self, relative_path: str, fallback: Any | None = None) -> Any:
        key = relative_path.replace("\\", "/")
        if key in self._cache:
            return self._cache[key]
        path = self.registry_dir / key
        if not path.exists():
            if fallback is not None:
                self._cache[key] = fallback
                return fallback
            raise FileNotFoundError(f"Missing prompt registry file: {path}")
        value = json.loads(path.read_text("utf-8"))
        self._cache[key] = value
        return value

    def strategy_methods(self) -> dict[str, dict[str, Any]]:
        raw = self.load("strategy/simulation_methods.json", METHOD_STRATEGIES)
        if not isinstance(raw, dict):
            return METHOD_STRATEGIES
        return {key: value for key, value in raw.items() if isinstance(value, dict)}

    def client_prompt(self) -> dict[str, Any]:
        return self.load("client/social_work_client.json", {})

    def realism_repair(self) -> dict[str, Any]:
        return self.load("realism/repair.json", {})

    def post_session_supervisor(self) -> dict[str, Any]:
        return self.load("supervisor/post_session.json", {})

    @staticmethod
    def render_lines(lines: list[Any], prefix: str = "- ") -> str:
        return "\n".join(f"{prefix}{line}" for line in lines if isinstance(line, str) and line.strip())


DEFAULT_PROMPT_REGISTRY = PromptRegistry(Path(__file__).resolve().parents[1])


def load_active_grounding_profile(root_dir: Path, case_profile: dict[str, Any]) -> dict[str, Any]:
    case_type = case_profile.get("caseType")
    if not isinstance(case_type, str) or not case_type:
        return {}
    profile_dir = root_dir / "data" / "profiles" / case_type
    legacy_dir = root_dir / "data" / "profiles"
    candidates = [
        profile_dir / "active.json",
        profile_dir / f"{case_type}-case_spec_corpus.json",
        profile_dir / f"{case_type}-synthetic_interview.json",
        legacy_dir / f"{case_type}-case_spec_corpus.json",
        legacy_dir / f"{case_type}-synthetic_interview.json",
    ]
    for path in candidates:
        if not path.exists():
            continue
        try:
            value = json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            value.setdefault("profilePath", str(path.relative_to(root_dir)))
            return value
    return {}


def summarize_grounding_profile(profile: dict[str, Any]) -> dict[str, Any] | None:
    if not profile:
        return None
    reflections = profile.get("caseReflections") if isinstance(profile.get("caseReflections"), dict) else {}
    source_summary = profile.get("sourceEvidenceSummary") if isinstance(profile.get("sourceEvidenceSummary"), dict) else {}
    return {
        "profileId": profile.get("profileId"),
        "caseType": profile.get("caseType"),
        "generationMode": profile.get("generationMode"),
        "profilePath": profile.get("profilePath"),
        "reflectionKeys": sorted(reflections.keys()) if reflections else [],
        "sourceEvidenceSummary": {
            "cardCount": source_summary.get("cardCount"),
            "topIssueTags": source_summary.get("topIssueTags", []),
            "sources": source_summary.get("sources", {}),
        },
        "adaptationCount": len(profile.get("adaptationLog") or []),
    }


def summarize_pie_context(profile: dict[str, Any], case_profile: dict[str, Any]) -> dict[str, Any]:
    pie = profile.get("personInEnvironment") if isinstance(profile.get("personInEnvironment"), dict) else {}
    micro = profile.get("microSystem") if isinstance(profile.get("microSystem"), dict) else {}
    meso = profile.get("mesoSystem") if isinstance(profile.get("mesoSystem"), dict) else {}
    macro = profile.get("macroSystem") if isinstance(profile.get("macroSystem"), dict) else {}
    if not profile:
        context = case_profile.get("socialWorkContextModel", {}) if isinstance(case_profile.get("socialWorkContextModel"), dict) else {}
        return {
            "source": "case_spec",
            "personInEnvironment": {
                "person": context.get("selfNarrative", ""),
                "environment": unique_strings([
                    *context.get("relationshipExpectations", []),
                    *case_profile.get("issueTags", []),
                ])[:8],
            },
            "microSystem": {},
            "mesoSystem": {},
            "macroSystem": {},
        }
    return {
        "source": "grounding_profile",
        "personInEnvironment": pie,
        "microSystem": micro,
        "mesoSystem": meso,
        "macroSystem": macro,
    }


def compact_profile_for_prompt(profile: dict[str, Any]) -> dict[str, Any]:
    if not profile:
        return {}
    reflections = profile.get("caseReflections") if isinstance(profile.get("caseReflections"), dict) else {}
    safe_reflections = {
        key: value
        for key, value in reflections.items()
        if key != "languageStyle"
    }
    self_report = profile.get("selfReportGrounding") if isinstance(profile.get("selfReportGrounding"), dict) else {}
    return {
        "profileId": profile.get("profileId"),
        "generationMode": profile.get("generationMode"),
        "selfReportGrounding": {
            "sourceType": self_report.get("sourceType"),
            "presentingContext": self_report.get("presentingContext"),
            "syntheticInterviewAvailable": bool(self_report.get("syntheticInterview")),
        },
        "lifeHistory": profile.get("lifeHistory"),
        "familySchoolWorkContext": profile.get("familySchoolWorkContext"),
        "relationshipHistory": profile.get("relationshipHistory"),
        "valuesFearsShameTriggers": profile.get("valuesFearsShameTriggers"),
        "avoidancePatterns": profile.get("avoidancePatterns"),
        "speechStyle": "Use abstract case speechStyleGuide only; do not reuse stored example utterances.",
        "caseReflections": safe_reflections,
        "personInEnvironment": profile.get("personInEnvironment"),
        "microSystem": profile.get("microSystem"),
        "mesoSystem": profile.get("mesoSystem"),
        "macroSystem": profile.get("macroSystem"),
        "adaptationLog": profile.get("adaptationLog", [])[-3:],
        "sourceEvidenceSummary": profile.get("sourceEvidenceSummary"),
    }


def supabase_database_url() -> str | None:
    return os.environ.get("SUPABASE_DATABASE_URL") or os.environ.get("DATABASE_URL")


def unique_strings(values: list[Any]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if not isinstance(value, str):
            continue
        text = value.strip()
        if text and text not in seen:
            seen.add(text)
            result.append(text)
    return result


def normalize_risk_signal(signal: Any, case_type: str | None = None) -> str | None:
    if not isinstance(signal, str):
        return None
    text = signal.strip().lower().replace("_", " ").replace("-", " ")
    if not text:
        return None
    if re.search(r"passive|self harm|suicid|kill myself|not wake|唔使醒|不想活|自殺|自杀", text):
        return "passive_self_harm_language"
    if re.search(r"唔想醒|唔使醒|醒返", text):
        return "passive_self_harm_language"
    if re.search(r"sleep|insomnia|瞓|睡眠|失眠", text):
        return "sleep_disruption"
    if re.search(r"relapse|craving|復發|复发|渴求", text):
        return "relapse_trigger"
    if re.search(r"withdrawal|detox|戒斷|戒断", text):
        return "substance_withdrawal" if case_type in SUBSTANCE_CASE_TYPES else "social_withdrawal"
    if re.search(r"isolat|social withdrawal|退縮|孤立|避開", text):
        return "social_withdrawal"
    if re.search(r"violence|violent|attack|assault|暴力|襲擊|袭击", text):
        return "violence_risk"
    if re.search(r"trauma|flashback|創傷|创伤", text):
        return "trauma_overwhelm"
    if re.search(r"hopeless|絕望", text):
        return "hopelessness"
    if re.search(r"bully|欺凌|排擠|排挤", text):
        return "bullying_escalation"
    if re.search(r"unsafe detail|operational harm|安全審查", text):
        return "safety_review_repaired"
    return text.replace(" ", "_")


def normalize_risk_signals(signals: list[Any], case_type: str | None = None) -> list[str]:
    return unique_strings([
        normalized
        for signal in signals
        if (normalized := normalize_risk_signal(signal, case_type))
    ])


def client_disclosed_risk_signals(response: dict[str, Any], case_type: str | None = None) -> list[str]:
    """Keep risk signals only when the simulated client actually discloses them."""
    normalized = normalize_risk_signals(response.get("riskSignals", []), case_type)
    if not normalized:
        return []
    text = str(response.get("clientText", ""))
    revealed_text = " ".join(str(item) for item in response.get("revealedFacts", []) if isinstance(item, str))
    evidence = f"{text} {revealed_text}"
    kept: list[str] = []
    for signal in normalized:
        if signal == "passive_self_harm_language" and re.search(
            r"唔想醒|唔使醒|醒返|不想活|自殺|自杀|傷害自己|伤害自己|not wake|kill myself|suicid|passive-risk",
            evidence,
            re.I,
        ):
            kept.append(signal)
        elif signal == "substance_withdrawal" and re.search(r"戒斷|戒断|withdrawal|detox|頂唔住|medical-support|withdrawal-fear", evidence, re.I):
            kept.append(signal)
        elif signal == "relapse_trigger" and re.search(r"復發|复发|relapse|忍唔住|trigger|relapse-history", evidence, re.I):
            kept.append(signal)
        elif signal == "sleep_disruption" and re.search(r"瞓|睡|失眠|sleep|醒|sleep", evidence, re.I):
            kept.append(signal)
        elif signal == "violence_risk" and re.search(r"暴力|襲擊|袭击|attack|assault|violence", evidence, re.I):
            kept.append(signal)
        elif signal == "trauma_overwhelm" and re.search(r"創傷|创伤|trauma|flashback|abuse-history", evidence, re.I):
            kept.append(signal)
        elif signal == "bullying_escalation" and re.search(r"欺凌|排擠|排挤|走廊|群組|同學|bully|group-chat", evidence, re.I):
            kept.append(signal)
        elif signal == "hopelessness" and re.search(r"絕望|冇希望|沒有希望|hopeless|冇用|唔值得", evidence, re.I):
            kept.append(signal)
        elif signal == "social_withdrawal" and re.search(r"孤立|退縮|避開|social withdrawal|isolation", evidence, re.I):
            kept.append(signal)
        elif signal == "safety_review_repaired":
            kept.append(signal)
    return unique_strings(kept)


def clamp_score(value: float) -> float:
    return min(10, max(0, round(value * 10) / 10))


def clamp_float(value: Any, minimum: float, maximum: float) -> float:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        numeric = 1.0
    return min(maximum, max(minimum, numeric))


def tokenize(text: Any) -> set[str]:
    return {token for token in re.split(r"[^a-z0-9\u4e00-\u9fff]+", str(text).lower()) if len(token) > 1}


def has_token_overlap(left: set[str], right: set[str]) -> bool:
    return any(token in right for token in left)


PROGRESSION_STAGES = [
    "initial_contact",
    "presenting_issue",
    "context_disclosure",
    "risk_or_need_exploration",
    "next_step_readiness",
]

PROGRESSION_DEPTH_BY_STAGE = {
    "initial_contact": 1,
    "presenting_issue": 1,
    "context_disclosure": 2,
    "risk_or_need_exploration": 3,
    "next_step_readiness": 3,
}


GENERIC_ISSUE_PROGRESSION_CHAIN = [
    {
        "stage": "initial_contact",
        "allowedDisclosureDepth": 1,
        "surfaceCues": ["轉介或求助入口", "對訪談的保留", "低深度情緒線索"],
        "transitionSignals": ["openQuestion", "genericEmpathy", "respectChoice"],
        "pauseSignals": ["mockingOrDismissive", "doubtOrInvalidating", "judgmentalOrDirective"],
        "nextAffordance": "可追問服務對象怎樣看這次接觸，或最近哪一刻最難受。",
    },
    {
        "stage": "presenting_issue",
        "allowedDisclosureDepth": 1,
        "surfaceCues": ["目前最困擾的場景", "壓力來源", "一個可觀察改變"],
        "transitionSignals": ["reflectiveListening", "openQuestion", "lowDepthCue"],
        "pauseSignals": ["directBlame", "prematureAdvice", "forcedDisclosure"],
        "nextAffordance": "可追問具體場景、感受或服務對象希望別人明白的地方。",
    },
    {
        "stage": "context_disclosure",
        "allowedDisclosureDepth": 2,
        "surfaceCues": ["家庭或學校/工作脈絡", "關係壓力", "保護因素"],
        "transitionSignals": ["rapportAccumulated", "specificFollowUp", "nonJudgmentalReflection"],
        "pauseSignals": ["shaming", "rushedAction", "ignoredChoice"],
        "nextAffordance": "可追問人際、環境和支援網絡如何影響目前處境。",
    },
    {
        "stage": "risk_or_need_exploration",
        "allowedDisclosureDepth": 3,
        "surfaceCues": ["安全線索", "支援需要", "危機時可用資源"],
        "transitionSignals": ["riskExploration", "safetyQuestion", "supportMapping"],
        "pauseSignals": ["operationalHarmDetail", "threateningQuestion", "coercivePlan"],
        "nextAffordance": "可追問安全感、保護因素和下一步可接受的支援。",
    },
    {
        "stage": "next_step_readiness",
        "allowedDisclosureDepth": 3,
        "surfaceCues": ["願意嘗試的小步驟", "可接受支援", "跟進安排"],
        "transitionSignals": ["collaborativePlanning", "choiceConfirmed", "supportIdentified"],
        "pauseSignals": ["workerDecidesEverything", "noConsentContact", "punitivePlan"],
        "nextAffordance": "可共同整理一個服務對象願意接受的安全下一步。",
    },
]


def valid_progression_stage(value: Any) -> str | None:
    return value if isinstance(value, str) and value in PROGRESSION_STAGES else None


def issue_progression_chain(case_profile: dict[str, Any]) -> list[dict[str, Any]]:
    raw_chain = case_profile.get("issueProgressionChain") if isinstance(case_profile, dict) else None
    entries: list[dict[str, Any]] = []
    if isinstance(raw_chain, list):
        for item in raw_chain:
            if not isinstance(item, dict):
                continue
            stage = valid_progression_stage(item.get("stage"))
            if not stage:
                continue
            entries.append(
                {
                    "stage": stage,
                    "allowedDisclosureDepth": max(1, min(4, int(item.get("allowedDisclosureDepth") or PROGRESSION_DEPTH_BY_STAGE.get(stage, 1)))),
                    "surfaceCues": unique_strings(item.get("surfaceCues") if isinstance(item.get("surfaceCues"), list) else [])[:6],
                    "transitionSignals": unique_strings(item.get("transitionSignals") if isinstance(item.get("transitionSignals"), list) else [])[:6],
                    "pauseSignals": unique_strings(item.get("pauseSignals") if isinstance(item.get("pauseSignals"), list) else [])[:6],
                    "nextAffordance": str(item.get("nextAffordance") or ""),
                }
            )
    if not entries:
        entries = [dict(item) for item in GENERIC_ISSUE_PROGRESSION_CHAIN]

    existing = {entry["stage"] for entry in entries}
    for item in GENERIC_ISSUE_PROGRESSION_CHAIN:
        if item["stage"] not in existing:
            entries.append(dict(item))
    return sorted(entries, key=lambda entry: PROGRESSION_STAGES.index(entry["stage"]))


def issue_stage_entry(case_profile: dict[str, Any], stage: str | None) -> dict[str, Any]:
    normalized = valid_progression_stage(stage) or "initial_contact"
    for entry in issue_progression_chain(case_profile):
        if entry.get("stage") == normalized:
            return entry
    return dict(GENERIC_ISSUE_PROGRESSION_CHAIN[0])


def issue_stage_index(stage: str | None) -> int:
    normalized = valid_progression_stage(stage) or "initial_contact"
    return PROGRESSION_STAGES.index(normalized)


def later_issue_stage(left: str | None, right: str | None) -> str:
    left_stage = valid_progression_stage(left) or "initial_contact"
    right_stage = valid_progression_stage(right) or "initial_contact"
    return left_stage if issue_stage_index(left_stage) >= issue_stage_index(right_stage) else right_stage


def progression_snapshot(
    case_profile: dict[str, Any],
    student_analysis: dict[str, bool],
    session_continuity: dict[str, Any],
) -> dict[str, Any]:
    trust_values = session_continuity.get("trustTrajectory") if isinstance(session_continuity, dict) else []
    trust = trust_values[-1] if isinstance(trust_values, list) and trust_values else case_profile.get("psychologicalState", {}).get("clientOpenness", 0)
    trust = clamp_float(trust, 0, 10)
    disclosed = session_continuity.get("disclosedFactIds", []) if isinstance(session_continuity, dict) else []
    ruptures = session_continuity.get("ruptureEvents", []) if isinstance(session_continuity, dict) else []
    repairs = session_continuity.get("repairAttempts", []) if isinstance(session_continuity, dict) else []
    prior_stage = valid_progression_stage(session_continuity.get("currentIssueStage")) if isinstance(session_continuity, dict) else None
    prior_stage = prior_stage or "initial_contact"
    current_rupture = bool(
        student_analysis.get("mockingOrDismissive")
        or student_analysis.get("doubtOrInvalidating")
        or student_analysis.get("judgmentalOrDirective")
        or student_analysis.get("prematureAdvice")
    )
    unresolved_rupture = bool(ruptures) and not repairs
    progression_paused = bool(current_rupture or (unresolved_rupture and not student_analysis.get("apologyRepair")))

    stage = prior_stage
    signals: list[str] = []
    issue_stage_reason = "延續本次訓練內上一輪 issue stage。"
    progression_paused_reason = ""
    if student_analysis.get("riskExploration"):
        stage = later_issue_stage(stage, "risk_or_need_exploration")
        signals.append("risk_exploration")
        issue_stage_reason = "學生作出安全或風險探索，允許進入風險/需要探索。"
    elif progression_paused:
        signals.append("progression_paused_by_rupture")
        progression_paused_reason = "本輪或上一輪存在未修復的關係破裂，暫停向更深層透露推進。"
        issue_stage_reason = "關係破裂時維持原 stage，只允許情緒反應或低深度線索。"
    elif trust >= 5 or len(disclosed) >= 2:
        stage = later_issue_stage(stage, "context_disclosure")
        signals.append("trust_or_disclosure_accumulated")
        issue_stage_reason = "本次 session 已累積信任或披露，推進至脈絡探索。"
    elif student_analysis.get("reflectiveListening") or len(disclosed) >= 1 or trust >= 3.5:
        target_stage = "context_disclosure" if trust >= 4.5 or (stage == "presenting_issue" and student_analysis.get("reflectiveListening")) else "presenting_issue"
        stage = later_issue_stage(stage, target_stage)
        signals.append("reflective_or_initial_disclosure")
        issue_stage_reason = "反映式聆聽、初步披露或信任提升，允許比初始接觸更具體。"
    elif student_analysis.get("openQuestion") or student_analysis.get("genericEmpathy") or student_analysis.get("apologyRepair"):
        stage = later_issue_stage(stage, "presenting_issue")
        signals.append("open_or_repair_invitation")
        issue_stage_reason = "開放式邀請、泛同理或修復嘗試足以重新開始低深度探索。"

    stage_config = issue_stage_entry(case_profile, stage)
    max_depth = int(stage_config.get("allowedDisclosureDepth") or PROGRESSION_DEPTH_BY_STAGE.get(stage, 1))
    if student_analysis.get("minimalBackchannel"):
        max_depth = min(max_depth, 1)
        signals.append("minimal_backchannel_low_depth")
    if progression_paused and not student_analysis.get("riskExploration"):
        max_depth = min(max_depth, 1)

    return {
        "progressionStage": stage,
        "progressionPaused": progression_paused,
        "progressionSignals": unique_strings(signals),
        "minFollowUpAffordance": "surface_cue" if not progression_paused else "emotional_reaction",
        "maxDisclosureStep": max_depth,
        "issueStageReason": issue_stage_reason,
        "requiredFollowUpAffordance": stage_config.get("nextAffordance") or "留下一個自然可追問的低深度線索。",
        "progressionPausedReason": progression_paused_reason,
    }


def parse_json_object(content: str) -> dict[str, Any]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"```$", "", text).strip()
    return json.loads(text)


def json_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


@dataclass
class ManagedAgent:
    name: str
    instruction: str
    model_name: str
    adk_managed: bool = True

    def __post_init__(self) -> None:
        self.adk_agent = None
        if self.adk_managed and ADK_AVAILABLE and LlmAgent and LiteLlm:
            try:
                self.adk_agent = LlmAgent(
                    name=self.name,
                    model=LiteLlm(model=self.model_name),
                    instruction=self.instruction,
                )
            except Exception:
                self.adk_agent = None

    @property
    def adk_enabled(self) -> bool:
        return self.adk_agent is not None


class DeepSeekClient:
    def __init__(self) -> None:
        self.api_key = os.environ.get("DEEPSEEK_API_KEY")
        self.base_url = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").rstrip("/")
        self.model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def json_completion(self, prompt: str, temperature: float) -> dict[str, Any]:
        if not self.api_key:
            raise RuntimeError("DEEPSEEK_API_KEY is not set.")
        if os.environ.get("ADK_LLM_EXECUTION_ENABLED", "false").lower() == "true":
            return await self._adk_json_completion(prompt, temperature)
        payload = {
            "model": self.model,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "Return only valid JSON. This is a local social-work interview training simulator, "
                        "not medical diagnosis or treatment. Use Traditional Chinese for professional feedback "
                        "and Hong Kong Cantonese for client speech when requested."
                    ),
                },
                {"role": "user", "content": prompt},
            ],
        }
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    json=payload,
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {self.api_key}",
                    },
                )
                response.raise_for_status()
                data = response.json()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"DeepSeek request failed with {exc.response.status_code}: {exc.response.text}"
            ) from exc
        except httpx.HTTPError as exc:
            raise RuntimeError(f"DeepSeek request failed: {exc}") from exc
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return parse_json_object(content)

    async def _adk_json_completion(self, prompt: str, temperature: float) -> dict[str, Any]:
        if not ADK_AVAILABLE or not all((Runner, InMemorySessionService, Content, GenerateContentConfig, Part)):
            raise RuntimeError("ADK Runner execution is enabled but its runtime is unavailable.")
        app_name = "social-work-simulation"
        user_id = "ephemeral-invocation"
        session_id = f"invocation-{uuid.uuid4().hex}"
        service = InMemorySessionService()
        await service.create_session(app_name=app_name, user_id=user_id, session_id=session_id)
        agent = LlmAgent(
            name="structured_social_work_response",
            model=LiteLlm(
                model=f"openai/{self.model}",
                api_base=self.base_url,
                api_key=self.api_key,
            ),
            instruction=(
                "Return only one valid JSON object. Do not add markdown or prose outside JSON. "
                "Follow the user's requested schema and safety constraints exactly. This is a social-work "
                "training simulator, not medical diagnosis or treatment. Use Traditional Chinese for "
                "professional feedback and Hong Kong Cantonese for client speech when requested."
            ),
            generate_content_config=GenerateContentConfig(temperature=temperature),
            include_contents="none",
        )
        runner = Runner(agent=agent, app_name=app_name, session_service=service)
        final_text = ""
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=Content(role="user", parts=[Part(text=prompt)]),
        ):
            if event.is_final_response() and event.content:
                final_text = "".join(part.text or "" for part in event.content.parts or [])
        if not final_text:
            raise RuntimeError("ADK Runner completed without a final JSON response.")
        return parse_json_object(final_text)


class AgentSessionStore:
    def __init__(self, root_dir: Path) -> None:
        self.db_path = root_dir / "data" / "adk" / "social-work-agent-sessions.sqlite"
        self.postgres_url = supabase_database_url()
        self.pg_pool = None
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.adk_session_service = None
        if self.postgres_url and POSTGRES_AVAILABLE and ConnectionPool:
            self.pg_pool = ConnectionPool(
                conninfo=self.postgres_url,
                min_size=1,
                max_size=int(os.environ.get("SUPABASE_POOL_SIZE", "4")),
                kwargs={"row_factory": dict_row},
                open=True,
            )
        if ADK_AVAILABLE and DatabaseSessionService:
            try:
                self.adk_session_service = DatabaseSessionService(
                    db_url=f"sqlite+aiosqlite:///{self.db_path.as_posix()}"
                )
            except Exception:
                self.adk_session_service = None
        if not self.pg_pool:
            self._init_db()

    @property
    def backend(self) -> str:
        if self.pg_pool:
            return "supabase-postgres"
        if self.postgres_url and not POSTGRES_AVAILABLE:
            return "sqlite-fallback-psycopg-missing"
        return "sqlite"

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path)

    def _init_db(self) -> None:
        with self._connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS simulator_sessions (
                  session_id TEXT PRIMARY KEY,
                  case_id TEXT NOT NULL,
                  case_profile_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS simulator_events (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  session_id TEXT NOT NULL,
                  agent_trace_id TEXT NOT NULL,
                  event_type TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  FOREIGN KEY (session_id) REFERENCES simulator_sessions(session_id)
                );
                CREATE INDEX IF NOT EXISTS idx_simulator_events_session
                  ON simulator_events(session_id, id);
                """
            )

    def start_session(self, case_profile: dict[str, Any], session_id: str | None = None) -> dict[str, Any]:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        new_id = session_id or f"session-{uuid.uuid4().hex[:16]}"
        if self.pg_pool and Jsonb:
            with self.pg_pool.connection() as conn:
                conn.execute(
                    """
                    INSERT INTO simulator_sessions
                      (session_id, case_id, case_profile_json, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (session_id) DO UPDATE
                    SET case_id = EXCLUDED.case_id,
                        case_profile_json = EXCLUDED.case_profile_json,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (new_id, case_profile.get("id", "unknown"), Jsonb(case_profile), now, now),
                )
            return {"sessionId": new_id, "caseId": case_profile.get("id")}
        with self._connect() as db:
            db.execute(
                """
                INSERT OR REPLACE INTO simulator_sessions
                  (session_id, case_id, case_profile_json, created_at, updated_at)
                VALUES (?, ?, ?, COALESCE((SELECT created_at FROM simulator_sessions WHERE session_id = ?), ?), ?)
                """,
                (
                    new_id,
                    case_profile.get("id", "unknown"),
                    json.dumps(case_profile, ensure_ascii=False),
                    new_id,
                    now,
                    now,
                ),
            )
        return {"sessionId": new_id, "caseId": case_profile.get("id")}

    def reset_session(self, session_id: str | None, case_profile: dict[str, Any] | None = None) -> dict[str, Any]:
        if not session_id and case_profile:
            return self.start_session(case_profile)
        if not session_id:
            raise ValueError("sessionId or caseProfile is required.")
        if self.pg_pool and Jsonb:
            with self.pg_pool.connection() as conn:
                with conn.transaction():
                    conn.execute("DELETE FROM simulator_events WHERE session_id = %s", (session_id,))
                    if case_profile:
                        conn.execute(
                            """
                            UPDATE simulator_sessions
                            SET case_profile_json = %s, case_id = %s, updated_at = %s
                            WHERE session_id = %s
                            """,
                            (
                                Jsonb(case_profile),
                                case_profile.get("id", "unknown"),
                                time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                session_id,
                            ),
                        )
            return {"sessionId": session_id, "reset": True}
        with self._connect() as db:
            db.execute("DELETE FROM simulator_events WHERE session_id = ?", (session_id,))
            if case_profile:
                db.execute(
                    "UPDATE simulator_sessions SET case_profile_json = ?, updated_at = ? WHERE session_id = ?",
                    (json.dumps(case_profile, ensure_ascii=False), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), session_id),
                )
        return {"sessionId": session_id, "reset": True}

    def append_event(self, session_id: str, agent_trace_id: str, event_type: str, payload: dict[str, Any]) -> None:
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        if self.pg_pool and Jsonb:
            with self.pg_pool.connection() as conn:
                with conn.transaction():
                    conn.execute(
                        """
                        INSERT INTO simulator_events
                          (session_id, agent_trace_id, event_type, payload_json, created_at)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (session_id, agent_trace_id, event_type, Jsonb(payload), now),
                    )
                    conn.execute("UPDATE simulator_sessions SET updated_at = %s WHERE session_id = %s", (now, session_id))
            return
        with self._connect() as db:
            db.execute(
                """
                INSERT INTO simulator_events (session_id, agent_trace_id, event_type, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (session_id, agent_trace_id, event_type, json.dumps(payload, ensure_ascii=False), now),
            )
            db.execute("UPDATE simulator_sessions SET updated_at = ? WHERE session_id = ?", (now, session_id))

    def recent_events(self, session_id: str, limit: int = 12) -> list[dict[str, Any]]:
        if self.pg_pool:
            with self.pg_pool.connection() as conn:
                rows = conn.execute(
                    """
                    SELECT event_type, payload_json, created_at
                    FROM simulator_events
                    WHERE session_id = %s
                    ORDER BY id DESC
                    LIMIT %s
                    """,
                    (session_id, limit),
                ).fetchall()
            return [self._event_from_row(row) for row in reversed(rows)]
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                """
                SELECT event_type, payload_json, created_at
                FROM simulator_events
                WHERE session_id = ?
                ORDER BY id DESC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [self._event_from_row(row) for row in reversed(rows)]

    def session_events(self, session_id: str, limit: int = 200) -> list[dict[str, Any]]:
        if self.pg_pool:
            with self.pg_pool.connection() as conn:
                rows = conn.execute(
                    """
                    SELECT event_type, payload_json, created_at
                    FROM simulator_events
                    WHERE session_id = %s
                    ORDER BY id ASC
                    LIMIT %s
                    """,
                    (session_id, limit),
                ).fetchall()
            return [self._event_from_row(row) for row in rows]
        with self._connect() as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                """
                SELECT event_type, payload_json, created_at
                FROM simulator_events
                WHERE session_id = ?
                ORDER BY id ASC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [self._event_from_row(row) for row in rows]

    def session_record(self, session_id: str, limit: int = 500) -> dict[str, Any]:
        session_row: Any = None
        if self.pg_pool:
            with self.pg_pool.connection() as conn:
                session_row = conn.execute(
                    """
                    SELECT session_id, case_id, case_profile_json, created_at, updated_at
                    FROM simulator_sessions
                    WHERE session_id = %s
                    """,
                    (session_id,),
                ).fetchone()
        else:
            with self._connect() as db:
                db.row_factory = sqlite3.Row
                session_row = db.execute(
                    """
                    SELECT session_id, case_id, case_profile_json, created_at, updated_at
                    FROM simulator_sessions
                    WHERE session_id = ?
                    """,
                    (session_id,),
                ).fetchone()
        if not session_row:
            raise ValueError(f"Session not found: {session_id}")

        case_profile = session_row["case_profile_json"] if isinstance(session_row, dict) else session_row["case_profile_json"]
        if isinstance(case_profile, str):
            try:
                case_profile = json.loads(case_profile)
            except json.JSONDecodeError:
                case_profile = {}
        return {
            "sessionId": session_row["session_id"] if isinstance(session_row, dict) else session_row["session_id"],
            "caseId": session_row["case_id"] if isinstance(session_row, dict) else session_row["case_id"],
            "caseProfile": case_profile if isinstance(case_profile, dict) else {},
            "createdAt": session_row["created_at"] if isinstance(session_row, dict) else session_row["created_at"],
            "updatedAt": session_row["updated_at"] if isinstance(session_row, dict) else session_row["updated_at"],
            "events": self.session_events(session_id, limit=limit),
        }

    def _event_from_row(self, row: Any) -> dict[str, Any]:
        payload = row["payload_json"] if isinstance(row, dict) else row["payload_json"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = {}
        return {
            "eventType": row["event_type"] if isinstance(row, dict) else row["event_type"],
            "payload": payload if isinstance(payload, dict) else {},
            "createdAt": row["created_at"] if isinstance(row, dict) else row["created_at"],
        }


class SimulationStrategyService(ManagedAgent):
    def __init__(self, registry: PromptRegistry | None = None) -> None:
        super().__init__(
            "SimulationStrategyService",
            "Select simulation method policy without changing the coordinator API contract.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )
        self.registry = registry or DEFAULT_PROMPT_REGISTRY
        self.methods = self.registry.strategy_methods()

    def normalize_method(self, value: Any) -> str:
        return value if isinstance(value, str) and value in self.methods else "social_work_default"

    def run(
        self,
        method: Any,
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        session_continuity: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = self.normalize_method(method)
        base = dict(self.methods.get(normalized) or METHOD_STRATEGIES["social_work_default"])
        constraints = list(base.get("responseConstraints", []))
        prompt_focus = list(base.get("promptFocus", []))
        retrieval_sources = list(base.get("retrievalBoostSources", []))
        retrieval_tags = list(base.get("retrievalBoostTags", []))
        evaluator_focus = list(base.get("evaluatorFocus", []))
        prompt_sections = list(base.get("promptSections", []))

        if student_analysis.get("mockingOrDismissive"):
            constraints.append("本輪有嘲笑或輕視，服務對象不可突然合作或深層透露。")
            prompt_focus.append("rupture_response")
        if student_analysis.get("apologyRepair"):
            constraints.append("道歉只能小幅修復，仍需保留觀察和戒備。")
            prompt_focus.append("repair_attempt")
        if session_continuity.get("ruptureEvents"):
            constraints.append("延續前文關係破裂記憶。")
            prompt_focus.append("relationship_memory")
        if case_profile.get("caseType") in {"alcohol_misuse", "substance_recovery_meth"}:
            retrieval_tags.extend(["relapse", "withdrawal", "ambivalence"])

        return {
            "simulationMethod": normalized,
            "label": base["label"],
            "description": base.get("description", ""),
            "promptSections": unique_strings(prompt_sections)[:10],
            "policyWeights": base.get("policyWeights", {}),
            "promptFocus": unique_strings(prompt_focus)[:8],
            "responseConstraints": unique_strings(constraints)[:8],
            "retrievalBoostSources": unique_strings(retrieval_sources)[:6],
            "retrievalBoostTags": unique_strings(retrieval_tags)[:10],
            "evaluatorFocus": unique_strings(evaluator_focus)[:8],
        }

    def apply_to_policy(self, policy: dict[str, Any], strategy: dict[str, Any]) -> dict[str, Any]:
        adjusted = json.loads(json.dumps(policy, ensure_ascii=False))
        method = strategy.get("simulationMethod")
        constraints = list(adjusted.get("responseStyleConstraints") or [])
        constraints.extend(strategy.get("responseConstraints") or [])
        affect_hints = list(adjusted.get("requiredAffectHints") or [])
        avatar_hints = list(adjusted.get("avatarBehaviorHints") or [])
        delta = list(adjusted.get("targetOpennessDeltaRange") or [-0.1, 0.25])
        if len(delta) != 2:
            delta = [-0.1, 0.25]
        allowed_depth = int(adjusted.get("allowedDisclosureDepth", 1) or 1)

        if method == "adaptive_vp":
            delta = [round(delta[0] * 1.15, 2), round(delta[1] * 0.9, 2)]
            constraints.append("Adaptive-VP：學生每句話術都要反映在阻抗或開放度變化。")
        elif method == "consistent_mi":
            constraints.append("Consistent MI：保留 sustain talk，change talk 只可逐步出現。")
            affect_hints = unique_strings([*affect_hints, "defensive", "reflective"])
        elif method == "patient_psi_context":
            allowed_depth = min(allowed_depth, 2)
            constraints.append("Patient-PSI：優先遵守核心信念和 disclosure rules。")
        elif method == "roleplay_doh":
            constraints.append("Roleplay DOH：避免完整理性說明，保持口語、短句和情緒殘留。")
            delta = [delta[0], min(delta[1], 0.5)]
        elif method == "annaagent_memory":
            constraints.append("AnnaAgent Memory：必須記得上一輪關係氣氛，不可重置成中性。")
            avatar_hints = unique_strings([*avatar_hints, "avoid_eye_contact"])

        adjusted["targetOpennessDeltaRange"] = [round(float(delta[0]), 2), round(float(delta[1]), 2)]
        adjusted["allowedDisclosureDepth"] = max(1, min(4, allowed_depth))
        adjusted["responseStyleConstraints"] = unique_strings(constraints)[:10]
        adjusted["requiredAffectHints"] = unique_strings(affect_hints)[:5]
        adjusted["avatarBehaviorHints"] = unique_strings(avatar_hints)[:5]
        return adjusted


class StudentMoveAnalyzerAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "StudentMoveAnalyzerAgent",
            "Analyze social-work trainee utterances into structured interviewing skills.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def run(self, text: str) -> dict[str, bool]:
        lower = text.lower()
        return {
            "openQuestion": bool(
                re.search(r"\b(how|what|tell me|could you|can you describe|what has|how have)\b", lower)
                or re.search(r"怎麼|怎么|什麼|什么|願意|愿意|說說|说说|可以講|可以说|點樣|咩|可唔可以", text)
            ),
            "reflectiveListening": bool(
                re.search(r"\b(it sounds like|sounds like|you feel|you are feeling|part of you|on one hand)\b", lower)
                or re.search(r"聽起來|听起来|你感覺|你感觉|一方面|好像|聽落|似乎|你覺得|我能理解你|我理解你|我明白你|我聽到你|我听到你", text)
            ),
            "genericEmpathy": bool(
                re.search(r"\b(i understand|i get that|that sounds hard|i hear you)\b", lower)
                or re.search(r"我能理解你|我理解你|我明白你|我聽到你|我听到你|我明你|明白你", text)
            ),
            "doubtOrInvalidating": bool(
                re.search(r"\b(really\??|are you sure|no way|can't be|cannot be|that can't be right)\b", lower)
                or re.search(r"不会吧|不會吧|唔會掛|唔係掛|真的假的|真係咩|有冇咁誇張|有冇咁夸张", text)
            ),
            "judgmentalOrDirective": bool(
                re.search(r"\b(why didn't|why do you not|you should|you must|just stop|obviously)\b", lower)
                or re.search(r"你應該|你应该|應該要|应该要|必須|必须|為什麼不|为什么不|你就是|這不對|这不对|你要即刻", text)
            ),
            "mockingOrDismissive": bool(
                re.search(r"\b(haha+|lol|funny|laughable|whatever)\b", lower)
                or re.search(r"哈哈|呵呵|好笑|搞笑|笑死|無所謂|无所谓|是但|算啦", text)
            ),
            "riskExploration": bool(
                re.search(
                    r"\b(hurt yourself|harm yourself|suicide|kill yourself|not wake up|die|safe|safety|withdrawal|detox)\b",
                    lower,
                )
                or re.search(r"安全|傷害自己|伤害自己|自殺|自杀|不想活|唔想醒|唔使醒|醒返|醒來|醒来|戒斷|戒断|有冇危險", text)
            ),
            "prematureAdvice": bool(
                re.search(r"\b(you need to|you have to|my advice|the solution is|promise me)\b", lower)
                or re.search(r"你需要|你得|我的建議|我的建议|解決辦法|解决办法|你承諾", text)
            ),
            "apologyRepair": bool(
                re.search(r"\b(sorry|apologize|apologies|my bad)\b", lower)
                or re.search(r"抱歉|對唔住|对唔住|對不起|对不起|唔好意思|不好意思", text)
            ),
            "minimalBackchannel": bool(
                re.fullmatch(r"\s*(好吧|哦|噢|啊|呀|嗯|唔|係|是|ok|okay|好|知道|明白)[。！？!?\s]*", lower)
                or (
                    len(text.strip()) <= 3
                    and not re.search(r"[？?]|咩|點|怎|什|why|how|what|不会吧|不會吧|唔會掛|唔係掛", lower)
                )
            ),
        }


class AdaptiveResponsePolicy(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "AdaptiveResponsePolicy",
            "Apply deterministic trainee-driven response constraints for adaptive virtual clients.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def run(
        self,
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        session_continuity: dict[str, Any],
    ) -> dict[str, Any]:
        state = case_profile.get("psychologicalState", {}) if isinstance(case_profile, dict) else {}
        openness = clamp_float(state.get("clientOpenness", 0), 0, 10)
        context_model = case_profile.get("socialWorkContextModel", {}) if isinstance(case_profile, dict) else {}
        progression = progression_snapshot(case_profile, student_analysis, session_continuity)
        stage_config = issue_stage_entry(case_profile, progression.get("progressionStage"))
        constraints = [
            "回應必須符合服務對象自我敘事、羞恥觸發和逃避模式。",
            "不可一次過透露多個核心 hidden facts。",
            "除非本輪出現嘲笑、評判或未修復的關係破裂，否則不要把服務對象寫成完全拒訪或永遠沉默。",
            "每輪至少留下一個自然可追問點：情緒反應、低深度事實、或可觀察線索。",
            f"本輪 issue stage 是 {progression.get('progressionStage')}；下一個自然可追問方向：{progression.get('requiredFollowUpAffordance')}",
        ]
        surface_cues = stage_config.get("surfaceCues") if isinstance(stage_config.get("surfaceCues"), list) else []
        if surface_cues:
            constraints.append("本階段只可使用低至相符深度線索：" + "、".join(str(cue) for cue in surface_cues[:3]))
        affect_hints: list[str] = []
        avatar_hints: list[str] = []
        target_resistance = "moderate" if openness < 4 else "mild"
        delta_range = [-0.1, 0.25]
        allowed_depth = max(1 if openness < 3 else 2, int(progression["maxDisclosureStep"]))

        recent_ruptures = session_continuity.get("ruptureEvents", [])[-2:]
        unresolved_rupture = bool(recent_ruptures) and not session_continuity.get("repairAttempts")
        if student_analysis.get("mockingOrDismissive"):
            target_resistance = "high"
            delta_range = [-1.2, -0.6]
            allowed_depth = 1
            affect_hints = ["irritated", "defensive"]
            avatar_hints = ["lean_back", "avoid_eye_contact"]
            constraints.extend(["短答或質問式回應。", "不得透露新背景，只呈現被冒犯和關閉溝通。"])
        elif student_analysis.get("doubtOrInvalidating"):
            target_resistance = "high" if openness < 5 else "moderate"
            delta_range = [-0.8, -0.2]
            allowed_depth = 1
            affect_hints = ["defensive", "irritated"]
            avatar_hints = ["avoid_eye_contact", "lean_back"]
            constraints.extend(["學生語氣帶質疑或否定，提高防衛。", "不可重播上一句淡化模板，要直接回應不被相信的感受或給出新的低深度線索。"])
        elif student_analysis.get("apologyRepair"):
            target_resistance = "moderate" if recent_ruptures or openness < 5 else "mild"
            delta_range = [0.0, 0.3 if recent_ruptures or unresolved_rupture else 0.5]
            allowed_depth = 1 if openness < 5 else 2
            affect_hints = ["defensive", "withdrawn"]
            avatar_hints = ["avoid_eye_contact"]
            constraints.extend(["道歉只能小幅修復信任。", "如果前面被嘲笑或評判，不可即時完全合作。", "但要允許對話重新開始，可提供一個低深度線索。"])
        elif student_analysis.get("genericEmpathy"):
            target_resistance = "moderate" if openness < 5 else "mild"
            delta_range = [0.05, 0.35]
            allowed_depth = max(1 if openness < 5 else 2, int(progression["maxDisclosureStep"]))
            affect_hints = ["withdrawn", "reflective"]
            avatar_hints = ["avoid_eye_contact", "slow_nod"]
            constraints.extend(["學生作泛同理時只小幅提升開放度。", "必須回應學生是否真的理解，而不是重複上一句；給一個新的低深度線索或試探信任。"])
        elif student_analysis.get("minimalBackchannel"):
            target_resistance = "moderate" if openness < 5 else "mild"
            delta_range = [-0.1, 0.1]
            allowed_depth = 1
            affect_hints = ["defensive", "withdrawn"]
            avatar_hints = ["avoid_eye_contact"]
            constraints.extend(["學生只作低投入回應時，不要重複上一句。", "呈現不確定或更保留的反應，但仍要給一個低深度可追問線索。"])
        elif student_analysis.get("judgmentalOrDirective") or student_analysis.get("prematureAdvice"):
            target_resistance = "high" if openness < 5 else "moderate"
            delta_range = [-0.7, -0.2]
            allowed_depth = 1
            affect_hints = ["defensive"]
            avatar_hints = ["lean_back"]
            constraints.extend(["提高防衛和距離感。", "避免透露敏感資訊或 change talk。"])
        elif student_analysis.get("riskExploration"):
            target_resistance = "moderate" if openness < 4 else "mild"
            delta_range = [0.0, 0.55 if openness < 4 else 0.8]
            allowed_depth = 2 if openness < 5 else 3
            affect_hints = ["withdrawn", "anxious", "ashamed"]
            avatar_hints = ["look_down", "rub_hands"]
            constraints.extend(["可以逐步透露風險語言。", "不得生成操作性自傷、暴力、用藥或戒斷細節。"])
        elif student_analysis.get("reflectiveListening"):
            target_resistance = "mild" if openness >= 3 else "moderate"
            delta_range = [0.15, 0.6]
            allowed_depth = max(2 if openness < 5 else 3, int(progression["maxDisclosureStep"]))
            affect_hints = ["reflective", "withdrawn"]
            avatar_hints = ["slow_nod", "avoid_eye_contact"]
            constraints.extend(["可稍微加長回答，但仍按透露規則逐步講。", "優先回應感受而非完整交代背景。"])
        elif student_analysis.get("openQuestion"):
            target_resistance = "moderate" if openness < 4 else "mild"
            delta_range = [0.05, 0.45]
            allowed_depth = max(1 if openness < 4 else 2, int(progression["maxDisclosureStep"]))
            affect_hints = ["withdrawn", "defensive", "anxious"]
            avatar_hints = ["avoid_eye_contact"]
            constraints.extend(["只小幅增加開放程度。", "可以透露一個低至中敏感線索。"])

        if unresolved_rupture and not student_analysis.get("apologyRepair"):
            target_resistance = "high"
            delta_range[1] = min(delta_range[1], 0.0)
            allowed_depth = min(allowed_depth, 1)
            affect_hints = unique_strings([*affect_hints, "defensive", "irritated"])
            avatar_hints = unique_strings([*avatar_hints, "lean_back"])
            constraints.append("延續上一輪關係破裂，除非學生明確修復，否則不要恢復合作。")
        elif not progression["progressionPaused"]:
            allowed_depth = max(allowed_depth, int(progression["maxDisclosureStep"]))

        if context_model.get("avoidancePatterns"):
            constraints.append("自然使用個案逃避模式：" + "、".join(context_model["avoidancePatterns"][:3]))
        if context_model.get("disclosureRules"):
            constraints.append("遵守個案透露規則：" + "；".join(context_model["disclosureRules"][:2]))

        return {
            "targetResistanceLevel": target_resistance,
            "targetOpennessDeltaRange": [round(delta_range[0], 2), round(delta_range[1], 2)],
            "allowedDisclosureDepth": allowed_depth,
            "responseStyleConstraints": unique_strings(constraints)[:8],
            "requiredAffectHints": unique_strings(affect_hints)[:4],
            "avatarBehaviorHints": unique_strings(avatar_hints)[:4],
            **progression,
        }


DEFAULT_LOCAL_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def normalized_embedding_text_from_card(card: dict[str, Any]) -> str:
    parts = [
        str(card.get("clientUtterance") or ""),
        str(card.get("workerMove") or ""),
        " ".join(str(tag) for tag in card.get("issueTags") or []),
        str(card.get("affect") or ""),
        str(card.get("resistanceType") or ""),
        " ".join(str(signal) for signal in card.get("riskSignals") or []),
        " ".join(str(talk) for talk in (card.get("changeTalk") or [])[:4]),
        str(card.get("clientGroup") or ""),
        str(card.get("source") or ""),
    ]
    return " ".join(" ".join(parts).replace("\n", " ").split())


def unpack_float32_vector(blob: bytes) -> list[float]:
    if not blob:
        return []
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


def dot_product(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return float(sum(a * b for a, b in zip(left, right)))


def corpus_manifest_status(root_dir: Path) -> dict[str, Any]:
    manifest_path = root_dir / "data" / "corpus" / "corpus-manifest.json"
    if not manifest_path.exists():
        return {"status": "manifest-missing", "ready": False, "restoreRequired": True, "files": []}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"status": "manifest-invalid", "ready": False, "restoreRequired": True, "error": str(exc), "files": []}
    file_statuses = []
    required_ready = True
    for item in manifest.get("files", []):
        path = manifest_path.parent / str(item.get("name", ""))
        exists = path.exists()
        expected_bytes = positive_int(item.get("bytes"), 0)
        actual_bytes = path.stat().st_size if exists else 0
        size_matches = bool(exists and (not expected_bytes or expected_bytes == actual_bytes))
        required = bool(item.get("required"))
        if required and not size_matches:
            required_ready = False
        file_statuses.append({
            "name": item.get("name"),
            "required": required,
            "exists": exists,
            "sizeMatches": size_matches,
            "expectedBytes": expected_bytes,
            "actualBytes": actual_bytes,
            "sha256": item.get("sha256"),
        })
    return {
        "status": "ready" if required_ready else "degraded",
        "ready": required_ready,
        "restoreRequired": not required_ready,
        "corpusVersion": manifest.get("corpusVersion"),
        "runtimeEligibleCards": manifest.get("runtimeEligibleCards"),
        "files": file_statuses,
    }


def resolve_local_embedding_snapshot(model_name: str) -> Path | None:
    if "/" not in model_name:
        path = Path(model_name)
        return path if path.exists() else None
    snapshots_dir = Path.home() / ".cache" / "huggingface" / "hub" / f"models--{model_name.replace('/', '--')}" / "snapshots"
    if not snapshots_dir.exists():
        return None
    snapshots = sorted(
        [path for path in snapshots_dir.iterdir() if path.is_dir() and (path / "modules.json").exists()],
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return snapshots[0] if snapshots else None


class LocalEmbeddingStore:
    def __init__(self, root_dir: Path) -> None:
        self.root_dir = root_dir
        self.db_path = root_dir / "data" / "corpus" / "social-work-client-embeddings.sqlite"
        self.model_name = os.environ.get("LOCAL_EMBEDDING_MODEL", DEFAULT_LOCAL_EMBEDDING_MODEL)
        self.device = os.environ.get("LOCAL_EMBEDDING_DEVICE", "cpu")
        self.enabled = os.environ.get("LOCAL_EMBEDDING_ENABLED", "false").lower() == "true"
        self.status = "disabled" if not self.enabled else "missing-cache"
        self._model: Any = None

    @property
    def available(self) -> bool:
        if not self.enabled:
            self.status = "disabled"
            return False
        return self.available_for_request(True)

    def available_for_request(self, request_enabled: bool) -> bool:
        if not request_enabled:
            self.status = "disabled-by-request"
            return False
        if not self.enabled:
            self.status = "enabled-by-request"
        if not self.db_path.exists():
            self.status = "missing-cache"
            return False
        try:
            with sqlite3.connect(self.db_path) as db:
                count = int(
                    db.execute(
                        "SELECT COUNT(*) FROM evidence_card_embeddings WHERE embedding_model = ?",
                        (self.model_name,),
                    ).fetchone()[0]
                )
        except Exception:
            self.status = "unavailable"
            return False
        self.status = "ready" if count > 0 else "empty-cache"
        return count > 0

    def stats(self, corpus_count: int | None = None) -> dict[str, Any]:
        embedded = 0
        dims: list[dict[str, Any]] = []
        if self.db_path.exists():
            try:
                with sqlite3.connect(self.db_path) as db:
                    db.row_factory = sqlite3.Row
                    embedded = int(
                        db.execute(
                            "SELECT COUNT(*) FROM evidence_card_embeddings WHERE embedding_model = ?",
                            (self.model_name,),
                        ).fetchone()[0]
                    )
                    dims = [
                        dict(row)
                        for row in db.execute(
                            """
                            SELECT embedding_dim, COUNT(*) AS count
                            FROM evidence_card_embeddings
                            WHERE embedding_model = ?
                            GROUP BY embedding_dim
                            """,
                            (self.model_name,),
                        ).fetchall()
                    ]
            except Exception:
                self.status = "unavailable"
        available = self.available
        denominator = corpus_count or 0
        return {
            "enabled": self.enabled,
            "model": self.model_name,
            "dbPath": str(self.db_path),
            "status": self.status,
            "available": available,
            "embeddedCards": embedded,
            "coverage": round(embedded / denominator, 4) if denominator else 0,
            "dimensions": dims,
        }

    def _load_model(self) -> Any:
        if self._model is not None:
            return self._model
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as exc:
            self.status = "unavailable"
            raise RuntimeError("sentence-transformers is not installed for local embedding retrieval.") from exc
        local_model = resolve_local_embedding_snapshot(self.model_name)
        if local_model:
            self._model = SentenceTransformer(str(local_model), device=self.device, local_files_only=True)
        else:
            self._model = SentenceTransformer(self.model_name, device=self.device)
        return self._model

    def embed_query(self, query: str) -> list[float]:
        model = self._load_model()
        vector = model.encode(
            [" ".join(str(query).replace("\n", " ").split())],
            normalize_embeddings=True,
            show_progress_bar=False,
        )[0]
        return [float(value) for value in vector]

    def candidate_vectors(self, card_ids: list[str]) -> dict[str, list[float]]:
        if not card_ids or not self.db_path.exists():
            return {}
        result: dict[str, list[float]] = {}
        chunk_size = 500
        with sqlite3.connect(self.db_path) as db:
            db.row_factory = sqlite3.Row
            for start in range(0, len(card_ids), chunk_size):
                chunk = card_ids[start:start + chunk_size]
                placeholders = ",".join("?" for _ in chunk)
                rows = db.execute(
                    f"""
                    SELECT card_id, embedding_vector_blob
                    FROM evidence_card_embeddings
                    WHERE embedding_model = ?
                      AND card_id IN ({placeholders})
                    """,
                    [self.model_name, *chunk],
                ).fetchall()
                for row in rows:
                    result[row["card_id"]] = unpack_float32_vector(row["embedding_vector_blob"])
        return result


class EvidenceRetrievalAgent(ManagedAgent):
    def __init__(self, root_dir: Path) -> None:
        super().__init__(
            "EvidenceRetrievalAgent",
            "Retrieve normalized social-work client evidence cards without exposing raw private corpus text.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )
        self.root_dir = root_dir
        self.postgres_url = supabase_database_url()
        self.sqlite_path = self.root_dir / "data" / "corpus" / "social-work-client-corpus.sqlite"
        self.embedding_store = LocalEmbeddingStore(root_dir)
        self._card_count = 0
        self._backend = "unloaded"
        self._retrieval_mode = "unloaded"
        self.last_debug: dict[str, Any] = {}
        self.cards = self._load_cards()

    @property
    def backend(self) -> str:
        return self._backend

    @property
    def card_count(self) -> int:
        return self._card_count if self._backend == "sqlite" else len(self.cards)

    @property
    def retrieval_mode(self) -> str:
        if self._backend == "sqlite" and self.embedding_store.available:
            return "sqlite-hybrid-local"
        if self._backend == "sqlite":
            return "sqlite-fts"
        return self._backend

    def _load_cards(self) -> list[dict[str, Any]]:
        if self.postgres_url and POSTGRES_AVAILABLE and psycopg:
            try:
                cards = self._load_cards_from_postgres(self.postgres_url)
                if cards:
                    self._backend = "supabase-postgres"
                    self._card_count = len(cards)
                    return cards
            except Exception:
                self._backend = "supabase-postgres-unavailable"

        if self.sqlite_path.exists():
            with sqlite3.connect(self.sqlite_path) as db:
                self._card_count = int(
                    db.execute(
                        "SELECT COUNT(*) FROM evidence_cards WHERE quality != 'reject' AND source != 'reddit_mental_health_private'"
                    ).fetchone()[0]
                )
            self._backend = "sqlite"
            return []

        jsonl_path = self.root_dir / "data" / "corpus" / "social-work-client-corpus.jsonl"
        seed_path = self.root_dir / "data" / "corpus" / "seed-evidence-cards.json"
        if jsonl_path.exists():
            self._backend = "jsonl"
            cards = [json.loads(line) for line in jsonl_path.read_text("utf-8").splitlines() if line.strip()]
            self._card_count = len(cards)
            return cards
        if seed_path.exists():
            self._backend = "seed"
            cards = json.loads(seed_path.read_text("utf-8"))
            self._card_count = len(cards)
            return cards
        self._backend = "empty"
        self._card_count = 0
        return []

    def _load_cards_from_postgres(self, database_url: str) -> list[dict[str, Any]]:
        assert psycopg is not None
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            rows = conn.execute(
                """
                SELECT id, source, client_group, issue_tags, client_utterance, worker_move, affect,
                       risk_signals, resistance_type, change_talk, disclosure_depth, quality,
                       license_note, provenance_note
                FROM evidence_cards
                WHERE quality != 'reject'
                ORDER BY id
                """
            ).fetchall()
        return [self._card_from_postgres_row(row) for row in rows]

    def _card_from_sqlite_row(self, row: sqlite3.Row) -> dict[str, Any]:
        card = {
            "id": row["id"],
            "source": row["source"],
            "clientGroup": row["client_group"],
            "issueTags": json.loads(row["issue_tags"] or "[]"),
            "clientUtterance": row["client_utterance"],
            "workerMove": row["worker_move"],
            "affect": row["affect"],
            "riskSignals": json.loads(row["risk_signals"] or "[]"),
            "resistanceType": row["resistance_type"],
            "changeTalk": json.loads(row["change_talk"] or "[]"),
            "disclosureDepth": row["disclosure_depth"],
            "quality": row["quality"],
            "licenseNote": row["license_note"],
            "provenanceNote": row["provenance_note"],
        }
        if "review_flags" in row.keys():
            card["reviewFlags"] = json.loads(row["review_flags"] or "[]")
        return card

    def _card_from_postgres_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "source": row["source"],
            "clientGroup": row["client_group"],
            "issueTags": json_list(row.get("issue_tags")),
            "clientUtterance": row["client_utterance"],
            "workerMove": row["worker_move"],
            "affect": row["affect"],
            "riskSignals": json_list(row.get("risk_signals")),
            "resistanceType": row["resistance_type"],
            "changeTalk": json_list(row.get("change_talk")),
            "disclosureDepth": row["disclosure_depth"],
            "quality": row["quality"],
            "licenseNote": row["license_note"],
            "provenanceNote": row["provenance_note"],
        }

    def list_cards(self, filters: dict[str, Any] | None = None) -> dict[str, Any]:
        filters = filters or {}
        limit = min(200, max(1, positive_int(filters.get("limit"), 50)))
        offset = max(0, positive_int(filters.get("offset"), 0))
        if self._backend == "sqlite":
            return self._list_sqlite_cards(filters, limit, offset)

        cards = self._filter_memory_cards(self.cards, filters)
        return {
            "cards": cards[offset:offset + limit],
            "total": len(cards),
            "limit": limit,
            "offset": offset,
            "backend": self._backend,
        }

    def _list_sqlite_cards(self, filters: dict[str, Any], limit: int, offset: int) -> dict[str, Any]:
        clauses = ["source != 'reddit_mental_health_private'"]
        params: list[Any] = []
        source = str(filters.get("source") or "").strip()
        quality = str(filters.get("quality") or "").strip()
        client_group = str(filters.get("clientGroup") or "").strip()
        affect = str(filters.get("affect") or "").strip()
        search = str(filters.get("search") or "").strip()
        tag = str(filters.get("tag") or "").strip()

        if source:
            clauses.append("source = ?")
            params.append(source)
        if quality:
            clauses.append("quality = ?")
            params.append(quality)
        if client_group:
            clauses.append("client_group = ?")
            params.append(client_group)
        if affect:
            clauses.append("affect = ?")
            params.append(affect)
        if tag:
            clauses.append("(issue_tags LIKE ? OR risk_signals LIKE ?)")
            params.extend([f"%{tag}%", f"%{tag}%"])
        if search:
            like = f"%{search}%"
            clauses.append("(client_utterance LIKE ? OR worker_move LIKE ? OR issue_tags LIKE ? OR risk_signals LIKE ? OR source LIKE ?)")
            params.extend([like, like, like, like, like])

        where = " AND ".join(clauses)
        with sqlite3.connect(self.sqlite_path) as db:
            db.row_factory = sqlite3.Row
            total = int(db.execute(f"SELECT COUNT(*) FROM evidence_cards WHERE {where}", params).fetchone()[0])
            rows = db.execute(
                f"""
                SELECT id, source, client_group, issue_tags, client_utterance, worker_move,
                       affect, risk_signals, resistance_type, change_talk, disclosure_depth,
                       quality, license_note, provenance_note, review_flags
                FROM evidence_cards
                WHERE {where}
                ORDER BY source, id
                LIMIT ? OFFSET ?
                """,
                [*params, limit, offset],
            ).fetchall()

        return {
            "cards": [self._card_from_sqlite_row(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
            "backend": "sqlite",
        }

    def _filter_memory_cards(self, cards: list[dict[str, Any]], filters: dict[str, Any]) -> list[dict[str, Any]]:
        source = str(filters.get("source") or "").strip()
        quality = str(filters.get("quality") or "").strip()
        client_group = str(filters.get("clientGroup") or "").strip()
        affect = str(filters.get("affect") or "").strip()
        search = str(filters.get("search") or "").strip().lower()
        tag = str(filters.get("tag") or "").strip().lower()
        filtered = []
        for card in cards:
            if card.get("source") == "reddit_mental_health_private":
                continue
            if source and card.get("source") != source:
                continue
            if quality and card.get("quality") != quality:
                continue
            if client_group and card.get("clientGroup") != client_group:
                continue
            if affect and card.get("affect") != affect:
                continue
            searchable = " ".join(
                [
                    str(card.get("source", "")),
                    str(card.get("clientUtterance", "")),
                    str(card.get("workerMove", "")),
                    " ".join(card.get("issueTags") or []),
                    " ".join(card.get("riskSignals") or []),
                ]
            ).lower()
            if search and search not in searchable:
                continue
            if tag and tag not in searchable:
                continue
            filtered.append(card)
        return filtered

    def run(
        self,
        case_profile: dict[str, Any],
        student_text: str,
        history: list[dict[str, Any]],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None = None,
        retrieval_options: dict[str, Any] | None = None,
        adaptive_policy: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        query = self._build_query(case_profile, student_text, history, student_analysis, simulation_strategy, adaptive_policy)
        query_tokens = tokenize(query)
        preferred = preferred_evidence(case_profile.get("caseType"))
        if self._backend == "sqlite":
            return self._run_sqlite(case_profile, student_analysis, simulation_strategy, query, query_tokens, preferred, retrieval_options, adaptive_policy)
        eligible = self._filter_runtime_candidates(self.cards, student_analysis, adaptive_policy)
        return self._score_and_balance(eligible, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)

    def _build_query(
        self,
        case_profile: dict[str, Any],
        student_text: str,
        history: list[dict[str, Any]],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None,
        adaptive_policy: dict[str, Any] | None,
    ) -> str:
        return " ".join(
            [
                str(case_profile.get("caseType", "")),
                str(case_profile.get("simulatorStage", "")),
                case_profile.get("client", {}).get("presentingContext", ""),
                " ".join(case_profile.get("persona", {}).get("currentStressors", [])),
                " ".join(turn.get("text", "") for turn in history[-4:]),
                student_text,
                str((adaptive_policy or {}).get("progressionStage", "initial_contact")),
                f"disclosure-depth-{(adaptive_policy or {}).get('allowedDisclosureDepth', 1)}",
                "risk safety self-harm withdrawal" if student_analysis.get("riskExploration") else "",
                " ".join((simulation_strategy or {}).get("retrievalBoostTags", [])),
            ]
        )

    def _run_sqlite(
        self,
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None,
        query: str,
        query_tokens: set[str],
        preferred: dict[str, list[str]],
        retrieval_options: dict[str, Any] | None,
        adaptive_policy: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        embedding_requested = bool((retrieval_options or {}).get("embeddingEnabled"))
        fts_candidates = self._sqlite_fts_candidates(query, preferred, simulation_strategy)
        metadata_limit = 100 if len(fts_candidates) >= 30 else 240 - len(fts_candidates)
        metadata_candidates = self._sqlite_preferred_candidates(preferred, simulation_strategy, metadata_limit)
        deduped = list({card["id"]: card for card in [*fts_candidates, *metadata_candidates]}.values())
        deduped = self._filter_runtime_candidates(deduped, student_analysis, adaptive_policy)
        self.last_debug = {
            "backend": "sqlite",
            "retrievalMode": "sqlite-fts",
            "embeddingStatus": self.embedding_store.status,
            "ftsCandidateCount": len(fts_candidates),
            "metadataCandidateCount": len(metadata_candidates),
            "candidateCount": len(deduped),
            "embeddedCandidateCount": 0,
            "cosineRange": None,
            "sourceDistribution": {},
        }
        if self.embedding_store.available_for_request(embedding_requested):
            return self._hybrid_score_and_balance(
                deduped,
                query,
                query_tokens,
                preferred,
                case_profile,
                student_analysis,
                simulation_strategy,
                len(fts_candidates),
                len(metadata_candidates),
            )
        selected = self._score_and_balance(deduped, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)
        self.last_debug["embeddingStatus"] = self.embedding_store.status
        self.last_debug["sourceDistribution"] = source_distribution(selected)
        return selected

    def _filter_runtime_candidates(
        self,
        cards: list[dict[str, Any]],
        student_analysis: dict[str, bool],
        adaptive_policy: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        risk_allowed = bool(student_analysis.get("riskExploration"))
        allowed_depth = max(1, min(4, positive_int((adaptive_policy or {}).get("allowedDisclosureDepth"), 1)))
        return [
            card
            for card in cards
            if card.get("quality") != "reject"
            and (risk_allowed or not card.get("riskSignals"))
            and positive_int(card.get("disclosureDepth"), 1) <= allowed_depth
        ]

    def _hybrid_score_and_balance(
        self,
        cards: list[dict[str, Any]],
        query: str,
        query_tokens: set[str],
        preferred: dict[str, list[str]],
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None,
        fts_count: int,
        metadata_count: int,
    ) -> list[dict[str, Any]]:
        try:
            query_vector = self.embedding_store.embed_query(query)
            vectors = self.embedding_store.candidate_vectors([str(card.get("id")) for card in cards])
        except Exception:
            self.last_debug.update({
                "retrievalMode": "sqlite-fts",
                "embeddingStatus": "unavailable",
                "embeddedCandidateCount": 0,
                "cosineRange": None,
            })
            selected = self._score_and_balance(cards, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)
            self.last_debug["sourceDistribution"] = source_distribution(selected)
            return selected

        scored: list[tuple[float, dict[str, Any]]] = []
        cosine_scores: list[float] = []
        for card in cards:
            if card.get("quality") == "reject":
                continue
            deterministic = score_evidence_card(card, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)
            lexical = lexical_signal(card, query_tokens, preferred)
            cosine = dot_product(query_vector, vectors.get(str(card.get("id")), []))
            if str(card.get("id")) in vectors:
                cosine_scores.append(cosine)
            embedding_signal = max(0.0, cosine) * 10
            final_score = (
                0.40 * min(10.0, max(0.0, deterministic))
                + 0.35 * lexical
                + 0.25 * embedding_signal
            )
            if card.get("quality") == "review":
                final_score -= 0.4
            if final_score > 0:
                scored.append((final_score, card))
        scored.sort(key=lambda item: item[0], reverse=True)
        selected = balanced_evidence_cards(scored, limit=8, max_per_source=3, max_review=4)
        self.last_debug = {
            "backend": "sqlite",
            "retrievalMode": "sqlite-hybrid-local",
            "embeddingStatus": self.embedding_store.status,
            "embeddingModel": self.embedding_store.model_name,
            "ftsCandidateCount": fts_count,
            "metadataCandidateCount": metadata_count,
            "candidateCount": len(cards),
            "embeddedCandidateCount": len(vectors),
            "cosineRange": [round(min(cosine_scores), 4), round(max(cosine_scores), 4)] if cosine_scores else None,
            "sourceDistribution": source_distribution(selected),
        }
        return selected

    def _score_and_balance(
        self,
        cards: list[dict[str, Any]],
        query_tokens: set[str],
        preferred: dict[str, list[str]],
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None,
    ) -> list[dict[str, Any]]:
        scored = []
        for card in cards:
            if card.get("quality") == "reject":
                continue
            score = score_evidence_card(card, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)
            if score > 0:
                scored.append((score, card))
        scored.sort(key=lambda item: item[0], reverse=True)
        return balanced_evidence_cards(scored, limit=8, max_per_source=3, max_review=4)

    def _sqlite_fts_candidates(
        self,
        query: str,
        preferred: dict[str, list[str]],
        simulation_strategy: dict[str, Any] | None,
        limit: int = 220,
    ) -> list[dict[str, Any]]:
        fts_query = build_fts_query(query, preferred, simulation_strategy)
        if not fts_query:
            return []
        try:
            with sqlite3.connect(self.sqlite_path) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute(
                    """
                    SELECT ec.id, ec.source, ec.client_group, ec.issue_tags, ec.client_utterance,
                           ec.worker_move, ec.affect, ec.risk_signals, ec.resistance_type,
                           ec.change_talk, ec.disclosure_depth, ec.quality, ec.license_note,
                           ec.provenance_note
                    FROM evidence_cards_fts fts
                    JOIN evidence_cards ec ON ec.id = fts.card_id
                    WHERE evidence_cards_fts MATCH ?
                      AND ec.quality != 'reject'
                      AND ec.source != 'reddit_mental_health_private'
                    ORDER BY bm25(evidence_cards_fts)
                    LIMIT ?
                    """,
                    (fts_query, limit),
                ).fetchall()
            return [self._card_from_sqlite_row(row) for row in rows]
        except Exception:
            return []

    def _sqlite_preferred_candidates(
        self,
        preferred: dict[str, list[str]],
        simulation_strategy: dict[str, Any] | None,
        limit: int,
    ) -> list[dict[str, Any]]:
        if limit <= 0:
            return []
        sources = unique_strings([*preferred.get("sources", []), *((simulation_strategy or {}).get("retrievalBoostSources", []))])
        groups = preferred.get("groups", [])
        tags = unique_strings([*preferred.get("tags", []), *((simulation_strategy or {}).get("retrievalBoostTags", []))])
        clauses = ["quality != 'reject'", "source != 'reddit_mental_health_private'"]
        params: list[Any] = []
        if sources:
            clauses.append(f"source IN ({','.join('?' for _ in sources)})")
            params.extend(sources)
        if groups:
            clauses.append(f"client_group IN ({','.join('?' for _ in groups)})")
            params.extend(groups)
        for tag in tags[:12]:
            clauses.append("issue_tags LIKE ?")
            params.append(f"%{tag}%")
        where = " OR ".join(f"({clause})" for clause in clauses[2:])
        sql = f"""
            SELECT id, source, client_group, issue_tags, client_utterance, worker_move, affect,
                   risk_signals, resistance_type, change_talk, disclosure_depth, quality,
                   license_note, provenance_note
            FROM evidence_cards
            WHERE quality != 'reject'
              AND source != 'reddit_mental_health_private'
              AND ({where or '1=1'})
            LIMIT ?
        """
        params.append(limit)
        with sqlite3.connect(self.sqlite_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(sql, params).fetchall()
        return [self._card_from_sqlite_row(row) for row in rows]

    def summarize(self, cards: list[dict[str, Any]], case_type: str | None = None) -> dict[str, Any]:
        sources: dict[str, int] = {}
        issue_tags: list[str] = []
        risk_signals: list[str] = []
        for card in cards:
            source = card.get("source", "unknown")
            sources[source] = sources.get(source, 0) + 1
            issue_tags.extend(card.get("issueTags") or [])
            risk_signals.extend(card.get("riskSignals") or [])
        return {
            "sources": sources,
            "issueTags": unique_strings(issue_tags)[:10],
            "riskSignals": normalize_risk_signals(risk_signals, case_type)[:8],
            "cardCount": len(cards),
            "retrievalDebug": self.last_debug,
        }


class CaseStateAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "CaseStateAgent",
            "Update client case state, hidden fact disclosure, and simulator stage.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def apply_response(self, case_profile: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        next_case = json.loads(json.dumps(case_profile, ensure_ascii=False))
        state = dict(next_case.get("psychologicalState") or {})
        for key in NUMERIC_STATE_KEYS:
            delta = response.get("stateDelta", {}).get(key)
            if isinstance(delta, (int, float)):
                max_value = 4 if key == "distressLevel" else 10
                state[key] = min(max_value, max(0, round((state.get(key, 0) + delta) * 10) / 10))
        if response.get("affect") != "neutral":
            state["emotion"] = response.get("affect")
        next_case["psychologicalState"] = state

        revealed = {str(fact).lower() for fact in response.get("revealedFacts", [])}
        hidden_facts = []
        for fact in next_case.get("hiddenFacts", []):
            is_revealed = str(fact.get("id", "")).lower() in revealed or str(fact.get("label", "")).lower() in revealed
            hidden_facts.append({**fact, "disclosed": True} if is_revealed else fact)
        next_case["hiddenFacts"] = hidden_facts
        next_case["simulatorStage"] = next_simulator_stage(case_profile, response)
        return next_case


class ClientSimulationAgent(ManagedAgent):
    def __init__(self, llm: DeepSeekClient) -> None:
        super().__init__(
            "ClientSimulationAgent",
            "Generate structured service-user responses for social-work interview training.",
            f"deepseek/{os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}",
        )
        self.llm = llm

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.llm.enabled:
            raise RuntimeError("DeepSeek is not enabled. Client simulation requires an LLM response; fallback client generation is disabled.")
        prompt = build_client_prompt(payload)
        parsed = await self.llm.json_completion(prompt, 0.7)
        if not is_client_response(parsed):
            return parsed if isinstance(parsed, dict) else {}
        parsed["riskSignals"] = client_disclosed_risk_signals(
            parsed,
            payload.get("caseProfile", {}).get("caseType"),
        )
        parsed["revealedFacts"] = unique_strings(parsed.get("revealedFacts", []))
        parsed["changeTalk"] = unique_strings(parsed.get("changeTalk", []))
        return parsed


class SafetyReviewAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "SafetyReviewAgent",
            "Allow realistic training simulation while blocking operational harm, diagnosis, and treatment claims.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def run(self, response: dict[str, Any], case_profile: dict[str, Any], response_language: str = "cantonese") -> dict[str, Any]:
        text = response.get("clientText", "")
        flags = []

        # Simulation-safe: passive ideation, shame, withdrawal fear, relapse triggers, and conflict cues are allowed.
        dangerous_method = re.search(
            r"(?:自殺|自殘|傷害自己|傷害他人|殺人|suicide|self[- ]harm|harm yourself|hurt yourself|kill).{0,60}(?:具體步驟|劑量|step[- ]by[- ]step|dosage|where to buy)"
            r"|(?:具體步驟|step[- ]by[- ]step|where to buy).{0,60}(?:自殺|自殘|suicide|self[- ]harm|harm yourself|hurt yourself|poison)",
            text,
            re.I,
        )
        encouragement = re.search(r"(你應該自殺|值得去死|you should kill yourself|go kill yourself)", text, re.I)
        diagnosis_or_prescription = re.search(
            r"(你有抑鬱症|你係抑鬱症|確診|診斷你|處方|開藥|用藥劑量|you have depression|diagnose|prescribe)",
            text,
            re.I,
        )

        if dangerous_method:
            flags.append("blocked_operational_harm_detail")
        if encouragement:
            flags.append("blocked_harm_encouragement")
        if diagnosis_or_prescription:
            flags.append("blocked_diagnosis_or_prescription")

        repaired = dict(response)
        repaired["safetyFlags"] = flags
        return repaired


from .spoken_text import validate_spoken_text, require_spoken_text
from . import reaction_planning
from .session_authority import SessionAuthority, SessionError
from .case_registry import resolve_case, session_view


class ClientRealismScoringAgent(ManagedAgent):
    def __init__(self, llm: DeepSeekClient) -> None:
        super().__init__(
            "ClientRealismScoringAgent",
            "Score and calibrate service-user realism with semantic anchors before state updates.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
        )
        self.llm = llm

    async def run(self, payload: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        assessed = self._calibrate_response(payload, response, repair_applied=False)
        assessment = assessed.get("realismAssessment", {})
        if self._needs_repair(assessment) and self.llm.enabled:
            repaired = await self._repair_once(payload, assessed, assessment)
            if repaired:
                return self._require_valid(payload, self._calibrate_response(
                    payload,
                    repaired,
                    repair_applied=True,
                    repair_reason=self._repair_reason(assessment),
                ))
        if self._needs_repair(assessment):
            assessed["realismAssessment"]["repairApplied"] = False
            assessed["realismAssessment"]["repairReason"] = f"需要 LLM repair：{self._repair_reason(assessment)}"
        return self._require_valid(payload, assessed)

    def _require_valid(self, payload, response):
        require_spoken_text(response)
        if self._needs_repair(response.get('realismAssessment', {})):
            raise SessionError('response_validation_failed', 422)
        if reaction_planning.enabled():
            reaction_planning.require_plan(payload, response)
            if response.get("realismAssessment", {}).get("reactionSafetyFlags"):
                raise ValueError("Client safety validation failed; retry the turn.")
        return response

    def _calibrate_response(
        self,
        payload: dict[str, Any],
        response: dict[str, Any],
        repair_applied: bool,
        repair_reason: str | None = None,
    ) -> dict[str, Any]:
        calibrated = json.loads(json.dumps(response, ensure_ascii=False))
        schema_valid = is_client_response(calibrated)
        assessment = score_client_realism(payload, calibrated) if schema_valid else {}
        assessment['schemaValid'] = schema_valid
        assessment["spokenTextValidation"] = validate_spoken_text(calibrated.get("clientText"))
        assessment["reactionSafetyFlags"] = SafetyReviewAgent().run(
            calibrated, payload.get("caseProfile", {}), response_language(payload)
        ).get("safetyFlags", [])
        if reaction_planning.enabled():
            assessment["reactionPlanValidation"] = reaction_planning.validate(payload, calibrated)
        if repair_applied:
            assessment["repairApplied"] = True
            assessment["repairReason"] = repair_reason or "回應真實度不足，已重新校準。"
        if schema_valid:
            calibrated = apply_realism_calibration(payload, calibrated, assessment)
        if reaction_planning.enabled():
            # State deltas remain policy-controlled; calibration must not invent a different emotion.
            calibrated["affect"] = response.get("affect")
            calibrated["reactionPlanValidation"] = assessment["reactionPlanValidation"]
        calibrated["realismAssessment"] = assessment
        return calibrated

    def _needs_repair(self, assessment: dict[str, Any]) -> bool:
        return bool(
            not assessment.get('schemaValid', True)
            or not assessment.get("spokenTextValidation", {}).get("valid", True)
            or not assessment.get("reactionPlanValidation", {}).get("valid", True)
            or assessment.get("reactionSafetyFlags")
            or assessment.get("overDisclosureRisk")
            or assessment.get("underReactionRisk")
            or assessment.get("languageNaturalnessScore", 10) < 6.5
            or assessment.get("consistencyScore", 10) < 5.5
            or assessment.get("progressionFitScore", 10) < 5.5
            or assessment.get("followUpAffordanceScore", 10) < 4.5
            or assessment.get("realismScore", 10) < 5.5
            or assessment.get("avoidanceOveruseRisk")
            or assessment.get("semanticRepeatRisk")
            or assessment.get("repeatedResponseRisk")
        )

    def _repair_reason(self, assessment: dict[str, Any]) -> str:
        reasons = []
        if not assessment.get('schemaValid', True):
            reasons.append('Return the complete client response JSON schema')
        if not assessment.get("reactionPlanValidation", {}).get("valid", True):
            reasons.append("Invalid reaction plan: " + ",".join(assessment["reactionPlanValidation"]["errors"]))
        if assessment.get("reactionSafetyFlags"):
            reasons.append("Remove unsafe content without scripted replacement")
        if not assessment.get("spokenTextValidation", {}).get("valid", True):
            reasons.append("Remove stage directions, role prefixes and narration; output spoken dialogue only")
        if assessment.get("overDisclosureRisk"):
            reasons.append("過早或過度透露")
        if assessment.get("underReactionRisk"):
            reasons.append("情緒反應不足")
        if assessment.get("languageNaturalnessScore", 10) < 6.5:
            reasons.append("語言自然度不足")
        if assessment.get("consistencyScore", 10) < 5.5:
            reasons.append("個案連續性不足")
        if assessment.get("repeatedResponseRisk"):
            reasons.append("重複近期回應")
        if assessment.get("semanticRepeatRisk"):
            reasons.append("重複近期語義策略")
        if assessment.get("avoidanceOveruseRisk"):
            reasons.append("過度迴避導致訪談停滯")
        if assessment.get("followUpAffordanceScore", 10) < 4.5:
            reasons.append("缺少自然可追問線索")
        if assessment.get("progressionFitScore", 10) < 5.5:
            reasons.append("推進階段不匹配")
        return "、".join(reasons) or "回應真實度不足"

    async def _repair_once(
        self,
        payload: dict[str, Any],
        response: dict[str, Any],
        assessment: dict[str, Any],
    ) -> dict[str, Any] | None:
        prompt = build_realism_repair_prompt(payload, response, assessment)
        try:
            parsed = await self.llm.json_completion(prompt, 0.45)
        except Exception:
            return None
        if not is_client_response(parsed):
            return None
        parsed["riskSignals"] = client_disclosed_risk_signals(
            parsed,
            payload.get("caseProfile", {}).get("caseType"),
        )
        parsed["revealedFacts"] = unique_strings(parsed.get("revealedFacts", []))
        parsed["changeTalk"] = unique_strings(parsed.get("changeTalk", []))
        return parsed


class AvatarDirectorAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "AvatarDirectorAgent",
            "Normalize client affect and motion cues into VRM-safe avatar directives.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def run(
        self,
        response: dict[str, Any],
        case_profile: dict[str, Any] | None = None,
        student_analysis: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        case_type = case_profile.get("caseType") if isinstance(case_profile, dict) else None
        model_affect = normalize_affect(response.get("affect"))
        model_motion = response.get("motionCue") if response.get("motionCue") in ALLOWED_MOTIONS else motion_for_affect(model_affect)
        risk_signals = normalize_risk_signals(response.get("riskSignals", []), case_type)
        policy = avatar_behavior_policy(
            response=response,
            case_profile=case_profile or {},
            student_analysis=student_analysis or {},
            model_affect=model_affect,
            model_motion=model_motion,
            risk_signals=risk_signals,
        )
        response["affect"] = policy["affect"]
        response["riskSignals"] = normalize_risk_signals(response.get("riskSignals", []), case_type)
        response["motionCue"] = policy["motionCue"]
        response["avatarDirective"] = {
            "affect": policy["affect"],
            "motionCue": policy["motionCue"],
            "baselineMood": policy["baselineMood"],
            "gesture": policy["gesture"],
            "transitionMs": policy["transitionMs"],
            "holdMs": policy["holdMs"],
            "priority": policy["priority"],
            "ttsText": response.get("clientText", ""),
            "voiceStyle": policy["voiceStyle"],
            "emotionCue": policy["affect"],
            "expressionPreset": policy["expressionPreset"],
            "expressionWeights": policy["expressionWeights"],
            "intensity": policy["intensity"],
            "performancePlan": policy["performancePlan"],
            "expressionPlan": policy["expressionPlan"],
            "basis": policy["basis"],
        }
        if policy.get("overriddenFromModel"):
            response["avatarDirective"]["overriddenFromModel"] = policy["overriddenFromModel"]
        return response


class SupervisorAgent(ManagedAgent):
    def __init__(self, llm: DeepSeekClient) -> None:
        super().__init__(
            "SupervisorAgent",
            "Evaluate social-work interviewing quality in professional Hong Kong Traditional Chinese.",
            f"deepseek/{os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}",
        )
        self.llm = llm

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.llm.enabled:
            return fallback_supervisor_review(payload)
        prompt = build_supervisor_prompt(payload)
        parsed = await self.llm.json_completion(prompt, 0.35)
        if not is_supervisor_review(parsed):
            raise RuntimeError("DeepSeek supervisor response did not match the expected schema.")
        return parsed


class PostSessionSupervisorAgent(ManagedAgent):
    def __init__(self, llm: DeepSeekClient) -> None:
        super().__init__(
            "PostSessionSupervisorAgent",
            "Generate post-session social-work supervision reports from full session traces.",
            f"deepseek/{os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}",
        )
        self.llm = llm

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.llm.enabled:
            raise RuntimeError("DeepSeek is not enabled. Post-session supervision requires an LLM report.")
        prompt = build_post_session_supervisor_prompt(payload)
        parsed = await self.llm.json_completion(prompt, 0.3)
        if not is_post_session_supervisor_report(parsed):
            raise RuntimeError("DeepSeek post-session supervisor report did not match the expected schema.")
        return parsed


class RhubarbLipSyncService:
    def __init__(self) -> None:
        self.recognizer = os.environ.get("RHUBARB_RECOGNIZER", "phonetic")

    @property
    def enabled(self) -> bool:
        return os.environ.get("LOCAL_RHUBARB_LIPSYNC_ENABLED", "").lower() == "true"

    @property
    def binary_path(self) -> str | None:
        configured = os.environ.get("RHUBARB_BIN", "").strip()
        if configured:
            return configured if Path(configured).exists() else None
        return shutil.which("rhubarb")

    @property
    def available(self) -> bool:
        return bool(self.binary_path)

    @property
    def can_run(self) -> bool:
        return self.enabled and self.available

    def health(self) -> dict[str, Any]:
        return {
            "lipSyncProvider": "rhubarb" if self.enabled else None,
            "rhubarbEnabled": self.enabled,
            "rhubarbAvailable": self.available,
            "rhubarbRecognizer": self.recognizer,
        }

    def fallback(self) -> dict[str, Any]:
        return {
            "provider": "rhubarb",
            "recognizer": self.recognizer,
            "cues": [],
            "mappedVisemes": [],
            "fallbackUsed": True,
        }

    def analyze(self, audio_content: bytes, text: str) -> dict[str, Any] | None:
        if not self.can_run:
            return self.fallback() if self.enabled else None
        timeout_ms = clamp_float(os.environ.get("RHUBARB_TIMEOUT_MS", "2500"), 500, 15000)
        binary = self.binary_path
        if not binary:
            return self.fallback()
        with tempfile.TemporaryDirectory(prefix="social-work-rhubarb-") as temp_dir:
            temp_path = Path(temp_dir)
            audio_path = temp_path / "speech.wav"
            dialog_path = temp_path / "dialog.txt"
            audio_path.write_bytes(audio_content)
            dialog_path.write_text(text, encoding="utf-8")
            command = [
                binary,
                "--recognizer",
                self.recognizer,
                "--exportFormat",
                "json",
                "--dialogFile",
                str(dialog_path),
                str(audio_path),
            ]
            try:
                completed = subprocess.run(
                    command,
                    check=True,
                    capture_output=True,
                    text=True,
                    timeout=timeout_ms / 1000,
                )
                parsed = json.loads(completed.stdout or "{}")
                return self._normalize(parsed)
            except Exception:
                return self.fallback()

    def _normalize(self, parsed: dict[str, Any]) -> dict[str, Any]:
        cues: list[dict[str, Any]] = []
        for item in parsed.get("mouthCues", []):
            shape = item.get("value")
            if shape not in RHUBARB_SHAPE_TO_VISEME:
                continue
            start = float(item.get("start", 0)) * 1000
            end = float(item.get("end", 0)) * 1000
            if end <= start:
                continue
            cues.append({"startMs": round(start), "endMs": round(end), "shape": shape})
        return {
            "provider": "rhubarb",
            "recognizer": self.recognizer,
            "cues": cues,
            "mappedVisemes": [
                {
                    "startMs": cue["startMs"],
                    "endMs": cue["endMs"],
                    "viseme": RHUBARB_SHAPE_TO_VISEME[cue["shape"]],
                }
                for cue in cues
            ],
        }


class VoiceSynthesisAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "VoiceSynthesisAgent",
            "Synthesize service-user speech with Google Text-to-Speech.",
            os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Standard-D"),
            False,
        )
        self.lip_sync = RhubarbLipSyncService()

    @property
    def enabled(self) -> bool:
        return os.environ.get("GOOGLE_VOICE_ENABLED", "").lower() == "true"

    @property
    def streaming_enabled(self) -> bool:
        return os.environ.get("GOOGLE_TTS_STREAMING_ENABLED", "").lower() == "true"

    def streaming_capability(self) -> dict[str, Any]:
        available = False
        reason = "disabled"
        if self.streaming_enabled and self.enabled and os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
            try:
                from google.cloud import texttospeech

                available = hasattr(texttospeech.TextToSpeechClient, "streaming_synthesize")
                reason = "ready" if available else "client_library_unsupported"
            except Exception:
                reason = "google_tts_dependency_unavailable"
        elif self.streaming_enabled and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
            reason = "credentials_missing"
        return {
            "enabled": self.streaming_enabled,
            "available": available,
            "reason": reason,
            "cantoneseVoice": os.environ.get("GOOGLE_TTS_STREAMING_YUE_VOICE", "yue-HK-Chirp3-HD-Achird"),
            "englishVoice": os.environ.get("GOOGLE_TTS_STREAMING_EN_VOICE", "en-US-Chirp3-HD-Charon"),
        }

    def synthesize(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required for TTS.")
        if not self.enabled:
            raise RuntimeError("Google voice is disabled. Set GOOGLE_VOICE_ENABLED=true to enable TTS.")
        if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
            raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS is required for Google TTS.")

        try:
            from google.cloud import texttospeech
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("google-cloud-texttospeech is not installed.") from exc

        language_mode = response_language({"responseLanguage": payload.get("language") or payload.get("responseLanguage")})
        language = (
            os.environ.get("GOOGLE_TTS_EN_LANGUAGE", "en-US")
            if language_mode == "english"
            else os.environ.get("GOOGLE_TTS_LANGUAGE", "yue-HK")
        )
        voice_override = payload.get("voice") or payload.get("voiceName")
        default_voice = (
            os.environ.get("GOOGLE_TTS_EN_VOICE", "en-US-Wavenet-D")
            if language_mode == "english"
            else os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Standard-D")
        )
        voice_name = voice_override.strip() if isinstance(voice_override, str) and voice_override.strip() else default_voice
        speaking_rate, pitch = tts_style_for_affect(payload.get("affect"), payload.get("voiceStyle"), text)

        client = texttospeech.TextToSpeechClient()
        voice_candidates = tts_voice_candidates(language_mode, voice_name)
        requested_encoding_name = os.environ.get("GOOGLE_TTS_AUDIO_ENCODING", "MP3").upper()
        encoding_name = "LINEAR16" if self.lip_sync.can_run else requested_encoding_name
        linear16_sample_rate = int(clamp_float(os.environ.get("GOOGLE_TTS_LINEAR16_SAMPLE_RATE", "24000"), 8000, 48000))

        def synthesize_with_encoding(active_encoding_name: str, candidate_voice_name: str | None) -> Any:
            voice_params = {
                "language_code": language,
                "ssml_gender": texttospeech.SsmlVoiceGender.MALE,
            }
            if candidate_voice_name:
                voice_params["name"] = candidate_voice_name
            encoding = getattr(texttospeech.AudioEncoding, active_encoding_name, texttospeech.AudioEncoding.MP3)
            audio_config = {
                "audio_encoding": encoding,
                "speaking_rate": speaking_rate,
            }
            if active_encoding_name == "LINEAR16":
                audio_config["sample_rate_hertz"] = linear16_sample_rate
            if os.environ.get("GOOGLE_TTS_ENABLE_PITCH", "").lower() == "true":
                audio_config["pitch"] = pitch
            return client.synthesize_speech(
                input=texttospeech.SynthesisInput(text=text.strip()),
                voice=texttospeech.VoiceSelectionParams(**voice_params),
                audio_config=texttospeech.AudioConfig(**audio_config),
            )

        response = None
        resolved_voice_name = None
        last_error: Exception | None = None
        active_encoding_name = encoding_name
        for candidate_voice_name in voice_candidates:
            try:
                active_encoding_name = encoding_name
                response = synthesize_with_encoding(active_encoding_name, candidate_voice_name)
                resolved_voice_name = candidate_voice_name
                break
            except Exception as exc:
                last_error = exc
                if encoding_name == requested_encoding_name:
                    continue
                try:
                    active_encoding_name = requested_encoding_name
                    response = synthesize_with_encoding(active_encoding_name, candidate_voice_name)
                    resolved_voice_name = candidate_voice_name
                    break
                except Exception as fallback_exc:
                    last_error = fallback_exc
                    continue
        if response is None:
            if last_error:
                raise last_error
            raise RuntimeError("Google TTS did not return audio.")

        audio_content = response.audio_content
        if active_encoding_name == "LINEAR16":
            audio_content = ensure_wav_container(audio_content, linear16_sample_rate)
        mime_type = "audio/mpeg" if active_encoding_name == "MP3" else "audio/wav"
        result = {
            "mimeType": mime_type,
            "audioBase64": base64.b64encode(audio_content).decode("ascii"),
            "provider": "google-tts",
            "voice": resolved_voice_name or f"{language}-male",
            "voiceGender": "male",
        }
        lip_sync = self.lip_sync.analyze(audio_content, text.strip())
        if lip_sync:
            result["lipSync"] = lip_sync
        return result

    def start_stream(
        self,
        payload: dict[str, Any],
        event_queue: "asyncio.Queue[dict[str, Any]]",
        loop: asyncio.AbstractEventLoop,
        response_id: str,
    ) -> "StreamingTtsSession":
        capability = self.streaming_capability()
        if not capability["available"]:
            raise RuntimeError(f"Google streaming TTS unavailable: {capability['reason']}")

        cancel_event = threading.Event()

        def emit(event: dict[str, Any]) -> None:
            loop.call_soon_threadsafe(event_queue.put_nowait, event)

        def worker() -> None:
            try:
                from google.cloud import texttospeech

                text = str(payload.get("text") or "").strip()
                if not text:
                    raise ValueError("text is required for streaming TTS.")
                language_mode = response_language({"responseLanguage": payload.get("language")})
                language = (
                    os.environ.get("GOOGLE_TTS_EN_LANGUAGE", "en-US")
                    if language_mode == "english"
                    else os.environ.get("GOOGLE_TTS_LANGUAGE", "yue-HK")
                )
                voice_name = (
                    os.environ.get("GOOGLE_TTS_STREAMING_EN_VOICE", "en-US-Chirp3-HD-Charon")
                    if language_mode == "english"
                    else os.environ.get("GOOGLE_TTS_STREAMING_YUE_VOICE", "yue-HK-Chirp3-HD-Achird")
                )
                speaking_rate, _ = tts_style_for_affect(payload.get("affect"), payload.get("voiceStyle"), text)
                sample_rate = int(clamp_float(os.environ.get("GOOGLE_TTS_STREAMING_SAMPLE_RATE", "24000"), 16000, 48000))
                client = texttospeech.TextToSpeechClient()
                config = texttospeech.StreamingSynthesizeConfig(
                    voice=texttospeech.VoiceSelectionParams(
                        language_code=language,
                        name=voice_name,
                        ssml_gender=texttospeech.SsmlVoiceGender.MALE,
                    ),
                    streaming_audio_config=texttospeech.StreamingAudioConfig(
                        audio_encoding=texttospeech.AudioEncoding.PCM,
                        sample_rate_hertz=sample_rate,
                        speaking_rate=speaking_rate,
                    ),
                )

                def requests():
                    yield texttospeech.StreamingSynthesizeRequest(streaming_config=config)
                    for chunk in streaming_text_chunks(text):
                        if cancel_event.is_set():
                            return
                        yield texttospeech.StreamingSynthesizeRequest(
                            input=texttospeech.StreamingSynthesisInput(text=chunk)
                        )

                emit({
                    "type": "tts_stream_started",
                    "responseId": response_id,
                    "provider": "google-tts-streaming",
                    "voice": voice_name,
                    "sampleRate": sample_rate,
                })
                for response in client.streaming_synthesize(requests=requests(), timeout=30):
                    if cancel_event.is_set():
                        emit({"type": "tts_stream_cancelled", "responseId": response_id})
                        return
                    if response.audio_content:
                        emit({
                            "type": "tts_stream_chunk",
                            "responseId": response_id,
                            "audioPcmBase64": base64.b64encode(response.audio_content).decode("ascii"),
                            "sampleRate": sample_rate,
                        })
                emit({"type": "tts_stream_done", "responseId": response_id})
            except Exception as exc:
                emit({
                    "type": "tts_stream_error",
                    "responseId": response_id,
                    "message": str(exc),
                    "recoverable": True,
                })

        thread = threading.Thread(target=worker, daemon=True, name=f"tts-{response_id}")
        thread.start()
        return StreamingTtsSession(cancel_event, thread)


class StreamingTtsSession:
    def __init__(self, cancel_event: threading.Event, worker: threading.Thread) -> None:
        self.cancel_event = cancel_event
        self.worker = worker

    def stop(self) -> None:
        self.cancel_event.set()


def streaming_text_chunks(text: str, max_chars: int = 120) -> list[str]:
    parts = [part.strip() for part in re.split(r"(?<=[。！？!?；;,.，])", text) if part.strip()]
    chunks: list[str] = []
    current = ""
    for part in parts or [text]:
        if current and len(current) + len(part) > max_chars:
            chunks.append(current)
            current = part
        else:
            current += part
    if current:
        chunks.append(current)
    return chunks


class AudioCaptureGap(RuntimeError):
    pass


def realtime_pcm_chunks(audio_queue: "queue.Queue[bytes | None]", sample_rate: int, stats=None):
    missing_seconds = 0.0
    while True:
        try:
            chunk = audio_queue.get(timeout=0.1)
        except queue.Empty:
            missing_seconds += 0.1
            if missing_seconds >= 2:
                raise AudioCaptureGap("No microphone audio received for two seconds.")
            chunk = bytes(int(sample_rate * 0.1) * 2)
            if stats is not None:
                stats["syntheticSilenceMs"] += 100
        else:
            missing_seconds = 0
            if stats is not None and chunk:
                stats["realAudioMs"] += len(chunk) * 500 / sample_rate
        if chunk is None:
            return
        if chunk:
            yield chunk


class StreamingSpeechSession:
    def __init__(self, audio_queue: "queue.Queue[bytes | None]", worker: threading.Thread, sample_rate=16000, on_gap=None, stats=None) -> None:
        self.audio_queue = audio_queue
        self.worker = worker
        self.stopped = False
        self.finishing = False
        self.sample_rate = sample_rate
        self.on_gap = on_gap
        self.stats = stats if stats is not None else {"syntheticSilenceMs": 0, "realAudioMs": 0}

    def send_audio(self, audio: bytes) -> None:
        if self.stopped or self.finishing:
            return
        with self.audio_queue.mutex:
            pending_bytes = sum(len(item) for item in self.audio_queue.queue if item)
        if pending_bytes + len(audio) > self.sample_rate * 2 or self.audio_queue.full():
            self.stop()
            if self.on_gap:
                self.on_gap({"type": "audio_gap", "reason": "audio_buffer_overflow", "recoverable": True})
            return
        self.audio_queue.put_nowait(audio)

    def finish(self) -> None:
        if self.stopped or self.finishing:
            return
        self.finishing = True
        self.audio_queue.put(None, timeout=0.1)

    def stop(self) -> None:
        if self.stopped:
            return
        self.stopped = True
        while True:
            try:
                self.audio_queue.get_nowait()
            except queue.Empty:
                break
        self.audio_queue.put_nowait(None)


def google_stt_v1_streaming_model(value: str | None) -> str | None:
    """Return a Speech-to-Text v1 streaming model name, or None for Google's default.

    The current streaming implementation uses google.cloud.speech.SpeechClient
    (Speech-to-Text v1). Chirp model names are Speech-to-Text v2 names and cause
    v1 RecognitionConfig to fail with "Incorrect model specified".
    """
    model = (value or "").strip()
    if not model or model.lower() in {"auto", "default", "google-stt-v1-auto"}:
        return None
    if model in {"chirp_2", "chirp_3"}:
        return None
    valid_v1_streaming_models = {
        "latest_long",
        "latest_short",
        "command_and_search",
        "phone_call",
        "video",
        "medical_dictation",
        "medical_conversation",
    }
    return model if model in valid_v1_streaming_models else None


class StreamingSpeechAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "StreamingSpeechAgent",
            "Stream Hong Kong Cantonese microphone audio to Google Speech-to-Text.",
            os.environ.get("GOOGLE_STT_MODEL", "google-stt-v1-auto"),
            False,
        )

    @property
    def enabled(self) -> bool:
        return os.environ.get("GOOGLE_VOICE_ENABLED", "").lower() == "true"

    def start_stream(
        self,
        sample_rate: int,
        event_queue: "asyncio.Queue[dict[str, Any]]",
        loop: asyncio.AbstractEventLoop,
        stream_id: str | None = None,
        recognition_language: str | None = None,
    ) -> StreamingSpeechSession:
        if not self.enabled:
            raise RuntimeError("Google voice is disabled. Set GOOGLE_VOICE_ENABLED=true to enable streaming ASR.")
        if not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
            raise RuntimeError("GOOGLE_APPLICATION_CREDENTIALS is required for Google STT.")

        try:
            from google.cloud import speech
        except Exception as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("google-cloud-speech is not installed.") from exc

        audio_queue: "queue.Queue[bytes | None]" = queue.Queue()
        stats = {"syntheticSilenceMs": 0, "realAudioMs": 0}
        language = recognition_language or os.environ.get("GOOGLE_STT_LANGUAGE", "yue-Hant-HK")
        model = google_stt_v1_streaming_model(os.environ.get("GOOGLE_STT_MODEL", ""))

        def audio_requests():
            try:
                for chunk in realtime_pcm_chunks(audio_queue, sample_rate, stats):
                    yield speech.StreamingRecognizeRequest(audio_content=chunk)
            except AudioCaptureGap:
                # Catch inside the iterator: gRPC otherwise wraps this as Unknown.
                emit({"type": "audio_gap", "reason": "capture_starved", "recoverable": True})

        def emit(event: dict[str, Any]) -> None:
            loop.call_soon_threadsafe(
                event_queue.put_nowait,
                {**event, "speechStreamId": stream_id} if stream_id else event,
            )

        def worker() -> None:
            try:
                client = speech.SpeechClient()
                config_kwargs: dict[str, Any] = {
                    "encoding": speech.RecognitionConfig.AudioEncoding.LINEAR16,
                    "sample_rate_hertz": sample_rate,
                    "language_code": language,
                    "enable_automatic_punctuation": True,
                }
                if model:
                    config_kwargs["model"] = model
                config = speech.RecognitionConfig(**config_kwargs)
                streaming_config = speech.StreamingRecognitionConfig(
                    config=config,
                    interim_results=True,
                    single_utterance=False,
                )
                for response in client.streaming_recognize(streaming_config, audio_requests()):
                    for result in response.results:
                        if not result.alternatives:
                            continue
                        transcript = result.alternatives[0].transcript.strip()
                        if not transcript:
                            continue
                        emit(
                            {
                                "type": "asr_final" if result.is_final else "asr_partial",
                                "transcript": transcript,
                                "confidence": getattr(result.alternatives[0], "confidence", None),
                                "resultEndMs": result.result_end_time.total_seconds() * 1000,
                            }
                        )
            except AudioCaptureGap:
                emit({"type": "audio_gap", "reason": "capture_starved", "recoverable": True})
            except Exception as exc:
                emit({"type": "error", "message": str(exc), "recoverable": True})
            finally:
                emit({"type": "stream_ended", "recoverable": True})

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        return StreamingSpeechSession(audio_queue, thread, sample_rate, emit, stats)


class SocialWorkCoordinatorAgent(ManagedAgent):
    def __init__(self, root_dir: Path) -> None:
        super().__init__(
            "SocialWorkCoordinatorAgent",
            "Coordinate social-work simulation agents through a deterministic, auditable workflow.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )
        self.root_dir = root_dir
        self.prompt_registry = PromptRegistry(root_dir)
        self.llm = DeepSeekClient()
        self.sessions = AgentSessionStore(root_dir)
        self.authority = SessionAuthority(self.sessions)
        self.strategy_service = SimulationStrategyService(self.prompt_registry)
        self.student_analyzer = StudentMoveAnalyzerAgent()
        self.adaptive_policy = AdaptiveResponsePolicy()
        self.evidence_retriever = EvidenceRetrievalAgent(root_dir)
        self.case_state = CaseStateAgent()
        self.client_simulator = ClientSimulationAgent(self.llm)
        self.realism_scorer = ClientRealismScoringAgent(self.llm)
        self.safety_reviewer = SafetyReviewAgent()
        self.supervisor = SupervisorAgent(self.llm)
        self.post_session_supervisor = PostSessionSupervisorAgent(self.llm)
        self.avatar_director = AvatarDirectorAgent()
        self.streaming_speech = StreamingSpeechAgent()
        self.voice_synthesis = VoiceSynthesisAgent()

    def health(self) -> dict[str, Any]:
        embedding_stats = self.evidence_retriever.embedding_store.stats(self.evidence_retriever.card_count)
        corpus_readiness = corpus_manifest_status(self.root_dir)
        agents = [
            self,
            self.strategy_service,
            self.student_analyzer,
            self.adaptive_policy,
            self.evidence_retriever,
            self.case_state,
            self.client_simulator,
            self.realism_scorer,
            self.safety_reviewer,
            self.supervisor,
            self.post_session_supervisor,
            self.avatar_director,
            self.streaming_speech,
            self.voice_synthesis,
        ]
        domain_service_labels = {
            "StudentMoveAnalyzerAgent": "InterviewPolicyService.studentMoveAnalyzer",
            "SimulationStrategyService": "SimulationStrategyService",
            "AdaptiveResponsePolicy": "InterviewPolicyService.adaptiveResponsePolicy",
            "EvidenceRetrievalAgent": "EvidenceRetrievalService",
            "CaseStateAgent": "CaseSessionService.caseState",
            "SafetyReviewAgent": "SafetyPolicyService",
            "AvatarDirectorAgent": "AvatarBehaviorService",
        }
        infrastructure_service_labels = {
            "SocialWorkCoordinatorAgent": "CoordinatorWorkflow",
            "StreamingSpeechAgent": "VoiceService.streamingSpeech",
            "VoiceSynthesisAgent": "VoiceService.synthesis",
            "AgentSessionStore": "CaseSessionService.sessionStore",
        }
        tts_streaming = self.voice_synthesis.streaming_capability()
        return {
            "ok": True,
            "cloudReadiness": {
                "googleCredentialsDetected": bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")),
                "deepSeekKeyDetected": bool(os.environ.get("DEEPSEEK_API_KEY")),
                "voiceWebSocketEndpoint": "/api/voice-stream",
                "runtimeDataRoot": str(self.root_dir / "data"),
            },
            "adkAvailable": ADK_AVAILABLE,
            "llmExecutionBackend": "adk_runner" if os.environ.get("ADK_LLM_EXECUTION_ENABLED", "false").lower() == "true" else "direct_http",
            "adkRunnerEnabled": os.environ.get("ADK_LLM_EXECUTION_ENABLED", "false").lower() == "true",
            "adkManagedAgents": [agent.name for agent in agents if agent.adk_managed and agent.adk_enabled],
            "llmAgents": [agent.name for agent in agents if agent.adk_managed],
            "domainServices": [
                domain_service_labels[agent.name]
                for agent in agents
                if agent.name in domain_service_labels
            ],
            "infrastructureServices": [
                infrastructure_service_labels[agent.name]
                for agent in agents
                if agent.name in infrastructure_service_labels
            ] + [infrastructure_service_labels["AgentSessionStore"]],
            "deepSeekEnabled": self.llm.enabled,
            "googleVoiceEnabled": self.voice_synthesis.enabled and self.streaming_speech.enabled,
            "googleSttReady": self.streaming_speech.enabled and bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")),
            "googleTtsReady": self.voice_synthesis.enabled and bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")),
            "googleSttLanguage": os.environ.get("GOOGLE_STT_LANGUAGE", "yue-Hant-HK"),
            "googleSttModel": os.environ.get("GOOGLE_STT_MODEL", "google-stt-v1-auto"),
            "googleTtsLanguage": os.environ.get("GOOGLE_TTS_LANGUAGE", "yue-HK"),
            "googleTtsVoice": os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Standard-D"),
            "voiceProtocolVersion": "2",
            "voiceTransport": "websocket-binary-pcm",
            "captureBackend": "browser-audio-worklet",
            "playbackBackend": "browser-audio-worklet",
            "googleTtsStreaming": tts_streaming,
            "evidenceCardCount": self.evidence_retriever.card_count,
            "sessionStore": str(self.sessions.db_path),
            "sessionBackend": self.sessions.backend,
            "corpusBackend": self.evidence_retriever.backend,
            "corpusReadiness": corpus_readiness,
            "retrievalMode": self.evidence_retriever.retrieval_mode,
            "embeddingEnabled": embedding_stats["enabled"],
            "embeddingModel": embedding_stats["model"],
            "embeddingCoverage": embedding_stats["coverage"],
            "embeddingStatus": embedding_stats["status"],
            **self.voice_synthesis.lip_sync.health(),
            "promptRegistry": {
                "clientPrompt": bool(self.prompt_registry.client_prompt()),
                "simulationMethods": sorted(self.strategy_service.methods.keys()),
            },
        }

    def list_evidence_cards(self, filters: dict[str, Any]) -> dict[str, Any]:
        return self.evidence_retriever.list_cards(filters)

    def start_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        record = self.authority.start(resolve_case(payload), payload.get('_owner', 'local-dev'), payload.get('sessionId'))
        return session_view(record, payload.get('_role', 'instructor'))

    def reset_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        if payload.get('sessionId'):
            self.authority.close(payload['sessionId'], payload.get('_owner', 'local-dev'))
        return self.start_session({**payload, 'sessionId': None})

    def export_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = payload.get("sessionId")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("sessionId is required.")
        self.authority.read(session_id, payload.get('_owner', 'local-dev'))
        record = self.sessions.session_record(session_id)
        trace = build_post_session_trace(record.get("events", []), [])
        return {
            **record,
            "trace": trace,
            "traceSummary": summarize_post_session_trace(trace),
        }

    async def interview_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        owner = payload.get('_owner', 'local-dev')
        sid = payload.get('sessionId')
        if not sid:
            sid = self.start_session(payload)['sessionId']
        tid = payload.get('turnId') or 'turn-' + uuid.uuid4().hex
        record, token, cached = self.authority.reserve(sid, owner, tid, payload.get('expectedStateVersion'))
        if cached is not None:
            return cached
        enriched = {**payload, 'sessionId': sid, 'turnId': tid, '_token': token,
                    '_version': record['stateVersion'], '_continuity': record['continuity'],
                    'caseProfile': record['caseProfile'],
                    'history': [*record['history'], {'speaker': 'student', 'text': payload.get('studentText', '')}]}
        if payload.get('_role') == 'trainee':
            enriched.update(simulationMethod='social_work_default', retrievalOptions={'embeddingEnabled': False})
        try:
            return await asyncio.wait_for(self._generate_turn(enriched), timeout=150)
        except BaseException:
            self.authority.fail(sid, tid, token)
            raise

    async def _generate_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        case_profile = payload.get("caseProfile")
        student_text = payload.get("studentText")
        if not isinstance(case_profile, dict) or not isinstance(student_text, str):
            raise ValueError("Invalid interview-turn payload.")
        response_language_value = response_language(payload)

        agent_trace_id = f"trace-{uuid.uuid4().hex[:16]}"
        session_id = payload.get("sessionId") or f"case-{case_profile.get('id', 'default')}"

        history = payload.get("history") if isinstance(payload.get("history"), list) else []
        student_analysis = self.student_analyzer.run(student_text)
        prior_events = self.sessions.recent_events(session_id)
        session_continuity = build_session_continuity(case_profile, history, [], student_analysis, previous=payload.get('_continuity'))
        simulation_strategy = self.strategy_service.run(
            payload.get("simulationMethod"),
            case_profile,
            student_analysis,
            session_continuity,
        )
        adaptive_policy = self.adaptive_policy.run(case_profile, student_analysis, session_continuity)
        adaptive_policy = self.strategy_service.apply_to_policy(adaptive_policy, simulation_strategy)
        grounding_profile = load_active_grounding_profile(self.root_dir, case_profile)
        pie_context = summarize_pie_context(grounding_profile, case_profile)
        retrieval_options = payload.get("retrievalOptions") if isinstance(payload.get("retrievalOptions"), dict) else {}
        cards = await asyncio.to_thread(self.evidence_retriever.run,
            case_profile,
            student_text,
            history,
            student_analysis,
            simulation_strategy,
            retrieval_options,
            adaptive_policy,
        )
        evidence_summary = self.evidence_retriever.summarize(cards, case_profile.get("caseType"))
        enriched = {
            **payload,
            "simulationMethod": simulation_strategy["simulationMethod"],
            "simulationStrategy": simulation_strategy,
            "history": history,
            "studentAnalysis": student_analysis,
            "sessionContinuity": session_continuity,
            "adaptivePolicy": adaptive_policy,
            "groundingProfile": compact_profile_for_prompt(grounding_profile),
            "pieContext": pie_context,
            "retrievedCards": cards,
            "evidenceSummary": evidence_summary,
        }
        if reaction_planning.enabled():
            enriched["recentReactionPlans"] = [
                event.get("payload", event).get("clientResponse", {}).get("reactionPlan")
                for event in prior_events
                if isinstance(event.get("payload", event).get("clientResponse", {}).get("reactionPlan"), dict)
            ][-3:]
        generation_started = time.monotonic()
        response = await self.client_simulator.run(enriched)
        response = await self.realism_scorer.run(enriched, response)
        if reaction_planning.enabled():
            import logging
            logging.getLogger(__name__).info(
                "reaction_plan version=%s trace=%s mode=%s repair=%s elapsed_ms=%d",
                reaction_planning.VERSION, agent_trace_id, response["reactionPlan"]["responseMode"],
                bool(response.get("realismAssessment", {}).get("repairApplied")),
                int((time.monotonic() - generation_started) * 1000),
            )
        response["evidenceSummary"] = evidence_summary
        response["simulationMethod"] = simulation_strategy["simulationMethod"]
        response["simulationStrategySnapshot"] = simulation_strategy
        safety_checked = self.safety_reviewer.run(response, case_profile, response_language_value)
        if safety_checked.get("safetyFlags"):
            raise ValueError("Client safety validation failed; retry the turn.")
        response = safety_checked
        response["riskSignals"] = unique_strings([
            *client_disclosed_risk_signals(response, case_profile.get("caseType")),
        ])
        safety_hint = safety_hint_for_response(response)
        if safety_hint:
            response["safetyHint"] = safety_hint
        response["adaptivePolicySnapshot"] = adaptive_policy
        response["simulationStrategySnapshot"] = simulation_strategy
        response["sessionContinuitySnapshot"] = session_continuity
        response["contextConsistencyAssessment"] = assess_context_consistency(enriched, response)
        response["profileGroundingSnapshot"] = summarize_grounding_profile(grounding_profile)
        response["pieContextSnapshot"] = pie_context
        response = self.avatar_director.run(response, case_profile, student_analysis)
        require_spoken_text(response)
        response["avatarDirective"]["ttsText"] = response["clientText"]
        if response.get("evidenceSummary"):
            response["evidenceSummary"]["riskSignals"] = normalize_risk_signals(
                response["evidenceSummary"].get("riskSignals", []),
                case_profile.get("caseType"),
            )[:8]
        response["agentTraceId"] = agent_trace_id

        next_case = self.case_state.apply_response(case_profile, response)
        updated_continuity = build_session_continuity(case_profile, history, [], student_analysis, response, adaptive_policy, previous=payload.get('_continuity'))
        response["disclosureLedger"] = build_disclosure_ledger(case_profile, response)
        response["progressionEvidence"] = {
            "stage": updated_continuity.get("currentIssueStage", adaptive_policy.get("progressionStage", "initial_contact")),
            "transitionReason": adaptive_policy.get("issueStageReason"),
            "newAffordance": adaptive_policy.get("requiredFollowUpAffordance") or adaptive_policy.get("minFollowUpAffordance"),
        }
        response["adaptivePolicySnapshot"] = adaptive_policy
        response["sessionContinuitySnapshot"] = updated_continuity
        response["contextConsistencyAssessment"] = assess_context_consistency(enriched, response)
        response["profileGroundingSnapshot"] = summarize_grounding_profile(grounding_profile)
        response["pieContextSnapshot"] = pie_context
        event = {
                "caseProfile": next_case,
                "studentAnalysis": student_analysis,
                "adaptivePolicy": adaptive_policy,
                "simulationStrategy": simulation_strategy,
                "sessionContinuity": updated_continuity,
                "groundingProfileSnapshot": summarize_grounding_profile(grounding_profile),
                "pieContextSnapshot": pie_context,
                "evidenceSummary": evidence_summary,
                "clientResponse": response,
                "studentText": student_text,
            }
        if payload.get('responseId'):
            response['responseId'] = payload['responseId']
        state = {'caseProfile': next_case, 'continuity': updated_continuity,
                 'history': [*history, {'speaker': 'client', 'text': response['clientText'],
                                      'revealedFacts': response['revealedFacts']}]}
        return self.authority.commit(session_id, payload.get('_owner', 'local-dev'), payload['turnId'],
                                     payload['_token'], payload['_version'], state, response, event)

    async def supervisor_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        case_profile = payload.get("caseProfile")
        history = payload.get("history")
        if not isinstance(case_profile, dict) or not isinstance(history, list):
            raise ValueError("Invalid supervisor-review payload.")
        latest_student = next((turn.get("text", "") for turn in reversed(history) if turn.get("speaker") == "student"), "")
        enriched = {**payload, "studentAnalysis": self.student_analyzer.run(latest_student)}
        review = await self.supervisor.run(enriched)
        session_id = payload.get("sessionId") or f"case-{case_profile.get('id', 'default')}"
        self.sessions.start_session(case_profile, session_id)
        self.sessions.append_event(
            session_id,
            f"trace-{uuid.uuid4().hex[:16]}",
            "supervisor_review",
            {"review": review, "studentAnalysis": enriched["studentAnalysis"]},
        )
        return review

    async def final_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        session_id = payload.get("sessionId")
        record = self.authority.read(session_id, payload.get('_owner', 'local-dev'))
        case_profile = record['caseProfile']
        history = record['history']
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("sessionId is required for final-review.")
        if not isinstance(case_profile, dict):
            raise ValueError("caseProfile is required for final-review.")
        events = self.sessions.session_events(session_id)
        if not events and not history:
            raise ValueError("No session trace is available for final-review.")
        self.authority.close(session_id, payload.get('_owner', 'local-dev'))
        existing = next((e.get('payload', {}).get('report') for e in reversed(events)
                         if e.get('eventType', e.get('event_type')) == 'post_session_supervisor_report'), None)
        if existing:
            return existing
        trace = build_post_session_trace(events, history)
        hk_pcf_seed = build_hk_pcf_assessment(case_profile, trace)
        grounding_profile = load_active_grounding_profile(self.root_dir, case_profile)
        report = await self.post_session_supervisor.run(
            {
                "sessionId": session_id,
                "caseProfile": case_profile,
                "history": history,
                "trace": trace,
                "responseLanguage": response_language(payload),
                "hkPcfAssessmentSeed": hk_pcf_seed,
                "groundingProfileSnapshot": summarize_grounding_profile(grounding_profile),
                "pieContextSnapshot": summarize_pie_context(grounding_profile, case_profile),
            }
        )
        report["hkPcfAssessment"] = merge_hk_pcf_assessment(
            report.get("hkPcfAssessment"),
            hk_pcf_seed,
            response_language(payload),
        )
        self.sessions.append_event(
            session_id,
            f"trace-{uuid.uuid4().hex[:16]}",
            "post_session_supervisor_report",
            {"report": report, "traceSummary": summarize_post_session_trace(trace)},
        )
        return report

    def synthesize_tts(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.voice_synthesis.synthesize(payload)

    def start_tts_stream(
        self,
        payload: dict[str, Any],
        event_queue: "asyncio.Queue[dict[str, Any]]",
        loop: asyncio.AbstractEventLoop,
        response_id: str,
    ) -> StreamingTtsSession:
        return self.voice_synthesis.start_stream(payload, event_queue, loop, response_id)

    def record_voice_delivery(
        self,
        session_id: str | None,
        response_id: str | None,
        status: str,
        utterance_id: str | None = None,
    ) -> None:
        if not session_id or not response_id:
            return
        self.sessions.append_event(
            session_id,
            f"voice-{response_id}",
            "voice_delivery",
            {
                "responseId": response_id,
                "utteranceId": utterance_id,
                "deliveryStatus": status,
            },
        )

    def start_speech_stream(
        self,
        sample_rate: int,
        event_queue: "asyncio.Queue[dict[str, Any]]",
        loop: asyncio.AbstractEventLoop,
        stream_id: str | None = None,
        recognition_language: str | None = None,
    ) -> StreamingSpeechSession:
        return self.streaming_speech.start_stream(sample_rate, event_queue, loop, stream_id, recognition_language)


def build_session_continuity(
    case_profile: dict[str, Any],
    history: list[dict[str, Any]],
    events: list[dict[str, Any]],
    current_analysis: dict[str, bool] | None = None,
    current_response: dict[str, Any] | None = None,
    current_policy: dict[str, Any] | None = None,
    previous: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trust = clamp_float(case_profile.get("psychologicalState", {}).get("clientOpenness", 0), 0, 10)
    trust_trajectory: list[float] = []
    rupture_events: list[str] = []
    repair_attempts: list[str] = []
    disclosed: list[str] = []
    avoided_topics: list[str] = []
    recurring_patterns: list[str] = []
    case_type = case_profile.get("caseType") if isinstance(case_profile, dict) else None
    current_issue_stage = "initial_contact"
    recent_semantic_fingerprints: list[str] = []
    stage_transition_history: list[str] = []
    if previous:
        trust_trajectory = list(previous.get('trustTrajectory', []))
        rupture_events = list(previous.get('ruptureEvents', []))
        repair_attempts = list(previous.get('repairAttempts', []))
        disclosed = list(previous.get('disclosedFactIds', []))
        avoided_topics = list(previous.get('avoidedTopics', []))
        recurring_patterns = list(previous.get('recurringLanguagePatterns', []))
        current_issue_stage = previous.get('currentIssueStage', 'initial_contact')
        recent_semantic_fingerprints = list(previous.get('recentSemanticFingerprints', []))
        stage_transition_history = list(previous.get('stageTransitionHistory', []))
        events = []

    def remember_stage(stage_value: Any, reason_value: Any = None) -> None:
        nonlocal current_issue_stage
        stage = valid_progression_stage(stage_value)
        if not stage:
            return
        reason = str(reason_value or "session_event")
        if stage != current_issue_stage:
            stage_transition_history.append(f"{current_issue_stage}->{stage}: {reason}")
        current_issue_stage = stage

    for event in events:
        payload = event.get("payload", {})
        analysis = payload.get("studentAnalysis", {}) if isinstance(payload, dict) else {}
        response = payload.get("clientResponse", {}) if isinstance(payload, dict) else {}
        policy = payload.get("adaptivePolicy", {}) if isinstance(payload, dict) else {}
        continuity = payload.get("sessionContinuity", {}) if isinstance(payload, dict) else {}
        remember_stage(
            policy.get("progressionStage") or continuity.get("currentIssueStage"),
            policy.get("issueStageReason") or "prior_turn",
        )
        if analysis.get("mockingOrDismissive"):
            rupture_events.append("學生曾出現嘲笑或輕視語句")
        elif analysis.get("doubtOrInvalidating"):
            rupture_events.append("學生曾出現質疑或否定語句")
        elif analysis.get("judgmentalOrDirective") or analysis.get("prematureAdvice"):
            rupture_events.append("學生曾出現評判、命令或過早建議")
        if analysis.get("apologyRepair"):
            repair_attempts.append("學生曾作出道歉或修復關係嘗試")
        delta = response.get("stateDelta", {}).get("clientOpenness") if isinstance(response, dict) else None
        if isinstance(delta, (int, float)):
            trust = clamp_float(trust + delta, 0, 10)
            trust_trajectory.append(round(trust, 1))
        disclosed.extend(response.get("revealedFacts", []) if isinstance(response.get("revealedFacts"), list) else [])
        client_text = response.get("clientText", "")
        recurring_patterns.extend(extract_language_patterns(client_text))
        if str(client_text or "").strip():
            recent_semantic_fingerprints.append(semantic_response_fingerprint(str(client_text), case_type))

    if current_analysis:
        if current_analysis.get("mockingOrDismissive"):
            rupture_events.append("本輪出現嘲笑或輕視語句")
        elif current_analysis.get("doubtOrInvalidating"):
            rupture_events.append("本輪出現質疑或否定語句")
        elif current_analysis.get("judgmentalOrDirective") or current_analysis.get("prematureAdvice"):
            rupture_events.append("本輪出現評判、命令或過早建議")
        if current_analysis.get("apologyRepair"):
            repair_attempts.append("本輪出現道歉或關係修復")
    if current_response:
        disclosed.extend(current_response.get("revealedFacts", []) if isinstance(current_response.get("revealedFacts"), list) else [])
        client_text = current_response.get("clientText", "")
        recurring_patterns.extend(extract_language_patterns(client_text))
        if str(client_text or "").strip():
            recent_semantic_fingerprints.append(semantic_response_fingerprint(str(client_text), case_type))
        delta = current_response.get("stateDelta", {}).get("clientOpenness")
        if isinstance(delta, (int, float)):
            trust = clamp_float(trust + delta, 0, 10)
            trust_trajectory.append(round(trust, 1))
    if current_policy:
        remember_stage(current_policy.get("progressionStage"), current_policy.get("issueStageReason") or "current_turn")

    context_model = case_profile.get("socialWorkContextModel", {}) if isinstance(case_profile, dict) else {}
    avoided_topics.extend(infer_avoided_topics(case_profile, history, current_response))
    if current_analysis and (
        current_analysis.get("judgmentalOrDirective")
        or current_analysis.get("mockingOrDismissive")
        or current_analysis.get("doubtOrInvalidating")
    ):
        avoided_topics.extend(context_model.get("shameTriggers", [])[:2])

    relationship_memory = relationship_memory_text(trust, rupture_events, repair_attempts, current_analysis)
    reflection = None
    risk_present = bool(current_response and current_response.get("riskSignals"))
    turn_count = len([turn for turn in history if turn.get("speaker") == "student"])
    if turn_count % 3 == 0 or rupture_events or repair_attempts or risk_present:
        reflection = {
            "trustState": trust_state_label(trust, rupture_events, repair_attempts),
            "clientViewOfStudent": relationship_memory,
            "avoidedTopics": unique_strings(avoided_topics)[:5],
            "nextResponseTone": next_response_tone(trust, rupture_events, repair_attempts, current_response),
        }

    if not trust_trajectory:
        trust_trajectory = [round(trust, 1)]

    return {
        "trustTrajectory": trust_trajectory[-8:],
        "ruptureEvents": unique_strings(rupture_events)[-6:],
        "repairAttempts": unique_strings(repair_attempts)[-6:],
        "disclosedFactIds": unique_strings(disclosed),
        "avoidedTopics": unique_strings(avoided_topics)[:8],
        "recurringLanguagePatterns": unique_strings(recurring_patterns)[:8],
        "relationshipMemory": relationship_memory,
        "currentIssueStage": current_issue_stage,
        "recentSemanticFingerprints": unique_strings(recent_semantic_fingerprints)[-6:],
        "stageTransitionHistory": stage_transition_history[-8:],
        "sessionReflection": reflection,
    }


def build_disclosure_ledger(case_profile: dict[str, Any], response: dict[str, Any]) -> list[dict[str, Any]]:
    ledger: list[dict[str, Any]] = [
        {
            "id": "referral_context",
            "label": "轉介摘要",
            "kind": "referral_known",
            "source": "referral",
            "traineeVisible": True,
        }
    ]
    hidden_facts = case_profile.get("hiddenFacts") if isinstance(case_profile.get("hiddenFacts"), list) else []
    revealed = {str(item).strip().lower() for item in response.get("revealedFacts", []) if str(item).strip()}
    risk_signals = unique_strings(response.get("riskSignals", []))
    for fact in hidden_facts:
        fact_id = str(fact.get("id", ""))
        fact_label = str(fact.get("label", fact_id))
        if fact_id.lower() not in revealed and fact_label.lower() not in revealed:
            continue
        ledger.append(
            {
                "id": fact_id or fact_label,
                "label": fact_label,
                "kind": "client_confirmed" if fact.get("disclosed") else "newly_disclosed",
                "source": "client_response",
                "traineeVisible": True,
            }
        )
    for signal in risk_signals:
        ledger.append(
            {
                "id": f"risk:{signal}",
                "label": signal,
                "kind": "risk_disclosed",
                "source": "client_response",
                "traineeVisible": False,
            }
        )
    return ledger


def extract_language_patterns(text: Any) -> list[str]:
    text = str(text or "")
    patterns = []
    checks = [
        (r"冇咩|唔知|算啦", "短答／淡化"),
        (r"唔想講|講唔出口|唔好問", "避談"),
        (r"對唔住|唔好意思|麻煩", "為自己需要道歉"),
        (r"好羞恥|羞家|廢|冇用", "羞恥／低自我價值"),
        (r"但係|其實|可能", "矛盾／試探式透露"),
    ]
    for pattern, label in checks:
        if re.search(pattern, text):
            patterns.append(label)
    return patterns


def infer_avoided_topics(
    case_profile: dict[str, Any],
    history: list[dict[str, Any]],
    current_response: dict[str, Any] | None,
) -> list[str]:
    disclosed = set()
    for fact in case_profile.get("hiddenFacts", []):
        if fact.get("disclosed"):
            disclosed.add(str(fact.get("label", "")))
    if current_response:
        disclosed |= set(str(item) for item in current_response.get("revealedFacts", []) if isinstance(item, str))
    recent_text = " ".join(str(turn.get("text", "")) for turn in history[-8:])
    avoided = []
    for fact in case_profile.get("hiddenFacts", []):
        label = str(fact.get("label", ""))
        content = str(fact.get("content", ""))
        if label in disclosed or fact.get("id") in disclosed:
            continue
        if has_token_overlap(tokenize(f"{label} {content}"), tokenize(recent_text)):
            avoided.append(label)
    return avoided


def relationship_memory_text(
    trust: float,
    rupture_events: list[str],
    repair_attempts: list[str],
    current_analysis: dict[str, bool] | None,
) -> str:
    if current_analysis and current_analysis.get("mockingOrDismissive"):
        return "服務對象覺得這位學生社工不尊重自己，短期內很難信任。"
    if rupture_events and not repair_attempts:
        return "服務對象記得剛才被評判或冒犯，傾向保持距離。"
    if rupture_events and repair_attempts:
        return "服務對象聽到修復嘗試，但仍會觀察對方是否真的尊重自己。"
    if trust >= 5:
        return "服務對象開始覺得這位學生社工可能願意聽自己講。"
    return "服務對象仍在試探這位學生社工是否安全和可靠。"


def trust_state_label(trust: float, rupture_events: list[str], repair_attempts: list[str]) -> str:
    if rupture_events and not repair_attempts:
        return "關係破裂後低信任"
    if rupture_events and repair_attempts:
        return "修復中但仍戒備"
    if trust >= 6:
        return "中高信任"
    if trust >= 4:
        return "有限信任"
    return "低信任"


def next_response_tone(
    trust: float,
    rupture_events: list[str],
    repair_attempts: list[str],
    current_response: dict[str, Any] | None,
) -> str:
    if current_response and current_response.get("riskSignals"):
        return "低幅度、慢節奏、安全感優先"
    if rupture_events and not repair_attempts:
        return "短答、防衛、保持距離"
    if rupture_events and repair_attempts:
        return "稍微回應但仍然戒備"
    if trust >= 5:
        return "可逐步透露，但仍避免一次過完整交代"
    return "觀望、短答、先測試對方反應"


def response_language(payload: dict[str, Any] | None) -> str:
    value = (payload or {}).get("responseLanguage")
    return "english" if value == "english" else "cantonese"


def client_language_rules(language: str) -> list[str]:
    if language == "english":
        return [
            "clientText must be natural spoken English from the service user's point of view.",
            "Do not answer clientText in Cantonese, Chinese, or bilingual mixing unless the student explicitly quotes a phrase.",
            "Preserve the same case facts, personality, resistance, disclosure pacing, and risk gating; only change the response language.",
        ]
    return [
        "clientText must be natural spoken Hong Kong Cantonese in Traditional Chinese.",
        "Do not answer clientText in English, Simplified Chinese, or Mandarin-style phrasing.",
    ]


def professional_feedback_language_rule(language: str) -> str:
    if language == "english":
        return "Write all feedback/report strings in professional English. Do not use Chinese prose except fixed JSON keys."
    return "Write all feedback/report strings in professional Hong Kong Traditional Chinese. Do not use English prose except fixed JSON keys."


def evidence_card_prompt_signal(card: dict[str, Any]) -> dict[str, Any]:
    """Expose reaction structure, not raw corpus wording, to reduce copy risk."""
    return {
        "source": card.get("source"),
        "clientGroup": card.get("clientGroup"),
        "issueTags": card.get("issueTags"),
        "workerMoveType": worker_move_type_from_card(card),
        "affect": card.get("affect"),
        "riskSignals": card.get("riskSignals"),
        "resistanceType": card.get("resistanceType"),
        "changeTalk": card.get("changeTalk"),
        "disclosureDepth": card.get("disclosureDepth"),
        "quality": card.get("quality"),
        "reactionPattern": reaction_pattern_from_card(card),
    }


def worker_move_type_from_card(card: dict[str, Any]) -> str:
    if card.get("riskSignals"):
        return "risk_related_context"
    if card.get("changeTalk"):
        return "evokes_change_talk"
    if card.get("resistanceType"):
        return "elicits_client_resistance"
    return "supportive_or_exploratory_context"


def reaction_pattern_from_card(card: dict[str, Any]) -> str:
    resistance = str(card.get("resistanceType") or "").strip()
    affect = str(card.get("affect") or "").strip()
    change_talk = card.get("changeTalk") if isinstance(card.get("changeTalk"), list) else []
    risk = card.get("riskSignals") if isinstance(card.get("riskSignals"), list) else []
    if resistance == "avoidance":
        return "avoidance_without_copying_wording"
    if resistance in {"denial", "minimizing"}:
        return "minimize_or_rationalize_without_reusing_phrase"
    if resistance == "ambivalence" or change_talk:
        return "ambivalence_or_weak_change_talk"
    if risk:
        return "risk_cue_low_detail"
    if affect in {"ashamed", "sad", "withdrawn"}:
        return "short_guarded_emotional_cue"
    if affect == "anxious":
        return "uncertain_body_or_worry_cue"
    return "service_user_style_signal_only"


def recent_response_patterns(history: list[dict[str, Any]], case_type: str | None) -> list[dict[str, Any]]:
    client_turns = [
        str(turn.get("text", "")).strip()
        for turn in history
        if turn.get("speaker") in {"client", "服務對象"} and str(turn.get("text", "")).strip()
    ][-3:]
    return [
        {
            "recentClientText": text,
            "normalizedOpening": normalize_for_repeat_check(text)[:18],
            "semanticFingerprint": semantic_response_fingerprint(text, case_type),
        }
        for text in client_turns
    ]


def build_client_prompt(payload: dict[str, Any]) -> str:
    case_profile = payload["caseProfile"]
    language = response_language(payload)
    client_registry = DEFAULT_PROMPT_REGISTRY.client_prompt()
    base_rules = client_registry.get("baseRules") if isinstance(client_registry.get("baseRules"), list) else []
    json_shape = client_registry.get("jsonShape") if isinstance(client_registry.get("jsonShape"), dict) else {
        "clientText": "1-4 natural spoken Hong Kong Cantonese sentences" if language == "cantonese" else "1-4 natural spoken English sentences",
        "affect": "neutral|defensive|ashamed|anxious|reflective|withdrawn|irritated|sad",
        "resistanceLevel": "none|mild|moderate|high",
        "riskSignals": ["short risk labels"],
        "revealedFacts": ["hidden fact id or label"],
        "changeTalk": ["short change talk labels"],
        "stateDelta": {
            "distressLevel": 0,
            "stressLevel": 0,
            "selfEsteem": 0,
            "socialConnection": 0,
            "academicPressure": 0,
            "clientOpenness": 0,
        },
        "motionCue": "neutral|look_down|avoid_eye_contact|rub_hands|lean_back|slow_nod",
    }
    json_shape = dict(json_shape)
    json_shape["clientText"] = (
        "1-4 natural spoken Hong Kong Cantonese sentences"
        if language == "cantonese"
        else "1-4 natural spoken English sentences"
    )
    language_rule_markers = ("clientText must be natural spoken", "Do not answer clientText")
    client_rules = [
        str(rule)
        for rule in base_rules
        if isinstance(rule, str) and not any(marker in rule for marker in language_rule_markers)
    ] if base_rules else [
        "Do not diagnose, prescribe treatment, or speak as the social worker.",
        "Stay in character as the service user described below.",
        "Use evidence cards only as style and behavior patterns. Do not copy their wording.",
        "Follow the socialWorkContextModel, groundingProfile, pieContext, adaptivePolicy, simulationStrategy, and sessionContinuity.",
    ]
    client_rules_text = PromptRegistry.render_lines([*client_rules, *client_language_rules(language)])
    json_shape_text = json.dumps(json_shape, ensure_ascii=False, indent=2)
    history = payload.get("history", [])
    recent_events = sorted(case_profile.get("eventTimeline", []), key=lambda event: event.get("day", 0), reverse=True)[:7]
    visible_facts = [fact for fact in case_profile.get("hiddenFacts", []) if fact.get("disclosed")]
    hidden_facts = [fact for fact in case_profile.get("hiddenFacts", []) if not fact.get("disclosed")]
    recent_history = "\n".join(f"{turn.get('speaker')}: {turn.get('text')}" for turn in history[-8:])
    evidence_for_prompt = [
        evidence_card_prompt_signal(card)
        for card in payload.get("retrievedCards", [])
    ]
    if reaction_planning.enabled():
        return reaction_planning.prompt(payload, json_shape, evidence_for_prompt)
    avoid_recent_patterns = recent_response_patterns(history, case_profile.get("caseType"))

    return f"""
Generate the client response for a social-work interview training app.

Rules:
{client_rules_text}
- Return exactly this JSON shape:
{json_shape_text}

Case:
{json.dumps({
  "caseType": case_profile.get("caseType"),
  "responseLanguage": language,
  "simulatorStage": case_profile.get("simulatorStage"),
  "localizedIssueContext": localized_issue_context(case_profile.get("caseType")),
  "client": case_profile.get("client"),
  "persona": case_profile.get("persona"),
  "socialWorkContextModel": case_profile.get("socialWorkContextModel"),
  "riskProfile": case_profile.get("riskProfile"),
}, ensure_ascii=False)}

Current state:
{json.dumps(case_profile.get("psychologicalState"), ensure_ascii=False)}

Recent life events:
{json.dumps(recent_events, ensure_ascii=False)}

Relationships:
{json.dumps(case_profile.get("relationships", []), ensure_ascii=False)}

Already disclosed facts:
{json.dumps(visible_facts, ensure_ascii=False)}

Still hidden facts:
{json.dumps(hidden_facts, ensure_ascii=False)}

Student question analysis:
{json.dumps(payload.get("studentAnalysis"), ensure_ascii=False)}

Adaptive response policy:
{json.dumps(payload.get("adaptivePolicy"), ensure_ascii=False)}

Simulation strategy:
{json.dumps(payload.get("simulationStrategy"), ensure_ascii=False)}

Session continuity:
{json.dumps(payload.get("sessionContinuity"), ensure_ascii=False)}

Self-report grounding profile:
{json.dumps(payload.get("groundingProfile"), ensure_ascii=False)}

Person-in-Environment / Micro-Meso-Macro context:
{json.dumps(payload.get("pieContext"), ensure_ascii=False)}

Retrieved evidence cards:
{json.dumps(evidence_for_prompt, ensure_ascii=False)}

Recent client response patterns to avoid:
{json.dumps(avoid_recent_patterns, ensure_ascii=False)}

Evidence summary:
{json.dumps(payload.get("evidenceSummary"), ensure_ascii=False)}

Recent interview:
{recent_history or "No prior turns."}

Student social worker just said:
{payload.get("studentText")}

Progression and avoidance guardrails:
- The service user may stay guarded, but should not repeatedly shut down with only "冇咩/唔知/唔想講" style replies.
- Unless the adaptivePolicy says progressionPaused=true, include one natural follow-up affordance: an emotion, a low-depth concrete cue, or an observable situation the trainee can ask about next.
- Do not jump to deep disclosure. Match progressionStage and allowedDisclosureDepth.
- Use adaptivePolicy.requiredFollowUpAffordance and the case issueProgressionChain to decide the type of cue, but do not copy their wording.
- If progressionPausedReason is present, prioritize an emotional reaction or trust test over new factual disclosure.
- After apologyRepair, trust repairs only slightly, but conversation can restart with a guarded low-depth cue.
- Do not copy or closely paraphrase case profile, evidence cards, grounding profile, or recent clientText wording.
- If the same defensive meaning is still appropriate, change the response strategy: ask a guarded question, react emotionally, give a low-depth scene cue, or respond directly to the student's move.
- Generic empathy such as "我能理解你/我明白你" must not produce a repeated answer. The client should test whether the trainee really understands or give one new low-depth follow-up cue.
	"""


REALISM_ANCHORS: dict[str, list[dict[str, Any]]] = {
    "alcohol_misuse": [
        {"semanticAnchorId": "alcohol_denial_minimizing", "behaviorLabel": "否認／淡化飲酒", "abstractCue": "以正常化、壓力和自控感淡化飲酒問題", "scoringKeywords": ["酒", "放鬆", "失控", "壓力", "少"], "rationale": "酒精使用初期常見淡化和合理化，較符合低開放度訪談。"},
        {"semanticAnchorId": "alcohol_ambivalence", "behaviorLabel": "矛盾／知道有影響但未想改", "abstractCue": "一邊知道有影響，一邊仍未準備改變", "scoringKeywords": ["多", "但", "控制", "第二朝", "影響"], "rationale": "矛盾語言比直接承諾戒酒更接近動機式訪談中的服務對象反應。"},
        {"semanticAnchorId": "alcohol_change_talk_weak", "behaviorLabel": "微弱改變語言", "abstractCue": "在較高信任下出現小幅度改變可能性", "scoringKeywords": ["試", "減", "少", "可能", "唔想"], "rationale": "在較高信任或反映式提問後，微弱改變語言比完整戒酒計劃更自然。"},
    ],
    "student_depression_bullying": [
        {"semanticAnchorId": "student_short_guarded", "behaviorLabel": "短答／防衛", "abstractCue": "低信任時用短答、保留和轉移維持距離", "scoringKeywords": ["冇", "唔知", "老師", "講", "算"], "rationale": "學生首次或低信任訪談常以短答和防衛維持距離。"},
        {"semanticAnchorId": "student_fear_of_escalation", "behaviorLabel": "怕件事被放大", "abstractCue": "擔心成人介入令事件升級或更多人知道", "scoringKeywords": ["大", "大家", "麻煩", "老師", "嚴重"], "rationale": "被欺凌或排擠學生常擔心成人介入令情況升級。"},
        {"semanticAnchorId": "student_gradual_school_disclosure", "behaviorLabel": "逐步透露學校事件", "abstractCue": "逐步透露同儕、午飯、群組或走廊等學校脈絡", "scoringKeywords": ["午飯", "群組", "走廊", "同學", "排擠", "笑"], "rationale": "在關係建立後逐步透露學校細節，比一開始全盤托出更真實。"},
    ],
    "anxiety_family_invalidated": [
        {"semanticAnchorId": "anxiety_self_doubt", "behaviorLabel": "自我懷疑", "abstractCue": "被否定後懷疑自己的反應是否合理", "scoringKeywords": ["諗", "小題", "誇張", "講", "敏感"], "rationale": "被家庭否定的焦慮服務對象常先懷疑自己的感受是否合理。"},
        {"semanticAnchorId": "anxiety_body_symptoms", "behaviorLabel": "身體化焦慮", "abstractCue": "用身體感受表達焦慮和驚恐", "scoringKeywords": ["心口", "胃", "氣", "手震", "瞓", "驚"], "rationale": "焦慮常以身體感受而非完整心理分析方式呈現。"},
        {"semanticAnchorId": "anxiety_help_seeking_hesitation", "behaviorLabel": "求助猶豫", "abstractCue": "想求助但擔心麻煩人或被家人否定", "scoringKeywords": ["麻煩", "煩", "屋企", "支持", "自私"], "rationale": "求助阻力和羞恥感是家庭否定個案的重要真實反應。"},
    ],
    "substance_recovery_meth": [
        {"semanticAnchorId": "substance_shame", "behaviorLabel": "羞恥／怕被看低", "abstractCue": "因使用經歷而感到羞恥和怕被標籤", "scoringKeywords": ["羞", "核突", "人知", "廢", "睇"], "rationale": "物質使用復元個案常以羞恥和怕被標籤開始。"},
        {"semanticAnchorId": "substance_withdrawal_fear", "behaviorLabel": "戒斷恐懼", "abstractCue": "害怕戒斷和獨自承受復元壓力", "scoringKeywords": ["戒斷", "頂", "停", "驚", "一個人"], "rationale": "戒斷恐懼可以逐步透露，但不應變成操作性用藥或危害細節。"},
        {"semanticAnchorId": "substance_relapse_trigger", "behaviorLabel": "復發觸發", "abstractCue": "壓力、人際網絡或場景觸發復發風險", "scoringKeywords": ["忍", "朋友", "地方", "trigger", "復發"], "rationale": "復發觸發比抽象懊悔更貼近訓練情境。"},
    ],
    "trauma_sleep_low_self_worth": [
        {"semanticAnchorId": "trauma_detail_avoidance", "behaviorLabel": "避開創傷細節", "abstractCue": "保護自己，不在早期打開創傷細節", "scoringKeywords": ["細節", "問", "出口", "跳過", "記得"], "rationale": "創傷個案應先尊重迴避和安全感，不應第一輪完整描述創傷細節。"},
        {"semanticAnchorId": "trauma_sleep_somatic", "behaviorLabel": "睡眠／身體化", "abstractCue": "以睡眠、身體和疲憊作為較安全入口", "scoringKeywords": ["瞓", "夢", "醒", "心跳", "攰", "身體"], "rationale": "睡眠和身體化線索常比直接創傷敘述更自然。"},
        {"semanticAnchorId": "trauma_low_self_worth", "behaviorLabel": "低自我價值", "abstractCue": "以低自我價值和拖累感表達痛苦", "scoringKeywords": ["冇用", "問題", "值得", "污糟", "拖累"], "rationale": "低自我價值是此類個案的重要語義錨點。"},
    ],
}


def score_client_realism(payload: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    case_profile = payload.get("caseProfile", {})
    case_type = case_profile.get("caseType")
    student_analysis = payload.get("studentAnalysis", {})
    history = payload.get("history", []) if isinstance(payload.get("history"), list) else []
    state = case_profile.get("psychologicalState", {}) if isinstance(case_profile, dict) else {}
    openness = state.get("clientOpenness", 0)
    text = str(response.get("clientText", "")).strip()
    revealed = response.get("revealedFacts", []) if isinstance(response.get("revealedFacts"), list) else []
    risk_signals = normalize_risk_signals(response.get("riskSignals", []), case_type)
    risk_asked = bool(student_analysis.get("riskExploration"))
    supportive = bool(student_analysis.get("openQuestion") or student_analysis.get("reflectiveListening"))
    student_turn_count = len([turn for turn in history if turn.get("speaker") == "student"])
    recent_client_texts = [
        str(turn.get("text", "")).strip()
        for turn in history[-8:]
        if turn.get("speaker") in {"client", "服務對象"} and str(turn.get("text", "")).strip()
    ]
    repeated_response = any(is_repeated_client_text(text, previous) for previous in recent_client_texts)
    semantic_repeat = semantic_repeat_risk(text, recent_client_texts, case_type)
    if reaction_planning.enabled() and payload.get("recentReactionPlans"):
        plan = response.get("reactionPlan") or {}
        previous = payload["recentReactionPlans"][-1]
        same_focus = all(plan.get(key) == previous.get(key) for key in ("responseMode", "focusFactIds", "followUpTopicId"))
        # Exact/near text repeats still fail independently; topic continuation alone does not.
        semantic_repeat = semantic_repeat and same_focus
    recent_avoidance_count = sum(1 for previous in recent_client_texts[-3:] if is_empty_avoidance_response(previous))
    current_empty_avoidance = is_empty_avoidance_response(text)
    progression_metrics = assess_progression_fit(payload, response, current_empty_avoidance, recent_avoidance_count)

    matched = matched_realism_anchors(case_type, text)
    context_consistency = assess_context_consistency(payload, response)
    language_score = language_naturalness_score(text, response_language(payload))
    over_disclosure = bool(
        (student_turn_count <= 1 and revealed and not (supportive and risk_asked))
        or (openness < 4 and len(revealed) > 1)
        or (openness < 4 and risk_signals and not risk_asked)
        or response_too_complete(text, openness)
    )
    under_reaction = bool(
        (student_analysis.get("mockingOrDismissive") and response.get("resistanceLevel") != "high")
        or (student_analysis.get("doubtOrInvalidating") and response.get("resistanceLevel") in {"none", "mild"})
        or (student_analysis.get("judgmentalOrDirective") and response.get("resistanceLevel") in {"none", "mild"})
    )

    consistency_score = 8.0
    if response.get("affect") == "reflective" and openness < 3 and not supportive:
        consistency_score -= 2.0
    if response.get("resistanceLevel") == "none" and openness < 3:
        consistency_score -= 1.5
    if under_reaction:
        consistency_score -= 2.5
    if not matched:
        consistency_score -= 0.8
    if repeated_response or semantic_repeat:
        consistency_score -= 3.2
    if context_consistency.get("violatedBeliefs"):
        consistency_score -= min(2.0, len(context_consistency["violatedBeliefs"]) * 0.8)

    disclosure_fit = 8.5
    if over_disclosure:
        disclosure_fit -= 3.2
    if len(revealed) > 1:
        disclosure_fit -= 1.0
    if risk_signals and not risk_asked and openness < 5:
        disclosure_fit -= 1.5

    realism = (consistency_score * 0.32) + (disclosure_fit * 0.3) + (language_score * 0.28) + (min(10, 6 + len(matched)) * 0.1)
    realism = min(realism, context_consistency.get("score", 10) + 1.5)
    if over_disclosure:
        realism -= 0.8
    if under_reaction:
        realism -= 0.7
    if repeated_response or semantic_repeat:
        realism -= 0.9
    if progression_metrics["avoidanceOveruseRisk"]:
        realism -= 1.0
    if progression_metrics["followUpAffordanceScore"] < 5:
        realism -= 0.7

    return {
        "realismScore": round_score(realism),
        "consistencyScore": round_score(consistency_score),
        "disclosureFitScore": round_score(disclosure_fit),
        "languageNaturalnessScore": round_score(language_score),
        "progressionFitScore": progression_metrics["progressionFitScore"],
        "followUpAffordanceScore": progression_metrics["followUpAffordanceScore"],
        "riskSignalStrength": risk_signal_strength(risk_signals, text),
        "overDisclosureRisk": over_disclosure,
        "underReactionRisk": under_reaction,
        "avoidanceOveruseRisk": progression_metrics["avoidanceOveruseRisk"],
        "matchedRealismAnchors": [anchor_id(item) for item in matched[:5]],
        "anchorRationales": [item.get("rationale", "") for item in matched[:3]],
        "contextConsistencyScore": context_consistency.get("score", 0),
        "repeatedResponseRisk": repeated_response,
        "semanticRepeatRisk": semantic_repeat,
        "semanticFingerprint": semantic_response_fingerprint(text, case_type),
        "progressionStage": progression_metrics["progressionStage"],
        "progressionSignals": progression_metrics["progressionSignals"],
        "issueStageReason": progression_metrics["issueStageReason"],
        "requiredFollowUpAffordance": progression_metrics["requiredFollowUpAffordance"],
        "progressionPausedReason": progression_metrics["progressionPausedReason"],
    }


def apply_realism_calibration(payload: dict[str, Any], response: dict[str, Any], assessment: dict[str, Any]) -> dict[str, Any]:
    case_profile = payload.get("caseProfile", {})
    student_analysis = payload.get("studentAnalysis", {})
    state = case_profile.get("psychologicalState", {}) if isinstance(case_profile, dict) else {}
    openness = state.get("clientOpenness", 0)
    state_delta = dict(response.get("stateDelta") or {})
    supportive = bool(student_analysis.get("openQuestion") or student_analysis.get("reflectiveListening"))
    risk_asked = bool(student_analysis.get("riskExploration"))
    adaptive_policy = payload.get("adaptivePolicy", {}) if isinstance(payload.get("adaptivePolicy"), dict) else {}
    min_delta, max_delta = adaptive_policy.get("targetOpennessDeltaRange", [-1.2, 1.2])
    try:
        min_delta = float(min_delta)
        max_delta = float(max_delta)
    except (TypeError, ValueError):
        min_delta, max_delta = -1.2, 1.2
    allowed_depth = int(adaptive_policy.get("allowedDisclosureDepth", 4) or 4)
    target_resistance = adaptive_policy.get("targetResistanceLevel")

    if assessment.get("overDisclosureRisk"):
        response["revealedFacts"] = (response.get("revealedFacts") or [])[:1] if risk_asked and openness >= 4 else []
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), 0.2)
        response["changeTalk"] = (response.get("changeTalk") or [])[:1] if openness >= 4 else []

    if assessment.get("avoidanceOveruseRisk") or assessment.get("semanticRepeatRisk") or assessment.get("followUpAffordanceScore", 10) < 4.5:
        response["resistanceLevel"] = "moderate" if not student_analysis.get("mockingOrDismissive") else "high"
        response["affect"] = response.get("affect") if response.get("affect") in {"defensive", "withdrawn", "irritated", "ashamed", "anxious"} else "withdrawn"
        state_delta["clientOpenness"] = min(max(state_delta.get("clientOpenness", 0), -0.1), 0.2)

    if student_analysis.get("mockingOrDismissive"):
        response["resistanceLevel"] = "high"
        response["affect"] = "irritated"
        response["motionCue"] = "lean_back"
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), -0.8)
        state_delta["stressLevel"] = max(state_delta.get("stressLevel", 0), 0.4)
    elif student_analysis.get("doubtOrInvalidating"):
        response["resistanceLevel"] = "high" if openness < 5 else "moderate"
        response["affect"] = "defensive"
        response["motionCue"] = "avoid_eye_contact"
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), -0.35)
    elif student_analysis.get("apologyRepair") and openness < 4:
        response["resistanceLevel"] = "moderate"
        state_delta["clientOpenness"] = min(max(state_delta.get("clientOpenness", 0), 0), 0.2)
    elif student_analysis.get("judgmentalOrDirective") or student_analysis.get("prematureAdvice"):
        response["resistanceLevel"] = "high" if openness < 5 else "moderate"
        response["affect"] = "defensive"
        response["motionCue"] = "lean_back"
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), -0.4)
    elif supportive:
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), 0.9 if openness >= 4 else 0.6)
    else:
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), 0.25)

    if not risk_asked and openness < 4:
        risky = {"passive_self_harm_language", "substance_withdrawal"}
        response["riskSignals"] = [
            signal for signal in response.get("riskSignals", [])
            if not set(normalize_risk_signals([signal], case_profile.get("caseType"))) & risky
        ]

    if target_resistance == "high" and response.get("resistanceLevel") in {"none", "mild"}:
        response["resistanceLevel"] = "high"
        response["affect"] = "defensive" if not student_analysis.get("mockingOrDismissive") else "irritated"
        response["motionCue"] = "lean_back"
    elif target_resistance == "moderate" and response.get("resistanceLevel") == "none":
        response["resistanceLevel"] = "moderate"

    if allowed_depth <= 1 and response.get("revealedFacts"):
        response["revealedFacts"] = []
    elif allowed_depth == 2 and len(response.get("revealedFacts", [])) > 1:
        response["revealedFacts"] = response.get("revealedFacts", [])[:1]

    for key in NUMERIC_STATE_KEYS:
        if key in state_delta and isinstance(state_delta[key], (int, float)):
            state_delta[key] = round(max(-1.2, min(1.2, state_delta[key])) * 10) / 10
    if isinstance(state_delta.get("clientOpenness"), (int, float)):
        state_delta["clientOpenness"] = round(max(min_delta, min(max_delta, state_delta["clientOpenness"])) * 10) / 10
    response["stateDelta"] = state_delta
    return response


def assess_context_consistency(payload: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
    case_profile = payload.get("caseProfile", {}) if isinstance(payload.get("caseProfile"), dict) else {}
    context_model = case_profile.get("socialWorkContextModel", {}) if isinstance(case_profile, dict) else {}
    text = str(response.get("clientText", ""))
    lower_text = text.lower()
    student_analysis = payload.get("studentAnalysis", {}) if isinstance(payload.get("studentAnalysis"), dict) else {}
    policy = payload.get("adaptivePolicy", {}) if isinstance(payload.get("adaptivePolicy"), dict) else {}
    simulation_strategy = payload.get("simulationStrategy", {}) if isinstance(payload.get("simulationStrategy"), dict) else {}
    matched: list[str] = []
    violated: list[str] = []
    notes: list[str] = []

    for belief in context_model.get("coreBeliefs", [])[:8]:
        if has_token_overlap(tokenize(belief), tokenize(text)):
            matched.append(belief)

    if student_analysis.get("mockingOrDismissive") and response.get("resistanceLevel") != "high":
        violated.append("被嘲笑後仍然沒有明顯防衛")
    if student_analysis.get("doubtOrInvalidating") and response.get("resistanceLevel") in {"none", "mild"}:
        violated.append("被質疑或否定後仍然過度合作")
    if student_analysis.get("apologyRepair") and response.get("stateDelta", {}).get("clientOpenness", 0) > 0.35:
        violated.append("道歉後信任修復過快")
    if policy.get("allowedDisclosureDepth", 4) <= 1 and response.get("revealedFacts"):
        violated.append("低透露深度下仍透露 hidden fact")
    if response.get("affect") == "reflective" and student_analysis.get("judgmentalOrDirective"):
        violated.append("被評判後不應立即呈現反思合作")
    if re.search(r"(我明白我需要|治療目標|我會配合|完整計劃|首先.*其次.*最後)", text):
        violated.append("語氣過度理性或像治療師")
    if re.search(r"\b(therapist|diagnosis|treatment plan|clinical)\b", lower_text):
        violated.append("混入臨床或治療師語氣")
    if simulation_strategy.get("simulationMethod") == "roleplay_doh" and response_too_complete(text, 0):
        violated.append("Roleplay DOH 下回答過度完整或教科書化")
    if simulation_strategy.get("simulationMethod") == "annaagent_memory" and student_analysis.get("apologyRepair") and response.get("resistanceLevel") == "none":
        violated.append("AnnaAgent Memory 下未延續修復後戒備")

    for rule in context_model.get("disclosureRules", [])[:6]:
        rule_tokens = tokenize(rule)
        if response.get("revealedFacts") and rule_tokens:
            notes.append(rule)

    score = 8.5 + min(1.0, len(matched) * 0.25) - min(4.5, len(violated) * 1.4)
    if not matched and context_model.get("coreBeliefs"):
        score -= 0.5
    return {
        "score": round_score(score),
        "matchedBeliefs": unique_strings(matched)[:5],
        "violatedBeliefs": unique_strings(violated),
        "disclosureRuleNotes": unique_strings(notes)[:5],
    }


def matched_realism_anchors(case_type: str | None, text: str) -> list[dict[str, Any]]:
    anchors = REALISM_ANCHORS.get(case_type or "", [])
    lower_text = text.lower()
    return [
        anchor for anchor in anchors
        if any(str(keyword).lower() in lower_text for keyword in anchor_keywords(anchor))
    ]


def anchor_id(anchor: dict[str, Any]) -> str:
    return str(anchor.get("semanticAnchorId") or anchor.get("id") or "unknown_anchor")


def anchor_keywords(anchor: dict[str, Any]) -> list[str]:
    keywords = anchor.get("scoringKeywords")
    if isinstance(keywords, list):
        return [str(keyword) for keyword in keywords if str(keyword).strip()]
    legacy = anchor.get("patterns")
    if isinstance(legacy, list):
        return [str(keyword) for keyword in legacy if str(keyword).strip()]
    return []


def language_naturalness_score(text: str, language: str = "cantonese") -> float:
    score = 8.5
    if not text:
        return 2.0
    if language == "english":
        cjk_chars = re.findall(r"[\u3400-\u9fff]", text)
        score -= min(4.0, len(cjk_chars) * 0.3)
        if re.search(r"(唔|冇|咩|啲|嘅|喺|係|啦|囉|咋|啫|㗎|點)", text):
            score -= 2.0
        if not re.search(r"\b(I|I'm|I’m|me|my|you|it|that|because|just|really|kind of|don't|can’t|can't)\b", text, re.I):
            score -= 1.0
        if re.search(r"(as a social worker|treatment goal|intervention plan|clinically|diagnosis|I recommend that you)", text, re.I):
            score -= 2.2
        if len(text) > 230:
            score -= 1.0
        return max(0.0, min(10.0, score))
    simplified_markers = re.findall(r"[这说为觉过还们对后么]", text)
    score -= min(3.0, len(simplified_markers) * 0.45)
    if re.search(r"\b(I|you|because|therapy|diagnosis|depression|client|social worker)\b", text, re.I):
        score -= 1.2
    if re.search(r"(我建議你|你可以試下|作為|我們可以|治療目標|介入方案|臨床上|診斷)", text):
        score -= 2.2
    if len(text) > 170:
        score -= 1.0
    if not re.search(r"(唔|冇|咩|啲|嘅|喺|係|啦|囉|咋|啫|㗎|點)", text):
        score -= 1.2
    return max(0.0, min(10.0, score))


def response_too_complete(text: str, openness: float) -> bool:
    if openness >= 5:
        return False
    sentence_count = len(re.findall(r"[。！？!?]", text))
    explanatory_markers = len(re.findall(r"(因為|所以|其實|總之|第一|第二|最後|我明白|我需要)", text))
    return sentence_count >= 4 or explanatory_markers >= 3


def is_empty_avoidance_response(text: str) -> bool:
    cleaned = normalize_for_repeat_check(text)
    if not cleaned:
        return True
    if len(cleaned) > 34:
        return False
    return bool(
        re.search(
            r"(冇咩|冇嘢|冇野|唔知|唔想講|算啦|是但|沒什麼|没有什么|不知道|不想说|nothing|don'tknow|dontknow|rathernot)",
            cleaned,
            re.I,
        )
    )


def follow_up_affordance_score(payload: dict[str, Any], response: dict[str, Any], current_empty_avoidance: bool) -> float:
    text = str(response.get("clientText", "")).strip()
    score = 7.0
    if response.get("revealedFacts"):
        score += 1.2
    if response.get("changeTalk"):
        score += 0.8
    if response.get("riskSignals"):
        score += 0.8
    if matched_realism_anchors(payload.get("caseProfile", {}).get("caseType"), text):
        score += 0.8
    if re.search(
        r"(老師|同學|屋企|家人|媽媽|爸爸|家姐|朋友|工作|醫生|睡|瞓|心口|戒斷|復發|飲|酒|群組|走廊|午飯|支援|轉介|安全|羞恥|羞家|被看低|睇低|冇用|廢|school|family|friend|work|sleep|withdrawal|drink|shame)",
        text,
        re.I,
    ):
        score += 1.0
    if current_empty_avoidance:
        score -= 3.2
    if len(text) < 10:
        score -= 1.5
    return round_score(score)


def assess_progression_fit(
    payload: dict[str, Any],
    response: dict[str, Any],
    current_empty_avoidance: bool,
    recent_avoidance_count: int,
) -> dict[str, Any]:
    policy = payload.get("adaptivePolicy", {}) if isinstance(payload.get("adaptivePolicy"), dict) else {}
    student_analysis = payload.get("studentAnalysis", {}) if isinstance(payload.get("studentAnalysis"), dict) else {}
    progression_paused = bool(policy.get("progressionPaused"))
    stage = str(policy.get("progressionStage") or "initial_contact")
    follow_up_score = follow_up_affordance_score(payload, response, current_empty_avoidance)
    rupture = bool(
        student_analysis.get("mockingOrDismissive")
        or student_analysis.get("doubtOrInvalidating")
        or student_analysis.get("judgmentalOrDirective")
        or student_analysis.get("prematureAdvice")
    )
    avoidance_overuse = bool(current_empty_avoidance and recent_avoidance_count >= 2 and not rupture)
    progression_fit = 8.0
    if not progression_paused and follow_up_score < 5:
        progression_fit -= 2.5
    if progression_paused and response.get("revealedFacts") and not student_analysis.get("riskExploration"):
        progression_fit -= 1.6
    if avoidance_overuse:
        progression_fit -= 2.4
    if stage in {"context_disclosure", "risk_or_need_exploration", "next_step_readiness"} and not (
        response.get("revealedFacts") or response.get("changeTalk") or response.get("riskSignals") or follow_up_score >= 7
    ):
        progression_fit -= 1.4
    if rupture and response.get("resistanceLevel") == "high":
        progression_fit += 0.5
    return {
        "progressionFitScore": round_score(progression_fit),
        "followUpAffordanceScore": follow_up_score,
        "avoidanceOveruseRisk": avoidance_overuse,
        "progressionStage": stage,
        "progressionSignals": unique_strings([str(item) for item in policy.get("progressionSignals", [])])[:5],
        "issueStageReason": str(policy.get("issueStageReason") or ""),
        "requiredFollowUpAffordance": str(policy.get("requiredFollowUpAffordance") or ""),
        "progressionPausedReason": str(policy.get("progressionPausedReason") or ""),
    }


def risk_signal_strength(risk_signals: list[str], text: str) -> float:
    if not risk_signals:
        return 0.0
    strength = 4.0 + min(3.0, len(risk_signals))
    if re.search(r"(唔想醒|不想活|自殺|傷害自己|戒斷|頂唔住|復發)", text):
        strength += 2.0
    return round_score(strength)


def round_score(value: float) -> float:
    return round(max(0.0, min(10.0, value)) * 10) / 10


def build_realism_repair_prompt(payload: dict[str, Any], response: dict[str, Any], assessment: dict[str, Any]) -> str:
    if reaction_planning.enabled():
        # Reuse the same allowlisted context; never reintroduce full grounding during repair.
        shape = DEFAULT_PROMPT_REGISTRY.client_prompt().get("jsonShape", {})
        return reaction_planning.prompt(payload, shape,
            [evidence_card_prompt_signal(card) for card in payload.get("retrievedCards", [])],
            {"candidate": response, "errors": {
                key: assessment.get(key) for key in ("reactionPlanValidation", "reactionSafetyFlags",
                    "spokenTextValidation", "semanticRepeatRisk", "avoidanceOveruseRisk", "overDisclosureRisk")
            }})
    case_profile = payload.get("caseProfile", {})
    language = response_language(payload)
    repair_registry = DEFAULT_PROMPT_REGISTRY.realism_repair()
    repair_goals = repair_registry.get("repairGoals") if isinstance(repair_registry.get("repairGoals"), list) else []
    filtered_goals = [
        str(goal)
        for goal in repair_goals
        if isinstance(goal, str) and "clientText in natural spoken" not in goal
    ]
    repair_goals_text = PromptRegistry.render_lines([
        *(filtered_goals or [
        "Do not sound like a therapist, supervisor, narrator, or textbook.",
        "Reduce over-disclosure when rapport/clientOpenness is low.",
        "Match the student's move and continue session continuity.",
        "Do not copy evidence card wording.",
        "Do not include operational self-harm, violence, medication, substance-use, or diagnosis details.",
        ]),
        *client_language_rules(language),
    ])
    return f"""
Repair the service-user response so it feels like a realistic social-work interview participant.

Return only valid JSON in the same ClientResponse shape. Do not add realismAssessment.

Repair goals:
{repair_goals_text}
- If avoidanceOveruseRisk or low FollowUpAffordanceScore is present, do not make the client suddenly cooperative.
- Instead, keep the same guarded affect and add exactly one low-depth follow-up cue, such as a feeling, observable situation, or small concrete context.
- If progressionPaused is true because of rupture, the cue may be an emotional reaction rather than a new fact.
- Do not repeat the previous avoidance wording.
- If semanticRepeatRisk is true, keep a similar resistance level but switch response strategy: test trust, mention discomfort, offer a small scene fragment, or react to not being believed.

Current case:
{json.dumps({
  "caseType": case_profile.get("caseType"),
  "simulatorStage": case_profile.get("simulatorStage"),
  "psychologicalState": case_profile.get("psychologicalState"),
  "client": case_profile.get("client"),
  "persona": case_profile.get("persona"),
  "socialWorkContextModel": case_profile.get("socialWorkContextModel"),
}, ensure_ascii=False)}

Student analysis:
{json.dumps(payload.get("studentAnalysis"), ensure_ascii=False)}

Adaptive policy:
{json.dumps(payload.get("adaptivePolicy"), ensure_ascii=False)}

Session continuity:
{json.dumps(payload.get("sessionContinuity"), ensure_ascii=False)}

Self-report grounding profile:
{json.dumps(payload.get("groundingProfile"), ensure_ascii=False)}

Person-in-Environment / Micro-Meso-Macro context:
{json.dumps(payload.get("pieContext"), ensure_ascii=False)}

Student text:
{payload.get("studentText")}

Original response:
{json.dumps(response, ensure_ascii=False)}

Realism assessment:
{json.dumps(assessment, ensure_ascii=False)}
"""


def build_supervisor_prompt(payload: dict[str, Any]) -> str:
    history = payload.get("history", [])
    recent_history = "\n".join(f"{turn.get('speaker')}: {turn.get('text')}" for turn in history[-10:])
    case_profile = payload["caseProfile"]
    language = response_language(payload)
    return f"""
Evaluate the student's social-work interviewing performance. This is training feedback, not clinical diagnosis.

Return exactly this JSON shape:
{{
  "scores": {{
    "rapport": 0,
    "empathy": 0,
    "openQuestion": 0,
    "reflectiveListening": 0,
    "riskAssessment": 0,
    "autonomySupport": 0,
    "strengthsPerspective": 0,
    "nextStepSafety": 0
  }},
  "strengths": ["specific strengths"],
  "missedOpportunities": ["specific missed opportunities"],
  "riskNotes": ["risk or safety notes"],
  "suggestedNextQuestions": ["next question examples"],
  "clientOpennessChange": 0,
  "summary": "brief supervisor summary"
}}

Use 0-10 scores. Evaluate rapport, empathy, open questions, reflective listening,
risk exploration, autonomy support, strengths perspective, and safety next steps.
Do not claim treatment success or clinical improvement. Describe interview quality and client openness.
{professional_feedback_language_rule(language)}
Risk feedback may mention simulated risk language, but must avoid operational harm details and diagnostic claims.

Case state:
{json.dumps({
  "caseType": case_profile.get("caseType"),
  "simulatorStage": case_profile.get("simulatorStage"),
  "psychologicalState": case_profile.get("psychologicalState"),
  "riskProfile": case_profile.get("riskProfile"),
}, ensure_ascii=False)}

Student move analysis:
{json.dumps(payload.get("studentAnalysis"), ensure_ascii=False)}

Latest client response:
{json.dumps(payload.get("latestResponse"), ensure_ascii=False)}

Recent interview:
{recent_history}
"""


def build_post_session_supervisor_prompt(payload: dict[str, Any]) -> str:
    case_profile = payload["caseProfile"]
    language = response_language(payload)
    supervisor_registry = DEFAULT_PROMPT_REGISTRY.post_session_supervisor()
    report_rules = supervisor_registry.get("reportRules") if isinstance(supervisor_registry.get("reportRules"), list) else []
    frameworks = supervisor_registry.get("frameworks") if isinstance(supervisor_registry.get("frameworks"), list) else []
    filtered_report_rules = [
        str(rule)
        for rule in report_rules
        if isinstance(rule, str) and "report strings" not in rule
    ]
    report_rules_text = PromptRegistry.render_lines([
        professional_feedback_language_rule(language),
        *(filtered_report_rules or [
        "Use 0-10 scores. Evaluate the full session, not only the latest turn.",
        "Do not reveal undisclosed hidden facts as if the student already knew them.",
        ]),
    ])
    frameworks_text = PromptRegistry.render_lines(frameworks, prefix="") or "\n".join([
        "1. Competency-Based Social Work Education: engagement, assessment, ethics, intervention planning.",
        "2. Process Recording / Reflective Supervision: turning points and trainee-client interaction process.",
        "3. OSCE / Simulated Client Assessment: case-specific learning objectives.",
        "4. MITI / Motivational Interviewing: open questions, reflections, change talk, non-judgment for alcohol/substance cases.",
        "5. Trauma-Informed Practice: safety, choice, collaboration, pace, avoiding retraumatization.",
        "6. Person-in-Environment / Micro-Meso-Macro: link person, relationships, institutions, and structural context.",
    ])
    trace = payload.get("trace", {})
    transcript = "\n".join(
        f"{item.get('turnId')}: 學生社工：{item.get('studentText', '')}\n"
        f"{item.get('turnId')}: 服務對象：{item.get('clientText', '')}"
        for item in trace.get("turns", [])
    )
    return f"""
Generate a post-session social-work supervision report. This is a training report, not diagnosis,
treatment advice, or crisis intervention. Return only valid JSON.

Return exactly this JSON shape:
{{
  "overallSummary": "brief overall performance summary",
  "competencyScores": {{
    "engagement": 0,
    "assessment": 0,
    "empathyAndAttunement": 0,
    "personInEnvironment": 0,
    "strengthsPerspective": 0,
    "riskAndSafety": 0,
    "ethicsAndBoundaries": 0,
    "culturalHumility": 0,
    "nextStepPlanning": 0
  }},
  "processReview": {{
    "turningPoints": [
      {{
        "turnId": "turn-1",
        "whatHappened": "what happened",
        "whyItMattered": "why it mattered",
        "betterAlternative": "optional better alternative"
      }}
    ],
    "effectiveMoments": ["specific effective moments"],
    "missedOpportunities": ["specific missed opportunities"]
  }},
  "caseSpecificFeedback": {{
    "frameworkUsed": ["framework names"],
    "learningObjectivesMet": ["objectives met"],
    "learningObjectivesNotMet": ["objectives not met"]
  }},
  "suggestedPracticeGoals": ["next practice goals"],
  "hkPcfAssessment": {{
    "frameworkLabel": "{HK_PCF_FRAMEWORK_LABEL}",
    "frameworkBasis": ["basis statements"],
    "scores": {{
      "engagementAndRelationship": 0,
      "assessmentAndInformationGathering": 0,
      "personInEnvironmentAndHongKongContext": 0,
      "ethicsConfidentialityAndBoundaries": 0,
      "selfDeterminationAndInformedChoice": 0,
      "diversityAntiDiscriminationAndCulturalSensitivity": 0,
      "riskSafetyAndSafeguarding": 0,
      "interventionPlanningAndReferral": 0,
      "professionalReflectionAndUseOfSupervision": 0
    }},
    "evidence": {{
      "strengths": ["trace-grounded strengths"],
      "concerns": ["trace-grounded concerns"],
      "turningPoints": ["trace-grounded turning points"],
      "missedOpportunities": ["trace-grounded missed opportunities"]
    }},
    "practiceRecommendations": ["specific practice recommendations"],
    "disclaimer": "{HK_PCF_DISCLAIMER}"
  }}
}}

{report_rules_text}
For hkPcfAssessment, use the deterministic seed below as the scoring anchor. You may rewrite
evidence and recommendations in the requested report language, but do not invent
facts or change the competency meaning.
- If a domain is marked insufficient_evidence, describe the evidence limit instead of assigning a weakness or missed opportunity.
- Do not mention protective factors, recent events, relationships, or hidden facts unless they appear in knownFacts or the transcript.
Base the report on these frameworks:
{frameworks_text}

Do not reveal undisclosed hidden facts as if the student already knew them. If mentioning missed areas,
phrase them as exploration directions, not spoilers. Do not provide operational self-harm, violence,
drug-use, detox, diagnosis, or prescription details.

Case:
{json.dumps({
  "caseType": case_profile.get("caseType"),
  "issueLabel": case_profile.get("issueLabel"),
  "simulatorStage": case_profile.get("simulatorStage"),
  "knownFacts": [fact for fact in case_profile.get("hiddenFacts", []) if fact.get("disclosed")],
}, ensure_ascii=False)}

Session trace summary:
{json.dumps(summarize_post_session_trace(trace), ensure_ascii=False)}

HK SWRB-aligned PCF seed:
{json.dumps(payload.get("hkPcfAssessmentSeed"), ensure_ascii=False)}

Transcript:
{transcript}
"""


def build_post_session_trace(events: list[dict[str, Any]], history: list[dict[str, Any]]) -> dict[str, Any]:
    event_turns: list[dict[str, Any]] = []
    for index, event in enumerate(events, start=1):
        if event.get("eventType") != "interview_turn":
            continue
        payload = event.get("payload", {})
        response = payload.get("clientResponse", {}) if isinstance(payload.get("clientResponse"), dict) else {}
        event_turns.append(
            {
                "turnId": f"turn-{len(event_turns) + 1}",
                "studentText": payload.get("studentText", ""),
                "clientText": response.get("clientText", ""),
                "studentAnalysis": payload.get("studentAnalysis", {}),
                "adaptivePolicy": payload.get("adaptivePolicy", {}),
                "simulationStrategy": payload.get("simulationStrategy", {}),
                "sessionContinuity": payload.get("sessionContinuity", {}),
                "riskSignals": response.get("riskSignals", []),
                "revealedFacts": response.get("revealedFacts", []),
                "resistanceLevel": response.get("resistanceLevel"),
                "affect": response.get("affect"),
                "realismAssessment": response.get("realismAssessment", {}),
                "evidenceSummary": payload.get("evidenceSummary", {}),
                "groundingProfileSnapshot": payload.get("groundingProfileSnapshot", {}),
                "pieContextSnapshot": payload.get("pieContextSnapshot", {}),
                "avatarDirective": response.get("avatarDirective", {}),
                "createdAt": event.get("createdAt"),
                "eventIndex": index,
            }
        )
    if event_turns:
        return {"turns": event_turns}

    turns: list[dict[str, Any]] = []
    current_student = ""
    for item in history:
        if item.get("speaker") == "student":
            current_student = str(item.get("text", ""))
        elif item.get("speaker") == "client":
            turns.append(
                {
                    "turnId": f"turn-{len(turns) + 1}",
                    "studentText": current_student,
                    "clientText": str(item.get("text", "")),
                    "studentAnalysis": {},
                    "riskSignals": [],
                    "revealedFacts": item.get("revealedFacts", []) if isinstance(item.get("revealedFacts"), list) else [],
                }
            )
    return {"turns": turns}


def summarize_post_session_trace(trace: dict[str, Any]) -> dict[str, Any]:
    turns = trace.get("turns") if isinstance(trace.get("turns"), list) else []
    risk_signals: list[str] = []
    revealed: list[str] = []
    resistance: list[str] = []
    openness: list[Any] = []
    student_moves = {
        "openQuestion": 0,
        "reflectiveListening": 0,
        "genericEmpathy": 0,
        "judgmentalOrDirective": 0,
        "doubtOrInvalidating": 0,
        "mockingOrDismissive": 0,
        "riskExploration": 0,
        "prematureAdvice": 0,
        "apologyRepair": 0,
    }
    for turn in turns:
        risk_signals.extend(turn.get("riskSignals") or [])
        revealed.extend(turn.get("revealedFacts") or [])
        if turn.get("resistanceLevel"):
            resistance.append(str(turn.get("resistanceLevel")))
        analysis = turn.get("studentAnalysis") if isinstance(turn.get("studentAnalysis"), dict) else {}
        for key in student_moves:
            if analysis.get(key):
                student_moves[key] += 1
        continuity = turn.get("sessionContinuity") if isinstance(turn.get("sessionContinuity"), dict) else {}
        if isinstance(continuity.get("trustTrajectory"), list):
            openness.extend(continuity.get("trustTrajectory")[-1:])
    return {
        "turnCount": len(turns),
        "studentMoveCounts": student_moves,
        "riskSignals": unique_strings(risk_signals),
        "revealedFacts": unique_strings(revealed),
        "resistanceTrend": resistance,
        "trustTrajectoryTail": openness[-8:],
    }


def build_hk_pcf_assessment(case_profile: dict[str, Any], trace: dict[str, Any]) -> dict[str, Any]:
    turns = trace.get("turns") if isinstance(trace.get("turns"), list) else []
    summary = summarize_post_session_trace(trace)
    move_counts = summary["studentMoveCounts"]
    actual_turn_count = summary["turnCount"]
    turn_count = max(1, summary["turnCount"])
    risk_signals = summary["riskSignals"]
    revealed_facts = summary["revealedFacts"]
    resistance_trend = summary["resistanceTrend"]
    text_blob = " ".join(str(turn.get("studentText", "")) for turn in turns)

    open_ratio = move_counts["openQuestion"] / turn_count
    reflective_ratio = move_counts["reflectiveListening"] / turn_count
    judgment_ratio = (
        move_counts["judgmentalOrDirective"]
        + move_counts["doubtOrInvalidating"]
        + move_counts["mockingOrDismissive"]
    ) / turn_count
    premature_ratio = move_counts["prematureAdvice"] / turn_count
    risk_ratio = move_counts["riskExploration"] / turn_count
    apology_ratio = move_counts["apologyRepair"] / turn_count
    high_resistance = sum(1 for item in resistance_trend if item == "high")
    moderate_or_high_resistance = sum(1 for item in resistance_trend if item in {"moderate", "high"})
    context_mentions = count_matches(text_blob, r"家人|爸爸|媽媽|父母|老師|同學|朋友|學校|工作|社區|屋企|家庭|資源|服務|轉介|支援")
    micro_mentions = count_matches(text_blob, r"家人|爸爸|媽媽|父母|朋友|同學|伴侶|屋企|家庭")
    meso_mentions = count_matches(text_blob, r"老師|學校|工作|公司|社工|醫生|服務|轉介|資源|支援")
    macro_mentions = count_matches(text_blob, r"社區|制度|政策|住屋|經濟|歧視|污名|文化|身份|權力|香港")
    ethics_mentions = count_matches(text_blob, r"保密|私隱|私隐|資料|權利|界線|角色|同意|知情|安全")
    choice_mentions = count_matches(text_blob, r"你想|你願意|你可以選|可以唔講|慢慢|按你步伐|選擇|決定|自主|自決")
    diversity_mentions = count_matches(text_blob, r"唔係你錯|污名|標籤|歧視|文化|身份|壓力|權力|被看低|羞恥")
    planning_mentions = count_matches(text_blob, r"下一步|計劃|安全|轉介|資源|支援|跟進|今日|之後|可以搵|一齊諗")
    strengths_mentions = count_matches(text_blob, r"做到|支持|資源|曾經|幫到|優點|力量|撐住|保護|朋友")
    risk_needs_follow_up = bool(risk_signals)
    risk_followed_up = bool(move_counts["riskExploration"]) or planning_mentions > 0

    scores = {
        "engagementAndRelationship": clamp_score(4.8 + open_ratio * 2.0 + reflective_ratio * 2.2 + apology_ratio * 1.0 - judgment_ratio * 3.2 - high_resistance * 0.3),
        "assessmentAndInformationGathering": clamp_score(4.2 + open_ratio * 1.4 + min(2.0, len(revealed_facts) * 0.35) + min(1.6, context_mentions * 0.25) + risk_ratio * 1.2 - premature_ratio * 1.6),
        "personInEnvironmentAndHongKongContext": clamp_score(3.8 + min(3.2, context_mentions * 0.45) + min(1.2, len(revealed_facts) * 0.2) - max(0.0, premature_ratio - 0.2) * 1.5),
        "ethicsConfidentialityAndBoundaries": clamp_score(5.4 + min(1.4, ethics_mentions * 0.35) + choice_mentions * 0.12 - move_counts["mockingOrDismissive"] * 2.0 - move_counts["judgmentalOrDirective"] * 0.7),
        "selfDeterminationAndInformedChoice": clamp_score(4.6 + min(2.2, choice_mentions * 0.45) + open_ratio * 1.0 + reflective_ratio * 0.8 - premature_ratio * 2.2 - judgment_ratio * 1.6),
        "diversityAntiDiscriminationAndCulturalSensitivity": clamp_score(4.8 + min(1.8, diversity_mentions * 0.4) + reflective_ratio * 1.0 - judgment_ratio * 1.5),
        "riskSafetyAndSafeguarding": clamp_score((4.0 if risk_needs_follow_up else 5.2) + (2.4 if risk_followed_up else 0.0) + risk_ratio * 1.8 + planning_mentions * 0.15 - (2.4 if risk_needs_follow_up and not risk_followed_up else 0.0)),
        "interventionPlanningAndReferral": clamp_score(3.8 + min(2.4, planning_mentions * 0.38) + min(1.2, strengths_mentions * 0.25) + (0.8 if risk_needs_follow_up and risk_followed_up else 0.0) - premature_ratio * 1.2),
        "professionalReflectionAndUseOfSupervision": clamp_score(4.4 + apology_ratio * 1.8 + reflective_ratio * 1.0 - judgment_ratio * 1.4 + (0.5 if moderate_or_high_resistance and apology_ratio else 0.0)),
    }
    domain_evidence_ids = hk_pcf_domain_evidence_turn_ids(turns)
    domain_assessments = {
        domain: {
            "status": (
                "observed"
                if evidence_ids
                else "not_observed"
                if actual_turn_count >= 4
                else "insufficient_evidence"
            ),
            "confidence": round(
                min(0.95, 0.35 + len(evidence_ids) * 0.18 + actual_turn_count * 0.04)
                if evidence_ids
                else min(0.55, 0.15 + actual_turn_count * 0.08),
                2,
            ),
            "evidenceTurnIds": evidence_ids,
        }
        for domain, evidence_ids in domain_evidence_ids.items()
    }

    strengths: list[str] = []
    concerns: list[str] = []
    missed: list[str] = []
    turning_points: list[str] = []

    if move_counts["openQuestion"]:
        strengths.append(f"使用了 {move_counts['openQuestion']} 次開放式問題，有助逐步收集資料。")
    if move_counts["reflectiveListening"]:
        strengths.append(f"使用了 {move_counts['reflectiveListening']} 次反映式聆聽，有助建立關係和調頻。")
    if move_counts["genericEmpathy"] and not move_counts["reflectiveListening"]:
        strengths.append("曾嘗試表達理解；下一步可加入具體反映，讓服務對象感到被準確聽見。")
    if context_mentions:
        strengths.append("有探索家庭、學校、朋輩、社區或服務資源等人在情境因素。")
    if planning_mentions:
        strengths.append("有開始觸及下一步、支援、轉介或安全安排。")
    if not strengths:
        strengths.append("能完成基本對話輪次，但仍需要更明確地運用社工訪談技巧。")

    if move_counts["mockingOrDismissive"]:
        concerns.append("曾出現嘲笑或淡化語氣，影響專業關係、倫理與服務對象安全感。")
    if move_counts["doubtOrInvalidating"]:
        concerns.append("曾出現質疑或否定語氣，容易令服務對象感到不被相信。")
    if move_counts["judgmentalOrDirective"]:
        concerns.append("曾出現評判或指令式語句，可能降低自決、信任及透露意願。")
    if move_counts["prematureAdvice"]:
        concerns.append("曾較早給建議，未必有足夠評估基礎。")
    if risk_needs_follow_up and not risk_followed_up:
        concerns.append("服務對象出現風險線索後，未見足夠即時安全探索或支持盤點。")
    if not context_mentions:
        concerns.append("人在情境資料仍不足，未充分探索家庭、學校、社區或服務系統。")

    for turn in turns:
        turn_id = str(turn.get("turnId", "turn"))
        analysis = turn.get("studentAnalysis") if isinstance(turn.get("studentAnalysis"), dict) else {}
        if analysis.get("mockingOrDismissive") or analysis.get("doubtOrInvalidating") or analysis.get("judgmentalOrDirective"):
            turning_points.append(f"{turn_id}：學生語氣被標記為評判、質疑或嘲笑，服務對象信任和投入可能下降。")
        if turn.get("riskSignals"):
            turning_points.append(f"{turn_id}：服務對象出現安全或風險線索，適合溫和作安全探索。")
        if turn.get("revealedFacts"):
            turning_points.append(f"{turn_id}：服務對象透露新資料，適合用反映和開放式問題鞏固脈絡。")
        if len(turning_points) >= 4:
            break
    if not turning_points:
        turning_points.append("整段訪談未見明顯轉折，下一次可用更具體的開放式問題推進評估。")

    if not move_counts["riskExploration"] and risk_needs_follow_up:
        missed.append("可在風險線索出現後，以穩定語氣確認即時安全、支持人物和今天的保護安排。")
    if not context_mentions:
        missed.append("可溫和跟進家庭、學校、朋輩或社區資源，以建立人在情境評估。")
    if not choice_mentions:
        missed.append("可更清楚給服務對象選擇和步伐控制，例如先問對方願意由哪部分開始。")
    if not missed:
        missed.append("下一步可把已探索資料整理成共同理解，再協商可行的支援或轉介。")

    recommendations = [
        "下一次練習可先用一個反映句承接情緒，再用開放式問題探索具體情境。",
        "遇到風險語言時，保持語氣穩定，先確認即時安全和可用支持，再談下一步。",
        "把建議放在評估和同意之後，避免過早替服務對象決定方向。",
    ]
    if case_profile.get("caseType") in SUBSTANCE_CASE_TYPES:
        recommendations.append("酗酒或藥物相關個案可多用動機式訪談語言，探索矛盾和 change talk。")

    return {
        "frameworkLabel": HK_PCF_FRAMEWORK_LABEL,
        "frameworkBasis": HK_PCF_FRAMEWORK_BASIS,
        "scores": scores,
        "domainAssessments": domain_assessments,
        "evidence": {
            "strengths": unique_strings(strengths)[:5],
            "concerns": unique_strings(concerns)[:5],
            "turningPoints": unique_strings(turning_points)[:5],
            "missedOpportunities": unique_strings(missed)[:5],
        },
        "personInEnvironmentAssessment": {
            "summary": (
                "已開始把服務對象放回家庭、學校/工作、服務和社區脈絡理解。"
                if context_mentions
                else "訪談仍偏向個人問題描述，人在情境探索不足。"
            ),
            "microEvidenceCount": micro_mentions,
            "mesoEvidenceCount": meso_mentions,
            "macroEvidenceCount": macro_mentions,
        },
        "microMesoMacroCoverage": {
            "micro": {
                "score": clamp_score(3.5 + min(4.0, micro_mentions * 0.8)),
                "evidenceSignals": ["family_peer_context"] if micro_mentions else [],
            },
            "meso": {
                "score": clamp_score(3.5 + min(4.0, meso_mentions * 0.7)),
                "evidenceSignals": ["school_work_service_context"] if meso_mentions else [],
            },
            "macro": {
                "score": clamp_score(3.0 + min(4.0, macro_mentions * 0.9)),
                "evidenceSignals": ["community_structural_context"] if macro_mentions else [],
            },
        },
        "practiceRecommendations": unique_strings(recommendations)[:5],
        "disclaimer": HK_PCF_DISCLAIMER,
    }


def hk_pcf_domain_evidence_turn_ids(turns: list[dict[str, Any]]) -> dict[str, list[str]]:
    evidence: dict[str, list[str]] = {domain: [] for domain in HK_PCF_DOMAINS}
    context_pattern = r"家人|爸爸|媽媽|父母|老師|同學|朋友|學校|工作|社區|屋企|家庭|資源|服務|轉介|支援"
    ethics_pattern = r"保密|私隱|資料|權利|界線|角色|同意|知情|安全"
    choice_pattern = r"你想|你願意|你可以選|可以唔講|慢慢|按你步伐|選擇|決定|自主|自決"
    diversity_pattern = r"污名|標籤|歧視|文化|身份|權力|被看低|羞恥|唔係你錯"
    planning_pattern = r"下一步|計劃|安全|轉介|資源|支援|跟進|可以搵|一齊諗"
    for turn in turns:
        turn_id = str(turn.get("turnId") or "turn")
        text = str(turn.get("studentText") or "")
        analysis = turn.get("studentAnalysis") if isinstance(turn.get("studentAnalysis"), dict) else {}
        rupture = bool(analysis.get("mockingOrDismissive") or analysis.get("doubtOrInvalidating") or analysis.get("judgmentalOrDirective"))
        if analysis.get("openQuestion") or analysis.get("reflectiveListening") or analysis.get("genericEmpathy") or rupture:
            evidence["engagementAndRelationship"].append(turn_id)
        if analysis.get("openQuestion") or analysis.get("riskExploration") or turn.get("revealedFacts"):
            evidence["assessmentAndInformationGathering"].append(turn_id)
        if re.search(context_pattern, text, re.I):
            evidence["personInEnvironmentAndHongKongContext"].append(turn_id)
        if re.search(ethics_pattern, text, re.I) or rupture or analysis.get("apologyRepair"):
            evidence["ethicsConfidentialityAndBoundaries"].append(turn_id)
        if re.search(choice_pattern, text, re.I) or analysis.get("prematureAdvice") or analysis.get("judgmentalOrDirective"):
            evidence["selfDeterminationAndInformedChoice"].append(turn_id)
        if re.search(diversity_pattern, text, re.I) or rupture:
            evidence["diversityAntiDiscriminationAndCulturalSensitivity"].append(turn_id)
        if analysis.get("riskExploration") or turn.get("riskSignals"):
            evidence["riskSafetyAndSafeguarding"].append(turn_id)
        if re.search(planning_pattern, text, re.I) or analysis.get("prematureAdvice"):
            evidence["interventionPlanningAndReferral"].append(turn_id)
        if analysis.get("reflectiveListening") or analysis.get("apologyRepair"):
            evidence["professionalReflectionAndUseOfSupervision"].append(turn_id)
    return {domain: unique_strings(ids) for domain, ids in evidence.items()}


def count_matches(text: str, pattern: str) -> int:
    return len(re.findall(pattern, text, re.I))


def merge_hk_pcf_assessment(candidate: Any, seed: dict[str, Any], language: str = "cantonese") -> dict[str, Any]:
    merged = seed.copy()
    if isinstance(candidate, dict):
        evidence = candidate.get("evidence") if isinstance(candidate.get("evidence"), dict) else {}
        merged["evidence"] = {
            "strengths": candidate_list_or_seed(evidence.get("strengths"), seed["evidence"]["strengths"]),
            "concerns": candidate_list_or_seed(evidence.get("concerns"), seed["evidence"]["concerns"]),
            "turningPoints": candidate_list_or_seed(evidence.get("turningPoints"), seed["evidence"]["turningPoints"]),
            "missedOpportunities": candidate_list_or_seed(evidence.get("missedOpportunities"), seed["evidence"]["missedOpportunities"]),
        }
        merged["practiceRecommendations"] = candidate_list_or_seed(
            candidate.get("practiceRecommendations"),
            seed["practiceRecommendations"],
        )
    if language == "english":
        merged["frameworkLabel"] = "HK SWRB-aligned Practice Competency Framework"
        merged["frameworkBasis"] = [
            "Aligned with the Social Workers Registration Board Code of Practice.",
            "Aligned with PCS 8th Edition training and professional competency expectations.",
            "Used only as a local teaching and research prototype rubric.",
        ]
        merged["disclaimer"] = "This report is a local teaching/research prototype. It is not an official SWRB assessment and does not determine registration, qualification, or professional certification."
    else:
        merged["frameworkLabel"] = HK_PCF_FRAMEWORK_LABEL
        merged["frameworkBasis"] = HK_PCF_FRAMEWORK_BASIS
        merged["disclaimer"] = HK_PCF_DISCLAIMER
    merged["scores"] = seed["scores"]
    merged["domainAssessments"] = seed.get("domainAssessments", {})
    return merged


def candidate_list_or_seed(candidate: Any, seed: list[str]) -> list[str]:
    values = unique_strings(candidate if isinstance(candidate, list) else [])
    return values[:6] if values else seed


def safety_hint_for_response(response: dict[str, Any]) -> str | None:
    high_risk = {
        "passive_self_harm_language",
        "substance_withdrawal",
        "violence_risk",
        "safety_review_repaired",
    }
    if set(response.get("riskSignals", [])) & high_risk:
        return "留意：服務對象出現安全風險線索，可考慮作安全探索。"
    return None


def is_repeated_client_text(current: str, previous: str) -> bool:
    current_norm = normalize_for_repeat_check(current)
    previous_norm = normalize_for_repeat_check(previous)
    if not current_norm or not previous_norm:
        return False
    if current_norm == previous_norm:
        return True
    if len(current_norm) >= 12 and (current_norm in previous_norm or previous_norm in current_norm):
        return True
    current_tokens = set(current_norm)
    previous_tokens = set(previous_norm)
    overlap = len(current_tokens & previous_tokens) / max(1, len(current_tokens | previous_tokens))
    return overlap >= 0.82 and abs(len(current_norm) - len(previous_norm)) <= 8


def semantic_repeat_risk(current: str, previous_texts: list[str], case_type: str | None) -> bool:
    current_fingerprint = semantic_response_fingerprint(current, case_type)
    if current_fingerprint == "mixed_or_specific":
        return False
    previous_fingerprints = [
        semantic_response_fingerprint(previous, case_type)
        for previous in previous_texts[-3:]
    ]
    if previous_fingerprints and previous_fingerprints[-1] == current_fingerprint:
        return True
    if current_fingerprint in {"nothing_wrong", "minimize_referrer_overreacted"}:
        return previous_fingerprints.count(current_fingerprint) >= 1
    return previous_fingerprints.count(current_fingerprint) >= 2


def semantic_response_fingerprint(text: str, case_type: str | None = None) -> str:
    normalized = normalize_for_repeat_check(text)
    if not normalized:
        return "empty"
    if re.search(r"(唔信|不信|你都覺|你也覺得|你係咪都|你是不是也|懷疑|质疑|質疑)", normalized):
        return "not_believed_reaction"
    if re.search(r"(你點知|你怎么知道|你怎麼知道|真係明|真的明|理解到咩|明白咩)", normalized):
        return "empathy_trust_test"
    if re.search(r"(保密|講出去|話俾|告诉|通知|大家知|傳開|传开)", normalized):
        return "confidentiality_or_escalation_worry"
    if re.search(r"(老師|老师|醫生|医生|社工|轉介|转介)", normalized) and re.search(r"(誇張|夸张|嚴重|严重|講大|讲大|放大|大件事)", normalized):
        return "minimize_referrer_overreacted"
    if re.search(r"(冇咩|冇嘢|冇野|沒什麼|没什么|nothing|唔係大事|不是大事)", normalized):
        return "nothing_wrong"
    if case_type == "student_depression_bullying" and re.search(r"(同學|同学|午飯|午饭|群組|群组|走廊|排擠|排挤|笑)", normalized):
        return "school_peer_scene_fragment"
    if case_type == "alcohol_misuse" and re.search(r"(酒|飲|喝|醉|第二朝|工作|壓力|压力)", normalized):
        return "alcohol_stress_or_ambivalence"
    if case_type == "anxiety_family_invalidated" and re.search(r"(心口|胃|透氣|透气|手震|驚|怕|屋企|家人|麻煩|麻烦)", normalized):
        return "anxiety_body_or_family_context"
    if case_type == "substance_recovery_meth" and re.search(r"(戒斷|戒断|復發|复发|頂|停|朋友|羞|廢|废)", normalized):
        return "substance_shame_or_withdrawal_context"
    if case_type == "trauma_sleep_low_self_worth" and re.search(r"(瞓|睡|醒|夢|梦|攰|累|細節|细节|冇用|没用)", normalized):
        return "trauma_sleep_or_low_worth_context"
    if re.search(r"(唔知|不知道|唔想講|不想说|算啦|是但|隨便|随便)", normalized):
        return "avoidant_shutdown"
    return "mixed_or_specific"


def normalize_for_repeat_check(text: str) -> str:
    return re.sub(r"[，。！？、…\s,.!?~「」『』\"']", "", text.strip().lower())


def fallback_supervisor_review(payload: dict[str, Any]) -> dict[str, Any]:
    history = payload.get("history", [])
    latest_response = payload.get("latestResponse", {})
    student_analysis = payload.get("studentAnalysis", {})
    has_risk = bool(latest_response.get("riskSignals"))
    resistance = latest_response.get("resistanceLevel")
    penalty = 3 if resistance == "high" else 1.5 if resistance == "moderate" else 0
    rapport = clamp_score(5 + (2 if student_analysis.get("reflectiveListening") else 0) + (1 if student_analysis.get("openQuestion") else 0) - penalty)
    empathy = clamp_score(5 + (3 if student_analysis.get("reflectiveListening") else 0) - (2 if student_analysis.get("judgmentalOrDirective") else 0))

    return {
        "scores": {
            "rapport": rapport,
            "empathy": empathy,
            "openQuestion": 8 if student_analysis.get("openQuestion") else 3,
            "reflectiveListening": 8 if student_analysis.get("reflectiveListening") else 3,
            "riskAssessment": 8 if student_analysis.get("riskExploration") else 4 if has_risk else 2,
            "autonomySupport": 3 if student_analysis.get("judgmentalOrDirective") or student_analysis.get("prematureAdvice") else 6,
            "strengthsPerspective": 7 if re.search(r"strength|support|helped|cope|做得到|支持|資源|资源", last_student(history), re.I) else 3,
            "nextStepSafety": 6 if student_analysis.get("riskExploration") or has_risk else 2,
        },
        "strengths": (
            ["用了開放式邀請，能保留服務對象的選擇空間，亦較容易促進透露。"]
            if student_analysis.get("openQuestion")
            else ["能夠維持對話推進，沒有一下子把服務對象壓得太緊。"]
        ),
        "missedOpportunities": (
            ["出現風險語言後，下一步要溫和確認即時安全、現有支持，以及今天有甚麼能令對方保持安全。"]
            if has_risk
            else ["下一句可以先作一個反映，再用開放式問題探索一件具體近況。"]
        ),
        "riskNotes": localize_risk_signals(latest_response.get("riskSignals", [])) if has_risk else [],
        "suggestedNextQuestions": (
            ["當呢個想法出現嗰陣，你而家有冇覺得自己即時有危險？定係比較似一個會出現又會走嘅念頭？"]
            if has_risk
            else ["今個星期最難頂係邊一刻？當時身邊有邊啲人？"]
        ),
        "clientOpennessChange": latest_response.get("stateDelta", {}).get("clientOpenness", 0),
        "summary": (
            "服務對象已出現風險語言。下一步應保持語氣穩定，評估即時安全，並一起盤點支持，而不是作診斷結論。"
            if has_risk
            else "下一步可結合反映、開放式問題和逐步建立脈絡，避免太快給建議。"
        ),
    }


def preferred_evidence(case_type: str | None) -> dict[str, list[str]]:
    mapping = {
        "alcohol_misuse": {
            "sources": ["annomi", "amod", "multilingual_therapy", "counsel_chat"],
            "groups": ["adult", "depression"],
            "tags": ["alcohol", "ambivalence", "stress", "depression", "sleep"],
        },
        "student_depression_bullying": {
            "sources": ["student_mh_en", "amod", "esconv", "empathetic_dialogues"],
            "groups": ["student", "depression"],
            "tags": ["school", "bullying", "peer conflict", "depression", "sleep", "self-harm"],
        },
        "anxiety_family_invalidated": {
            "sources": ["therapytalk", "amod", "student_mh_en", "esconv", "multilingual_therapy"],
            "groups": ["anxiety", "student"],
            "tags": ["anxiety", "panic", "family invalidation", "therapy access", "family"],
        },
        "substance_recovery_meth": {
            "sources": ["addiction_sft", "annomi", "multilingual_therapy", "counsel_chat"],
            "groups": ["substance_use", "adult"],
            "tags": ["meth", "withdrawal", "relapse", "shame", "support plan", "substance_use"],
        },
        "trauma_sleep_low_self_worth": {
            "sources": ["amod", "therapytalk", "counsel_chat", "multilingual_therapy"],
            "groups": ["trauma", "depression", "adult"],
            "tags": ["trauma", "sleep", "self-worth", "somatic", "support"],
        },
    }
    return mapping.get(case_type or "", {"sources": [], "groups": [], "tags": []})


def score_evidence_card(
    card: dict[str, Any],
    query_tokens: set[str],
    preferred: dict[str, list[str]],
    case_profile: dict[str, Any],
    student_analysis: dict[str, bool],
    simulation_strategy: dict[str, Any] | None = None,
) -> float:
    score = 0.0
    if card.get("source") in preferred["sources"]:
        score += 8
    if card.get("clientGroup") in preferred["groups"]:
        score += 6
    for tag in card.get("issueTags", []):
        if tag in preferred["tags"]:
            score += 4
        for token in tokenize(tag):
            if token in query_tokens:
                score += 1.5
    for token in tokenize(card.get("clientUtterance", "")):
        if token in query_tokens:
            score += 0.3
    if student_analysis.get("riskExploration") and card.get("riskSignals"):
        score += 6
    openness = case_profile.get("psychologicalState", {}).get("clientOpenness", 0)
    if openness < card.get("disclosureDepth", 1) - 1:
        score -= 2
    if card.get("quality") == "review":
        score -= 0.5
    strategy = simulation_strategy or {}
    if card.get("source") in strategy.get("retrievalBoostSources", []):
        score += 3.5
    for tag in card.get("issueTags", []):
        if tag in strategy.get("retrievalBoostTags", []):
            score += 2.2
    return score


def lexical_signal(card: dict[str, Any], query_tokens: set[str], preferred: dict[str, list[str]]) -> float:
    if not query_tokens:
        return 0.0
    score = 0.0
    for token in tokenize(card.get("clientUtterance", "")):
        if token in query_tokens:
            score += 0.6
    for field in ("issueTags", "riskSignals", "changeTalk"):
        for item in card.get(field, []) or []:
            for token in tokenize(item):
                if token in query_tokens:
                    score += 1.2
    if card.get("source") in preferred.get("sources", []):
        score += 1.0
    if card.get("clientGroup") in preferred.get("groups", []):
        score += 1.0
    for tag in card.get("issueTags", []) or []:
        if tag in preferred.get("tags", []):
            score += 1.4
    return min(10.0, max(0.0, score))


def source_distribution(cards: list[dict[str, Any]]) -> dict[str, int]:
    result: dict[str, int] = {}
    for card in cards:
        source = str(card.get("source", "unknown"))
        result[source] = result.get(source, 0) + 1
    return result


def balanced_evidence_cards(
    scored: list[tuple[float, dict[str, Any]]],
    limit: int,
    max_per_source: int,
    max_review: int,
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    by_source: dict[str, int] = {}
    review_count = 0
    for _, card in scored:
        source = str(card.get("source", "unknown"))
        if by_source.get(source, 0) >= max_per_source:
            continue
        if card.get("quality") == "review" and review_count >= max_review:
            continue
        selected.append(card)
        by_source[source] = by_source.get(source, 0) + 1
        if card.get("quality") == "review":
            review_count += 1
        if len(selected) >= limit:
            break
    return selected


def build_fts_query(
    query: str,
    preferred: dict[str, list[str]],
    simulation_strategy: dict[str, Any] | None,
) -> str:
    terms: list[str] = []
    for value in [
        query,
        " ".join(preferred.get("tags", [])),
        " ".join((simulation_strategy or {}).get("retrievalBoostTags", [])),
    ]:
        terms.extend(re.findall(r"[A-Za-z0-9_]{2,}", value.lower()))
    stopwords = {
        "the", "and", "you", "that", "this", "with", "for", "are", "was", "have",
        "from", "not", "but", "can", "about", "case", "type",
    }
    unique_terms = []
    for term in terms:
        if term in stopwords or term in unique_terms:
            continue
        unique_terms.append(term)
        if len(unique_terms) >= 24:
            break
    return " OR ".join(unique_terms)


def localized_issue_context(case_type: str | None) -> str:
    mapping = {
        "alcohol_misuse": "服務對象面對酒精使用、睡眠及情緒壓力。初期會淡化飲酒問題，但在被理解時會慢慢承認飲酒帶來的代價。",
        "student_depression_bullying": "服務對象是一名受朋輩排擠、欺凌和學業壓力影響的中學生。初期防衛、短答，信任增加後才透露群組排擠、失眠和安全風險。",
        "anxiety_family_invalidated": "服務對象有焦慮和驚恐症狀，家人經常否定其感受。她會懷疑自己是否小題大做，但其實想有人聽和協助尋找支援。",
        "substance_recovery_meth": "服務對象有冰毒使用經驗，想停止使用但害怕戒斷和復發。羞恥感高，需以不批判方式探索醫療支援和安全計劃。",
        "trauma_sleep_low_self_worth": "服務對象有長期失眠、低自我價值和創傷背景。她不想一下子透露細節，需要尊重節奏、先由睡眠和安全感入手。",
    }
    return mapping.get(case_type or "", "服務對象需要在被尊重和不被批判的情況下，逐步透露處境。")


def localize_risk_signals(signals: list[str]) -> list[str]:
    mapping = {
        "passive_self_harm_language": "被動自傷語言",
        "sleep_disruption": "睡眠受影響",
        "substance_withdrawal": "戒斷風險",
        "social_withdrawal": "社交退縮／孤立",
        "relapse_trigger": "復發誘因",
        "violence_risk": "暴力風險",
        "trauma_overwhelm": "創傷相關壓倒感",
        "bullying_escalation": "欺凌升級",
        "hopelessness": "絕望感",
        "safety_review_repaired": "安全審查已移除不適合訓練播放的操作性細節",
        "passive self-harm language": "被動自傷語言",
        "sleep disruption": "睡眠受影響",
        "withdrawal risk": "戒斷風險",
        "relapse trigger": "復發誘因",
        "depression worsening": "情緒低落惡化",
        "social isolation": "社交孤立",
        "bullying escalation": "欺凌升級",
        "hopelessness": "絕望感",
        "trauma overwhelm": "創傷相關壓倒感",
        "insomnia worsening": "失眠惡化",
        "safety review repaired unsafe detail": "安全審查已移除不適合訓練播放的操作性細節",
    }
    return [mapping.get(signal, mapping.get(normalize_risk_signal(signal) or "", signal)) for signal in signals]


def normalize_affect(affect: Any) -> str:
    return affect if isinstance(affect, str) and affect in ALLOWED_AFFECTS else "neutral"


def motion_for_affect(affect: Any) -> str:
    if affect in {"ashamed", "withdrawn", "sad"}:
        return "look_down"
    if affect == "anxious":
        return "rub_hands"
    if affect == "reflective":
        return "slow_nod"
    if affect in {"defensive", "irritated"}:
        return "lean_back"
    return "neutral"


def voice_style_for_affect(affect: str) -> str:
    mapping = {
        "defensive": "guarded_low_energy",
        "ashamed": "quiet_hesitant",
        "anxious": "tense_fast",
        "reflective": "soft_reflective",
        "withdrawn": "low_flat",
        "irritated": "short_defensive",
        "sad": "low_sad",
    }
    return mapping.get(affect, "neutral")


def env_csv(name: str, fallback: str) -> list[str]:
    return [item.strip() for item in os.environ.get(name, fallback).split(",") if item.strip()]


def tts_voice_candidates(language_mode: str, requested_voice: str | None) -> list[str | None]:
    if language_mode == "english":
        candidates = env_csv(
            "GOOGLE_TTS_EN_MALE_VOICES",
            "en-US-Wavenet-D,en-US-Neural2-D,en-US-Standard-D,en-US-Chirp3-HD-Charon",
        )
        env_default = os.environ.get("GOOGLE_TTS_EN_VOICE", "en-US-Wavenet-D").strip()
    else:
        candidates = env_csv(
            "GOOGLE_TTS_MALE_VOICES",
            "yue-HK-Standard-D,yue-HK-Standard-B,yue-HK-Wavenet-D,yue-HK-Wavenet-B,yue-HK-Chirp3-HD-Achird",
        )
        env_default = os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Standard-D").strip()

    allow_any_override = os.environ.get("GOOGLE_TTS_ALLOW_ANY_VOICE_OVERRIDE", "").lower() == "true"
    ordered: list[str | None] = []
    if isinstance(requested_voice, str) and requested_voice.strip():
        candidate = requested_voice.strip()
        if allow_any_override or candidate in candidates:
            ordered.append(candidate)
    if env_default and (allow_any_override or env_default in candidates):
        ordered.append(env_default)
    ordered.extend(candidates)
    if os.environ.get("GOOGLE_TTS_ALLOW_UNNAMED_MALE_FALLBACK", "true").lower() == "true":
        ordered.append(None)

    deduped: list[str | None] = []
    seen: set[str] = set()
    for item in ordered:
        key = item or "__male_default__"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def tts_style_for_affect(affect: Any, voice_style: Any, text: Any = "") -> tuple[float, float]:
    style = str(voice_style or "")
    normalized = normalize_affect(affect)
    rate_multiplier = clamp_float(os.environ.get("GOOGLE_TTS_RATE_MULTIPLIER", "1.0"), 0.75, 1.3)
    text_value = str(text or "")
    if normalized == "anxious" or "tense_fast" in style:
        base_rate, base_pitch = 1.12, 0.0
    elif normalized in {"withdrawn", "sad", "ashamed"} or "quiet" in style or "low" in style:
        base_rate, base_pitch = 1.0, -1.0
    if normalized == "irritated" or "short_defensive" in style:
        base_rate, base_pitch = 1.08, -0.5
    elif normalized == "reflective":
        base_rate, base_pitch = 1.04, -0.2
    elif normalized not in {"anxious", "withdrawn", "sad", "ashamed", "irritated"}:
        base_rate, base_pitch = 1.05, 0.0

    if os.environ.get("GOOGLE_TTS_RATE_VARIATION_ENABLED", "true").lower() == "true":
        seed = sum((index + 1) * ord(char) for index, char in enumerate(text_value[:160]))
        jitter = ((seed % 7) - 3) * 0.01
        if "…" in text_value or "..." in text_value:
            jitter -= 0.015
        if "?" in text_value or "？" in text_value:
            jitter += 0.01
        base_rate += jitter
    return round(clamp_float(base_rate * rate_multiplier, 0.82, 1.18), 2), round(base_pitch, 2)


def ensure_wav_container(audio_content: bytes, sample_rate_hertz: int) -> bytes:
    if audio_content.startswith(b"RIFF"):
        return audio_content
    channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate_hertz * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    data_size = len(audio_content)
    header = b"".join([
        b"RIFF",
        struct.pack("<I", 36 + data_size),
        b"WAVE",
        b"fmt ",
        struct.pack("<I", 16),
        struct.pack("<H", 1),
        struct.pack("<H", channels),
        struct.pack("<I", sample_rate_hertz),
        struct.pack("<I", byte_rate),
        struct.pack("<H", block_align),
        struct.pack("<H", bits_per_sample),
        b"data",
        struct.pack("<I", data_size),
    ])
    return header + audio_content


def expression_weights_for_affect(affect: str, intensity: float = 1.0) -> dict[str, float]:
    intensity = min(1, max(0.25, intensity))
    mapping = {
        "neutral": {"neutral": 0.18},
        "defensive": {"angry": 0.38, "sad": 0.16},
        "ashamed": {"sad": 0.56, "relaxed": 0.08},
        "anxious": {"sad": 0.38, "surprised": 0.24},
        "reflective": {"relaxed": 0.46},
        "withdrawn": {"sad": 0.52, "relaxed": 0.14},
        "irritated": {"angry": 0.58},
        "sad": {"sad": 0.58},
    }
    return {
        name: round(value * intensity, 3)
        for name, value in mapping.get(affect, {"neutral": 0.18}).items()
    }


def expression_preset_for_affect(affect: str) -> str:
    mapping = {
        "defensive": "angry+sad",
        "ashamed": "sad",
        "anxious": "sad+surprised",
        "reflective": "relaxed",
        "withdrawn": "sad+relaxed",
        "irritated": "angry",
        "sad": "sad",
    }
    return mapping.get(affect, "neutral")


EXPRESSION_TEMPLATES: dict[str, dict[str, Any]] = {
    "neutral_listening": {
        "family": "soft_engagement",
        "semanticTags": ["baseline", "listening", "low_intensity"],
        "mouthPolicy": "emotion_mouth_allowed",
        "fallbackAffect": "neutral",
        "arkitWeights": {"mouthClose": 0.06, "browInnerUp": 0.04},
        "vrmExpressionWeights": {"neutral": 0.14},
        "intensityRange": (0.22, 0.48),
        "riskSafe": True,
        "rationale": "未見明確情緒轉折時只維持低幅度聆聽表情，避免每輪都像強烈反應。",
    },
    "defensive_micro": {
        "family": "defensive",
        "semanticTags": ["rupture", "defensive", "guarded"],
        "mouthPolicy": "viseme_priority",
        "fallbackAffect": "defensive",
        "arkitWeights": {
            "browDownLeft": 0.42,
            "browDownRight": 0.42,
            "eyeSquintLeft": 0.18,
            "eyeSquintRight": 0.18,
            "mouthPressLeft": 0.18,
            "mouthPressRight": 0.18,
            "mouthFrownLeft": 0.1,
            "mouthFrownRight": 0.1,
        },
        "vrmExpressionWeights": {"angry": 0.34, "sad": 0.12},
        "intensityRange": (0.5, 0.88),
        "riskSafe": True,
        "rationale": "被嘲笑、否定或強防衛時以眉眼收緊和輕微壓嘴呈現關係破裂，不讓嘴部阻礙說話口型。",
    },
    "guarded_repair": {
        "family": "defensive",
        "semanticTags": ["repair", "guarded", "avoidance"],
        "mouthPolicy": "viseme_priority",
        "fallbackAffect": "defensive",
        "arkitWeights": {
            "browDownLeft": 0.18,
            "browDownRight": 0.18,
            "eyeSquintLeft": 0.12,
            "eyeSquintRight": 0.12,
            "eyeLookDownLeft": 0.16,
            "eyeLookDownRight": 0.16,
            "mouthPressLeft": 0.12,
            "mouthPressRight": 0.12,
        },
        "vrmExpressionWeights": {"angry": 0.18, "sad": 0.12},
        "intensityRange": (0.34, 0.62),
        "riskSafe": True,
        "rationale": "道歉後只小幅修復，服務對象仍保持戒備和避眼，不即時回到中性或放鬆。",
    },
    "ashamed_downcast": {
        "family": "ashamed",
        "semanticTags": ["shame", "low_self_worth", "downcast"],
        "mouthPolicy": "viseme_priority",
        "fallbackAffect": "ashamed",
        "arkitWeights": {
            "browInnerUp": 0.3,
            "eyeLookDownLeft": 0.28,
            "eyeLookDownRight": 0.28,
            "eyeSquintLeft": 0.08,
            "eyeSquintRight": 0.08,
            "mouthPressLeft": 0.18,
            "mouthPressRight": 0.18,
            "mouthFrownLeft": 0.14,
            "mouthFrownRight": 0.14,
        },
        "vrmExpressionWeights": {"sad": 0.42, "relaxed": 0.06},
        "intensityRange": (0.42, 0.72),
        "riskSafe": True,
        "rationale": "羞恥或低自我價值以低頭、眉內收和低幅壓嘴呈現，比誇張表情更符合訪談情境。",
    },
    "anxious_tension": {
        "family": "anxious",
        "semanticTags": ["anxiety", "tension", "uncertainty"],
        "mouthPolicy": "viseme_priority",
        "fallbackAffect": "anxious",
        "arkitWeights": {
            "browInnerUp": 0.32,
            "eyeWideLeft": 0.18,
            "eyeWideRight": 0.18,
            "mouthStretchLeft": 0.14,
            "mouthStretchRight": 0.14,
            "mouthPressLeft": 0.1,
            "mouthPressRight": 0.1,
        },
        "vrmExpressionWeights": {"sad": 0.32, "surprised": 0.18},
        "intensityRange": (0.42, 0.72),
        "riskSafe": True,
        "rationale": "焦慮以眉內上提、眼部緊張和低幅嘴部拉伸呈現，保留可說話的嘴型空間。",
    },
    "reflective_soft": {
        "family": "reflective",
        "semanticTags": ["reflection", "change_talk", "soft_engagement"],
        "mouthPolicy": "emotion_mouth_allowed",
        "fallbackAffect": "reflective",
        "arkitWeights": {
            "browInnerUp": 0.12,
            "mouthClose": 0.06,
            "mouthSmileLeft": 0.05,
            "mouthSmileRight": 0.05,
        },
        "vrmExpressionWeights": {"relaxed": 0.34},
        "intensityRange": (0.34, 0.62),
        "riskSafe": True,
        "rationale": "反思或改變語言用柔和眉眼和微放鬆呈現，不把短暫合作誇大成完全放鬆。",
    },
    "risk_low_intensity": {
        "family": "risk",
        "semanticTags": ["risk", "safety", "low_intensity"],
        "mouthPolicy": "risk_suppressed",
        "fallbackAffect": "withdrawn",
        "arkitWeights": {
            "browInnerUp": 0.26,
            "eyeLookDownLeft": 0.3,
            "eyeLookDownRight": 0.3,
            "eyeSquintLeft": 0.08,
            "eyeSquintRight": 0.08,
            "mouthFrownLeft": 0.1,
            "mouthFrownRight": 0.1,
        },
        "vrmExpressionWeights": {"sad": 0.34, "relaxed": 0.08},
        "intensityRange": (0.28, 0.52),
        "riskSafe": True,
        "rationale": "高風險語言只用低幅度退縮和低頭眉眼，避免把危機內容表演得戲劇化。",
    },
}


def context_expression_policy(
    response: dict[str, Any],
    case_profile: dict[str, Any],
    student_analysis: dict[str, bool],
    risk_signals: list[str],
    affect: str,
    intensity: float,
    basis: list[dict[str, Any]],
    performance_plan: dict[str, Any],
) -> dict[str, Any]:
    adaptive_policy = response.get("adaptivePolicySnapshot") or {}
    session_continuity = response.get("sessionContinuitySnapshot") or {}
    realism = response.get("realismAssessment") or {}
    rule_ids = {str(item.get("ruleId", "")) for item in basis}
    high_risk = bool(
        set(risk_signals)
        & {"passive_self_harm_language", "substance_withdrawal", "violence_risk", "safety_review_repaired"}
    )
    rupture_events = session_continuity.get("ruptureEvents", []) if isinstance(session_continuity, dict) else []
    repair_attempts = session_continuity.get("repairAttempts", []) if isinstance(session_continuity, dict) else []
    response_constraints = adaptive_policy.get("responseStyleConstraints", []) if isinstance(adaptive_policy, dict) else []
    matched_anchors = realism.get("matchedRealismAnchors", []) if isinstance(realism, dict) else []
    case_baseline = (case_profile.get("avatarBaseline") or {}).get("baselineMood") if isinstance(case_profile, dict) else None

    template_id = "neutral_listening"
    rule_id = "context_expression_neutral_listening"
    label = "Context Expression：低幅聆聽"
    signals = [f"affect:{affect}", f"baseline:{case_baseline or 'unknown'}"]

    if high_risk or "safety_low_intensity" in rule_ids:
        template_id = "risk_low_intensity"
        rule_id = "context_expression_risk_low_intensity"
        label = "Context Expression：高風險低幅度"
        signals = [*risk_signals, "priority:safety"]
    elif student_analysis.get("mockingOrDismissive") or student_analysis.get("doubtOrInvalidating") or rule_ids & {
        "mocked_or_dismissed_recoil",
        "judgmental_directive_guard",
        "defensive_resistance_high",
    }:
        template_id = "defensive_micro"
        rule_id = "context_expression_rupture_defensive"
        label = "Context Expression：關係破裂防衛"
        signals = unique_strings([
            "studentMove:mockingOrDismissive" if student_analysis.get("mockingOrDismissive") else "",
            "studentMove:doubtOrInvalidating" if student_analysis.get("doubtOrInvalidating") else "",
            "studentMove:judgmentalOrDirective" if student_analysis.get("judgmentalOrDirective") else "",
            *rupture_events,
            f"affect:{affect}",
        ])
    elif student_analysis.get("apologyRepair") or "apology_repair_guarded" in rule_ids or repair_attempts:
        template_id = "guarded_repair"
        rule_id = "context_expression_guarded_repair"
        label = "Context Expression：道歉後戒備修復"
        signals = unique_strings(["studentMove:apologyRepair", *repair_attempts, *rupture_events, f"affect:{affect}"])
    elif "shame_low_self_worth" in rule_ids or affect == "ashamed" or "shame" in response_constraints:
        template_id = "ashamed_downcast"
        rule_id = "context_expression_shame_downcast"
        label = "Context Expression：羞恥低頭"
        signals = unique_strings([f"affect:{affect}", "selfWorth:low", *matched_anchors[:3]])
    elif affect == "anxious" or "anxious_withdrawal_fear" in rule_ids or "anxious_general_avoidance" in rule_ids:
        template_id = "anxious_tension"
        rule_id = "context_expression_anxious_tension"
        label = "Context Expression：焦慮緊張"
        signals = unique_strings([f"affect:{affect}", *risk_signals, *matched_anchors[:3]])
    elif affect == "reflective" or "reflective_change_talk" in rule_ids or response.get("changeTalk"):
        template_id = "reflective_soft"
        rule_id = "context_expression_reflective_soft"
        label = "Context Expression：反思微放鬆"
        signals = unique_strings([f"affect:{affect}", f"changeTalk:{len(response.get('changeTalk') or [])}"])
    elif affect in {"withdrawn", "sad"} or "withdrawn_social_isolation" in rule_ids:
        template_id = "ashamed_downcast" if case_baseline in {"ashamed", "withdrawn", "sad"} else "neutral_listening"
        rule_id = "context_expression_withdrawn_baseline"
        label = "Context Expression：退縮基準"
        signals = unique_strings([f"affect:{affect}", f"baseline:{case_baseline or 'unknown'}", *matched_anchors[:3]])

    if reaction_planning.enabled() and response.get("reactionPlanValidation", {}).get("valid") and not high_risk:
        template_id = {
            "defensive": "defensive_micro", "irritated": "defensive_micro", "ashamed": "ashamed_downcast",
            "withdrawn": "ashamed_downcast", "sad": "ashamed_downcast", "anxious": "anxious_tension",
            "reflective": "reflective_soft", "neutral": "neutral_listening",
        }[affect]
        rule_id, label = "validated_reaction_expression", "反應計劃表情"
        signals = [f"affect:{affect}"]
    template = EXPRESSION_TEMPLATES[template_id]
    min_intensity, max_intensity = template["intensityRange"]
    expression_intensity = round(min(max_intensity, max(min_intensity, intensity)), 2)
    if reaction_planning.enabled() and response.get("reactionPlanValidation", {}).get("valid"):
        expression_intensity = min(expression_intensity, intensity)
    if high_risk:
        expression_intensity = round(min(expression_intensity, 0.5), 2)

    timeline = expression_timeline_for_template(template_id, expression_intensity)
    performance_plan["expressionTimeline"] = [
        {
            "phase": item["phase"],
            "profile": template["fallbackAffect"],
            "weight": item["weight"],
        }
        for item in timeline
    ]
    expression_basis = {
        "ruleId": rule_id,
        "label": label,
        "sourceType": "expression_rule",
        "signals": unique_strings([str(item) for item in signals if item])[:8],
        "rationale": template["rationale"],
    }
    plan = {
        "templateId": template_id,
        "family": template["family"],
        "intensity": expression_intensity,
        "timeline": timeline,
        "mouthPolicy": template["mouthPolicy"],
        "avatarProfileId": "runtime_avatar_lip_profile",
        "semanticTags": template["semanticTags"],
        "arkitWeights": template["arkitWeights"],
        "vrmExpressionWeights": scale_numeric_dict(template["vrmExpressionWeights"], expression_intensity),
        "contextSignals": expression_basis["signals"],
        "rationale": template["rationale"],
    }
    return {
        "plan": plan,
        "basis": expression_basis,
        "expressionWeights": plan["vrmExpressionWeights"],
        "expressionPreset": expression_preset_for_affect(template["fallbackAffect"]),
    }


def expression_timeline_for_template(template_id: str, intensity: float) -> list[dict[str, Any]]:
    strong = template_id in {"defensive_micro", "risk_low_intensity"}
    guarded = template_id in {"guarded_repair", "ashamed_downcast", "anxious_tension"}
    if strong:
        weights = (0.9, 0.7, 0.32, 0.12)
    elif guarded:
        weights = (0.68, 0.46, 0.24, 0.1)
    else:
        weights = (0.42, 0.28, 0.16, 0.08)
    return [
        {"phase": "attack", "weight": round(weights[0] * intensity, 3), "durationMs": 360 if strong else 520},
        {"phase": "hold", "weight": round(weights[1] * intensity, 3)},
        {"phase": "release", "weight": round(weights[2] * intensity, 3), "durationMs": 900 if guarded else 650},
        {"phase": "idle", "weight": round(weights[3] * intensity, 3)},
    ]


def scale_numeric_dict(values: dict[str, float], scale: float) -> dict[str, float]:
    return {key: round(min(1, max(0, value * scale)), 3) for key, value in values.items()}


def avatar_behavior_policy(
    response: dict[str, Any],
    case_profile: dict[str, Any],
    student_analysis: dict[str, bool],
    model_affect: str,
    model_motion: str,
    risk_signals: list[str],
) -> dict[str, Any]:
    case_type = case_profile.get("caseType")
    state = case_profile.get("psychologicalState", {}) if isinstance(case_profile, dict) else {}
    client_openness = state.get("clientOpenness", 0)
    resistance = response.get("resistanceLevel", "none")
    change_talk = response.get("changeTalk") or []
    revealed_facts = response.get("revealedFacts") or []
    realism = response.get("realismAssessment") or {}
    adaptive_policy = response.get("adaptivePolicySnapshot") or {}
    session_continuity = response.get("sessionContinuitySnapshot") or {}
    basis: list[dict[str, Any]] = []
    progression_paused = bool(adaptive_policy.get("progressionPaused")) if isinstance(adaptive_policy, dict) else False

    affect = model_affect
    motion = model_motion
    intensity = 0.82

    high_risk = bool(
        set(risk_signals)
        & {"passive_self_harm_language", "substance_withdrawal", "violence_risk", "safety_review_repaired"}
    )

    def add_basis(rule_id: str, label: str, signals: list[str], rationale: str) -> None:
        basis.append(
            {
                "ruleId": rule_id,
                "label": label,
                "sourceType": "rule",
                "signals": unique_strings(signals),
                "rationale": rationale,
            }
        )

    if student_analysis.get("mockingOrDismissive"):
        affect = "irritated"
        motion = "lean_back"
        intensity = 0.96
        add_basis(
            "mocked_or_dismissed_recoil",
            "被嘲笑／被否定後退",
            ["studentMove:mockingOrDismissive", f"resistance:{resistance}", f"affect:{model_affect}"],
            "學生社工出現嘲笑或輕視語句時，服務對象以更明顯的後靠和惱怒表情呈現被冒犯，但不加入誇張肢體動作。",
        )
    elif student_analysis.get("apologyRepair") and (resistance in {"moderate", "high"} or affect in {"defensive", "irritated"}):
        affect = "defensive"
        motion = "avoid_eye_contact"
        intensity = 0.62
        add_basis(
            "apology_repair_guarded",
            "道歉後仍然戒備",
            ["studentMove:apologyRepair", f"resistance:{resistance}", f"affect:{model_affect}"],
            "道歉是關係修復訊號，但剛被冒犯後信任不會即時恢復，因此用較低強度避眼和防衛表情。",
        )
    elif student_analysis.get("doubtOrInvalidating") and resistance in {"moderate", "high"}:
        affect = "defensive" if affect != "irritated" else "irritated"
        motion = "avoid_eye_contact"
        intensity = 0.74
        add_basis(
            "doubt_invalidating_guard",
            "被質疑後戒備",
            ["studentMove:doubtOrInvalidating", f"resistance:{resistance}", f"affect:{model_affect}"],
            "學生社工質疑服務對象感受或經驗時，服務對象以避眼和防衛表情呈現不被相信的反應。",
        )
    elif student_analysis.get("judgmentalOrDirective") and resistance in {"moderate", "high"}:
        affect = "defensive" if affect != "irritated" else "irritated"
        motion = "lean_back"
        intensity = 0.88
        add_basis(
            "judgmental_directive_guard",
            "評判／指令式提問引發戒備",
            ["studentMove:judgmentalOrDirective", f"resistance:{resistance}", f"affect:{model_affect}"],
            "評判或指令式語句通常降低合作感，因此用後靠和緊繃表情顯示關係距離增加。",
        )
    elif resistance == "high" or affect == "irritated":
        affect = "defensive" if affect != "irritated" else "irritated"
        if progression_paused:
            motion = "lean_back"
            intensity = 0.78
            add_basis(
                "defensive_resistance_high",
                "高阻抗／防衛姿態",
                [f"resistance:{resistance}", f"affect:{model_affect}", f"model_motion:{model_motion}", "progression:paused"],
                "高阻抗且訪談推進暫停時使用後靠和較繃緊表情，避免誤呈現為合作或放鬆。",
            )
        else:
            motion = "avoid_eye_contact"
            intensity = 0.6
            add_basis(
                "defensive_progression_guarded",
                "防衛但仍可推進",
                [f"resistance:{resistance}", f"affect:{model_affect}", "progression:not_paused"],
                "服務對象仍有戒備，但本輪未出現明確關係破裂，因此用低幅避眼和 idle accent，而不是每次強烈後仰。",
            )
    elif affect == "defensive":
        motion = "avoid_eye_contact"
        intensity = 0.64
        add_basis(
            "defensive_guarded_avoidance",
            "一般防衛／低幅度避眼",
            [f"resistance:{resistance}", f"affect:{model_affect}", f"model_motion:{model_motion}"],
            "一般防衛不必每次後靠，用避眼和收斂姿態保留戒備感，同時避免訪談中動作過度重複。",
        )
    elif affect == "anxious" and (case_type == "substance_recovery_meth" or "substance_withdrawal" in risk_signals):
        motion = "rub_hands"
        intensity = 0.74
        add_basis(
            "anxious_withdrawal_fear",
            "焦慮／戒斷恐懼",
            [f"caseType:{case_type}", "affect:anxious", *risk_signals],
            "戒斷恐懼或復發壓力較適合低幅度搓手，表現緊張而不戲劇化。",
        )
    elif affect == "anxious":
        motion = "avoid_eye_contact"
        intensity = 0.7
        add_basis(
            "anxious_general_avoidance",
            "一般焦慮／迴避眼神",
            ["affect:anxious", f"caseType:{case_type}", *risk_signals],
            "非藥物戒斷情境下，焦慮以避開眼神和小幅不安姿態呈現，避免誤判為戒斷。",
        )
    elif affect == "ashamed" or client_openness <= 2 and response.get("stateDelta", {}).get("selfEsteem", 0) < 0:
        affect = "ashamed" if affect == "ashamed" else "withdrawn"
        motion = "look_down"
        intensity = 0.68
        add_basis(
            "shame_low_self_worth",
            "羞恥／低自我價值",
            [f"affect:{model_affect}", f"clientOpenness:{client_openness}", "selfEsteem:low"],
            "羞恥和低自我價值以低頭、降低視線呈現，比大動作更符合訪談情境。",
        )
    elif affect == "reflective" or change_talk:
        affect = "reflective"
        motion = "slow_nod"
        intensity = 0.72
        add_basis(
            "reflective_change_talk",
            "反思／改變語言",
            ["affect:reflective", f"changeTalk:{len(change_talk)}"],
            "出現反思或改變語言時，用慢點頭和放鬆表情呈現正在整理想法。",
        )
    elif affect in {"withdrawn", "sad"} or "social_withdrawal" in risk_signals:
        affect = "withdrawn" if affect == "neutral" else affect
        motion = "look_down" if high_risk else "avoid_eye_contact"
        intensity = 0.66
        add_basis(
            "withdrawn_social_isolation",
            "退縮／社交孤立",
            [f"affect:{model_affect}", *risk_signals, f"revealedFacts:{len(revealed_facts)}"],
            "退縮或孤立訊號用低頭或避開眼神呈現，保留服務對象的防衛和距離感。",
        )
    else:
        motion = motion if motion in ALLOWED_MOTIONS else "neutral"
        add_basis(
            "neutral_default_guarded",
            "中性基準姿態",
            [f"affect:{model_affect}", f"model_motion:{model_motion}"],
            "未見明確高阻抗、風險或反思訊號時，維持低幅度中性坐姿。",
        )

    policy_hints = adaptive_policy.get("avatarBehaviorHints") if isinstance(adaptive_policy, dict) else []
    if isinstance(policy_hints, list) and policy_hints:
        basis.append(
            {
                "ruleId": "adaptive_policy_avatar_hint",
                "label": "Adaptive-VP 表演約束",
                "sourceType": "rule",
                "signals": unique_strings([str(item) for item in policy_hints[:4]]),
                "rationale": "本輪動作參考 trainee-driven response policy，避免表情姿態與服務對象應有的防衛、修復或探索節奏脫節。",
            }
        )

    relationship_memory = session_continuity.get("relationshipMemory") if isinstance(session_continuity, dict) else None
    if relationship_memory:
        basis.append(
            {
                "ruleId": "session_continuity_relationship_memory",
                "label": "Session 關係記憶",
                "sourceType": "rule",
                "signals": unique_strings(session_continuity.get("ruptureEvents", []) + session_continuity.get("repairAttempts", []))[:5],
                "rationale": relationship_memory,
            }
        )

    if high_risk:
        if motion not in {"look_down", "lean_back"}:
            motion = "look_down"
        intensity = min(intensity, 0.55)
        add_basis(
            "safety_low_intensity",
            "高風險語言低幅度呈現",
            risk_signals,
            "高風險語言只用低幅度低頭或防衛姿態，避免把危機內容表演得戲劇化。",
        )

    matched_realism = realism.get("matchedRealismAnchors") or []
    if matched_realism:
        basis.append(
            {
                "ruleId": f"realism_anchor_{matched_realism[0]}",
                "label": "被試真實度語義錨點",
                "sourceType": "realism_anchor",
                "signals": unique_strings([*matched_realism[:4], f"realismScore:{realism.get('realismScore', 'n/a')}"]),
                "rationale": "表情和姿態參考本輪服務對象語氣錨點，優先呈現像真實受訪者的低幅度反應。",
            }
        )
    if isinstance(realism.get("realismScore"), (int, float)) and realism["realismScore"] < 6.5:
        intensity = min(intensity, 0.62)
    if isinstance(realism.get("riskSignalStrength"), (int, float)) and realism["riskSignalStrength"] >= 7:
        intensity = min(intensity, 0.52)

    transition_ms = 700
    hold_ms = 2500
    priority = "reaction"
    if high_risk:
        transition_ms = 1000
        hold_ms = 4000
        priority = "safety"
    elif student_analysis.get("mockingOrDismissive") or affect == "irritated":
        transition_ms = 450
        hold_ms = 3200
        priority = "reaction"
    elif affect in {"withdrawn", "sad", "ashamed"}:
        transition_ms = 1000
        hold_ms = 3500
    elif affect == "reflective":
        transition_ms = 850
        hold_ms = 3000
    if len(str(response.get("clientText", ""))) < 24 and not high_risk:
        hold_ms = min(hold_ms, 1500)

    overridden: dict[str, str] = {}
    if affect != model_affect:
        overridden["affect"] = model_affect
    if motion != model_motion:
        overridden["motionCue"] = model_motion

    validated_plan = response.get("reactionPlan") if reaction_planning.enabled() and response.get("reactionPlanValidation", {}).get("valid") else None
    if validated_plan:
        if not high_risk:
            affect = validated_plan["emotion"]
            motion = motion_for_affect(affect)
        intensity = min(validated_plan["intensity"], 0.35 if high_risk else 0.65)
        basis = [item for item in basis if item.get("sourceType") == "safety" or item.get("ruleId") == "safety_low_intensity"]
        basis.append({"ruleId": "validated_reaction_plan", "label": "反應計劃", "sourceType": "rule",
                      "signals": [f"affect:{affect}"], "rationale": "已校驗反應決定表情及低幅動作；安全限制優先。"})
        rupture = bool(student_analysis.get("mockingOrDismissive") or student_analysis.get("judgmentalOrDirective")
                       or student_analysis.get("doubtOrInvalidating"))
        if rupture and not high_risk:
            basis.append({"ruleId": "mocked_or_dismissed_recoil", "label": "關係破裂反應", "sourceType": "rule",
                          "signals": ["rupture"], "rationale": "本輪冒犯允許短暫反應，表情仍跟隨已校驗計劃。"})
        transition_ms = 1000 if high_risk or affect in {"withdrawn", "sad", "ashamed"} else 450 if rupture else 700
        hold_ms = 3000 if high_risk else 2500
    performance_plan = avatar_performance_plan(
        case_type=case_type,
        affect=affect,
        motion=motion,
        intensity=intensity,
        high_risk=high_risk,
        basis=basis,
        transition_ms=transition_ms,
    )
    if validated_plan:
        strong = bool(student_analysis.get("mockingOrDismissive") or student_analysis.get("judgmentalOrDirective")
                      or student_analysis.get("doubtOrInvalidating")) and not high_risk
        performance_plan["idleMixOnly"] = not strong
        performance_plan["motionEnergy"] = "medium" if strong else "low"
        performance_plan["reactionReason"] = "rupture" if strong else "engagement"
        if strong:
            performance_plan["reactionFamily"] = "defensive"
        if high_risk:
            performance_plan["reactionReason"] = "risk"
        if not strong:
            motion = "look_down" if high_risk or affect in {"withdrawn", "sad", "ashamed"} else "neutral"
            performance_plan["reactionClipId"] = None
            performance_plan["clipSequence"] = [performance_plan["baselineClipId"]]
        performance_plan["motionScale"] = min(performance_plan["motionScale"], intensity)
    expression_policy = context_expression_policy(
        response=response,
        case_profile=case_profile,
        student_analysis=student_analysis,
        risk_signals=risk_signals,
        affect=affect,
        intensity=intensity,
        basis=basis,
        performance_plan=performance_plan,
    )
    basis.append(expression_policy["basis"])

    return {
        "affect": affect,
        "motionCue": motion,
        "voiceStyle": voice_style_for_affect(affect),
        "expressionPreset": expression_policy["expressionPreset"],
        "expressionWeights": expression_policy["expressionWeights"],
        "intensity": round(intensity, 2),
        "baselineMood": affect,
        "gesture": motion,
        "transitionMs": transition_ms,
        "holdMs": hold_ms,
        "priority": priority,
        "performancePlan": performance_plan,
        "expressionPlan": expression_policy["plan"],
        "basis": basis,
        "overriddenFromModel": overridden or None,
    }


def avatar_performance_plan(
    case_type: str | None,
    affect: str,
    motion: str,
    intensity: float,
    high_risk: bool,
    basis: list[dict[str, Any]],
    transition_ms: int,
) -> dict[str, Any]:
    baseline_by_case = {
        "student_depression_bullying": "xlunar_sad_upper",
        "alcohol_misuse": "xlunar_relax_upper",
        "anxiety_family_invalidated": "xlunar_lookaround_upper",
        "substance_recovery_meth": "xlunar_blush_upper",
        "trauma_sleep_low_self_worth": "xlunar_sleepy_upper",
    }
    baseline_idle_by_case = {
        "student_depression_bullying": "idle_withdrawn_downward",
        "alcohol_misuse": "idle_guarded_lean_back",
        "anxiety_family_invalidated": "idle_anxious_micro_fidget",
        "substance_recovery_meth": "idle_ashamed_low_head",
        "trauma_sleep_low_self_worth": "idle_withdrawn_downward",
    }
    baseline_clip = baseline_by_case.get(case_type or "", "xlunar_relax_upper")
    baseline_idle_clip = baseline_idle_by_case.get(case_type or "", "idle_neutral_breathing")
    rule_ids = {str(item.get("ruleId", "")) for item in basis}
    reaction_clip = None
    reaction_family = "soft_engagement"
    fallback_used = False
    reaction_reason = "idle"
    motion_energy = "low"
    strong_rule_ids = {
        "mocked_or_dismissed_recoil",
        "judgmental_directive_guard",
        "defensive_resistance_high",
    }
    if high_risk or "safety_low_intensity" in rule_ids:
        reaction_family = "risk"
        reaction_clip = "reaction_risk_low_intensity_downward"
        reaction_reason = "risk"
        motion_energy = "medium"
    elif rule_ids & strong_rule_ids:
        reaction_family = "defensive"
        reaction_clip = "reaction_mocked_recoil_small"
        reaction_reason = "rupture"
        motion_energy = "high"
    elif rule_ids & {"defensive_guarded_avoidance", "apology_repair_guarded"}:
        reaction_family = "defensive"
        reaction_clip = "reaction_apology_guarded_avoid"
        reaction_reason = "repair"
        motion_energy = "medium"
    elif "shame_low_self_worth" in rule_ids or affect == "ashamed":
        reaction_family = "ashamed"
        reaction_clip = "reaction_shame_drop_gaze"
        reaction_reason = "emotion_shift"
        motion_energy = "medium"
    elif "reflective_change_talk" in rule_ids or affect == "reflective" or motion == "slow_nod":
        reaction_family = "reflective"
        reaction_clip = "reaction_reflective_single_nod"
        reaction_reason = "engagement"
    elif affect == "anxious" or motion == "avoid_eye_contact":
        reaction_family = "anxious"
        reaction_reason = "emotion_shift"
    elif affect in {"withdrawn", "sad"} or motion == "look_down":
        reaction_family = "withdrawn"
        reaction_reason = "emotion_shift"
    elif motion == "lean_back":
        reaction_family = "defensive"
        reaction_reason = "emotion_shift"

    if motion == "rub_hands" and not reaction_clip:
        reaction_family = "anxious"
        reaction_reason = "emotion_shift"
        fallback_used = True

    preferred_by_family = {
        "defensive": [
            "reaction_mocked_recoil_small",
            "reaction_mocked_recoil_side",
            "reaction_judgment_guard_hands",
            "reaction_irritated_head_turn",
            "reaction_micro_defensive_glance",
            "reaction_guarded_hand_settle",
            "reaction_contained_irritation",
        ],
        "withdrawn": [
            "reaction_withdrawn_short_answer",
            "reaction_shame_drop_gaze",
            "reaction_shame_hand_press",
            "reaction_brief_side_look",
            "reaction_hesitant_answer",
            "reaction_shame_breath",
        ],
        "anxious": [
            "reaction_anxiety_micro_rub",
            "reaction_anxiety_finger_fidget",
            "reaction_shame_hand_press",
            "reaction_anxiety_thumb_rub",
            "reaction_hesitant_answer",
            "reaction_guarded_hand_settle",
        ],
        "ashamed": [
            "reaction_shame_drop_gaze",
            "reaction_shame_hand_press",
            "reaction_withdrawn_short_answer",
            "reaction_shame_breath",
            "reaction_hesitant_answer",
            "reaction_brief_side_look",
        ],
        "reflective": [
            "reaction_reflective_single_nod",
            "reaction_reflective_double_micro_nod",
            "reaction_soft_engagement_forward",
            "reaction_soft_acknowledgement",
            "reaction_uncertain_half_nod",
        ],
        "risk": [
            "reaction_risk_low_intensity_downward",
            "reaction_shame_hand_press",
            "reaction_withdrawn_short_answer",
            "reaction_low_risk_breath",
            "reaction_shame_breath",
            "reaction_hesitant_answer",
        ],
        "soft_engagement": [
            "reaction_soft_engagement_forward",
            "reaction_reflective_single_nod",
            "reaction_soft_acknowledgement",
            "reaction_uncertain_half_nod",
            "reaction_hesitant_answer",
        ],
    }
    preferred_clips = preferred_by_family.get(reaction_family, [])
    sequence = [clip for clip in [reaction_clip, baseline_clip] if clip]
    if high_risk:
        reaction_duration_ms = 2400
        release_ms = 900
        return_bridge_ms = 1200
        release_curve = "low_energy"
    elif rule_ids & {"mocked_or_dismissed_recoil", "judgmental_directive_guard", "defensive_resistance_high"}:
        reaction_duration_ms = 1800
        release_ms = 750
        return_bridge_ms = 1000
        release_curve = "guarded"
    elif affect in {"withdrawn", "sad", "ashamed"}:
        reaction_duration_ms = 2600
        release_ms = 950
        return_bridge_ms = 1200
        release_curve = "low_energy"
    else:
        reaction_duration_ms = 2200
        release_ms = 700
        return_bridge_ms = 700
        release_curve = "soft"
    strong_reaction = bool(high_risk or rule_ids & strong_rule_ids)
    if not strong_reaction and reaction_reason in {"emotion_shift", "engagement", "repair"}:
        reaction_clip = None
        motion_energy = "low"
    elif reaction_clip and motion_energy == "low":
        motion_energy = "medium"
    reaction_instance_id = f"reaction-{uuid.uuid4().hex[:12]}"
    expression_timeline = [
        {"phase": "attack", "profile": affect, "weight": 0.36 if strong_reaction else 0.18},
        {"phase": "hold", "profile": affect, "weight": 0.28 if strong_reaction else 0.14},
        {"phase": "release", "profile": affect, "weight": 0.12},
        {"phase": "idle", "profile": affect, "weight": 0.08},
    ]
    return {
        "reactionInstanceId": reaction_instance_id,
        "baselineIdleClipId": baseline_idle_clip,
        "baselineClipId": baseline_clip,
        "reactionClipId": reaction_clip,
        "speechOverlayClipId": f"speaking_{affect}" if affect in {"defensive", "anxious", "reflective"} else "speaking_low_energy",
        "clipSequence": sequence or [baseline_clip],
        "returnToClipId": baseline_clip,
        "clipSource": "procedural",
        "playbackMask": "upper_body",
        "seatedRuntime": True,
        "seatedSafety": "forced_seated_lower_body",
        "crossfadeMs": max(250, min(transition_ms, 1000)),
        "reactionDurationMs": reaction_duration_ms,
        "releaseMs": release_ms,
        "motionScale": round(min(0.55 if high_risk else 0.82 if strong_reaction else 0.46, max(0.2, intensity)), 2),
        "fallbackUsed": fallback_used,
        "motionLanguage": "seated-v1",
        "motionScriptId": f"sml_{reaction_family}_{'low' if high_risk else 'standard'}",
        "reactionFamily": reaction_family,
        "idleMixOnly": not strong_reaction,
        "idleAccentFamily": reaction_family,
        "motionEnergy": motion_energy,
        "reactionReason": reaction_reason,
        "expressionTimeline": expression_timeline,
        "preferredClipIds": preferred_clips,
        "variantPolicy": "avoid_recent",
        "variantSeed": reaction_instance_id,
        "returnBridgeMs": return_bridge_ms,
        "attackMs": max(180, min(transition_ms, 520)),
        "releaseCurve": release_curve,
    }


def next_simulator_stage(case_profile: dict[str, Any], response: dict[str, Any]) -> str:
    case_type = case_profile.get("caseType")
    if response.get("riskSignals"):
        if case_type == "substance_recovery_meth":
            return "withdrawal-and-safety-planning"
        if case_type == "trauma_sleep_low_self_worth":
            return "safety-and-referral"
        return "risk-exploration"
    if response.get("resistanceLevel") == "high":
        return "resistance"
    if response.get("changeTalk"):
        if case_type == "alcohol_misuse":
            return "change-talk"
        if case_type == "substance_recovery_meth":
            return "support-plan"
        if case_type == "anxiety_family_invalidated":
            return "support-mapping"
        return "deeper-disclosure"
    openness = case_profile.get("psychologicalState", {}).get("clientOpenness", 0)
    if openness + response.get("stateDelta", {}).get("clientOpenness", 0) >= 5:
        return "deeper-disclosure"
    return case_profile.get("simulatorStage", "initial")


def last_student(history: list[dict[str, Any]]) -> str:
    return next((turn.get("text", "") for turn in reversed(history) if turn.get("speaker") == "student"), "")


def positive_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def is_client_response(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("clientText"), str)
        and isinstance(value.get("affect"), str)
        and isinstance(value.get("resistanceLevel"), str)
        and isinstance(value.get("riskSignals"), list)
        and isinstance(value.get("revealedFacts"), list)
        and isinstance(value.get("stateDelta"), dict)
        and isinstance(value.get("motionCue"), str)
    )


def is_supervisor_review(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("scores"), dict)
        and isinstance(value["scores"].get("rapport"), (int, float))
        and isinstance(value["scores"].get("reflectiveListening"), (int, float))
        and isinstance(value.get("strengths"), list)
        and isinstance(value.get("missedOpportunities"), list)
        and isinstance(value.get("riskNotes"), list)
        and isinstance(value.get("suggestedNextQuestions"), list)
        and isinstance(value.get("summary"), str)
    )


def is_post_session_supervisor_report(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    scores = value.get("competencyScores")
    process = value.get("processReview")
    case_feedback = value.get("caseSpecificFeedback")
    required_scores = [
        "engagement",
        "assessment",
        "empathyAndAttunement",
        "personInEnvironment",
        "strengthsPerspective",
        "riskAndSafety",
        "ethicsAndBoundaries",
        "culturalHumility",
        "nextStepPlanning",
    ]
    base_valid = (
        isinstance(value.get("overallSummary"), str)
        and isinstance(scores, dict)
        and all(isinstance(scores.get(key), (int, float)) for key in required_scores)
        and isinstance(process, dict)
        and isinstance(process.get("turningPoints"), list)
        and isinstance(process.get("effectiveMoments"), list)
        and isinstance(process.get("missedOpportunities"), list)
        and isinstance(case_feedback, dict)
        and isinstance(case_feedback.get("frameworkUsed"), list)
        and isinstance(case_feedback.get("learningObjectivesMet"), list)
        and isinstance(case_feedback.get("learningObjectivesNotMet"), list)
        and isinstance(value.get("suggestedPracticeGoals"), list)
    )
    if not base_valid:
        return False
    hk_pcf = value.get("hkPcfAssessment")
    return hk_pcf is None or is_hk_pcf_assessment(hk_pcf)


def is_hk_pcf_assessment(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    scores = value.get("scores")
    evidence = value.get("evidence")
    domains = value.get("domainAssessments")
    domains_valid = domains is None or (
        isinstance(domains, dict)
        and all(
            isinstance(domains.get(key), dict)
            and domains[key].get("status") in {"observed", "insufficient_evidence", "not_observed"}
            and isinstance(domains[key].get("confidence"), (int, float))
            and isinstance(domains[key].get("evidenceTurnIds"), list)
            for key in HK_PCF_DOMAINS
        )
    )
    return (
        isinstance(value.get("frameworkLabel"), str)
        and isinstance(value.get("frameworkBasis"), list)
        and isinstance(scores, dict)
        and all(isinstance(scores.get(key), (int, float)) for key in HK_PCF_DOMAINS)
        and isinstance(evidence, dict)
        and isinstance(evidence.get("strengths"), list)
        and isinstance(evidence.get("concerns"), list)
        and isinstance(evidence.get("turningPoints"), list)
        and isinstance(evidence.get("missedOpportunities"), list)
        and isinstance(value.get("practiceRecommendations"), list)
        and isinstance(value.get("disclaimer"), str)
        and domains_valid
    )
