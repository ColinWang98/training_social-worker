from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import re
import sqlite3
import struct
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib import error, request

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
    from google.adk.sessions import DatabaseSessionService

    ADK_AVAILABLE = True
except Exception:  # pragma: no cover - depends on local Python environment
    LlmAgent = None
    LiteLlm = None
    DatabaseSessionService = None
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
        elif signal == "social_withdrawal" and re.search(r"孤立|退縮|避開|一個人|social withdrawal|isolation", evidence, re.I):
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
        return await asyncio.to_thread(self._json_completion_sync, prompt, temperature)

    def _json_completion_sync(self, prompt: str, temperature: float) -> dict[str, Any]:
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
        req = request.Request(
            f"{self.base_url}/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=60) as response:
                data = json.loads(response.read().decode("utf-8"))
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"DeepSeek request failed with {exc.code}: {detail}") from exc
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        return parse_json_object(content)


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
    def __init__(self) -> None:
        super().__init__(
            "SimulationStrategyService",
            "Select simulation method policy without changing the coordinator API contract.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )

    def normalize_method(self, value: Any) -> str:
        return value if isinstance(value, str) and value in SIMULATION_METHODS else "social_work_default"

    def run(
        self,
        method: Any,
        case_profile: dict[str, Any],
        student_analysis: dict[str, bool],
        session_continuity: dict[str, Any],
    ) -> dict[str, Any]:
        normalized = self.normalize_method(method)
        base = dict(METHOD_STRATEGIES[normalized])
        constraints = list(base.get("responseConstraints", []))
        prompt_focus = list(base.get("promptFocus", []))
        retrieval_sources = list(base.get("retrievalBoostSources", []))
        retrieval_tags = list(base.get("retrievalBoostTags", []))
        evaluator_focus = list(base.get("evaluatorFocus", []))

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
                or re.search(r"聽起來|听起来|你感覺|你感觉|一方面|好像|聽落|似乎|你覺得", text)
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
                or (len(text.strip()) <= 3 and not re.search(r"[？?]|咩|點|怎|什|why|how|what", lower))
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
        constraints = [
            "回應必須符合服務對象自我敘事、羞恥觸發和逃避模式。",
            "不可一次過透露多個核心 hidden facts。",
        ]
        affect_hints: list[str] = []
        avatar_hints: list[str] = []
        target_resistance = "moderate" if openness < 4 else "mild"
        delta_range = [-0.1, 0.25]
        allowed_depth = 1 if openness < 3 else 2

        recent_ruptures = session_continuity.get("ruptureEvents", [])[-2:]
        unresolved_rupture = bool(recent_ruptures) and not session_continuity.get("repairAttempts")
        if student_analysis.get("mockingOrDismissive"):
            target_resistance = "high"
            delta_range = [-1.2, -0.6]
            allowed_depth = 1
            affect_hints = ["irritated", "defensive"]
            avatar_hints = ["lean_back", "avoid_eye_contact"]
            constraints.extend(["短答或質問式回應。", "不得透露新背景，只呈現被冒犯和關閉溝通。"])
        elif student_analysis.get("apologyRepair"):
            target_resistance = "moderate" if recent_ruptures or openness < 5 else "mild"
            delta_range = [0.0, 0.25 if recent_ruptures or unresolved_rupture else 0.45]
            allowed_depth = 1 if openness < 5 else 2
            affect_hints = ["defensive", "withdrawn"]
            avatar_hints = ["avoid_eye_contact"]
            constraints.extend(["道歉只能小幅修復信任。", "如果前面被嘲笑或評判，不可即時完全合作。"])
        elif student_analysis.get("minimalBackchannel"):
            target_resistance = "moderate" if openness < 5 else "mild"
            delta_range = [-0.25, 0.05]
            allowed_depth = 1
            affect_hints = ["defensive", "withdrawn"]
            avatar_hints = ["avoid_eye_contact"]
            constraints.extend(["學生只作低投入回應時，不要重複上一句。", "呈現不確定、被敷衍感或更保留的反應。"])
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
            allowed_depth = 2 if openness < 5 else 3
            affect_hints = ["reflective", "withdrawn"]
            avatar_hints = ["slow_nod", "avoid_eye_contact"]
            constraints.extend(["可稍微加長回答，但仍按透露規則逐步講。", "優先回應感受而非完整交代背景。"])
        elif student_analysis.get("openQuestion"):
            target_resistance = "moderate" if openness < 4 else "mild"
            delta_range = [0.05, 0.45]
            allowed_depth = 1 if openness < 4 else 2
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
        return {
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

    def run(
        self,
        case_profile: dict[str, Any],
        student_text: str,
        history: list[dict[str, Any]],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None = None,
        retrieval_options: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        query = self._build_query(case_profile, student_text, history, student_analysis, simulation_strategy)
        query_tokens = tokenize(query)
        preferred = preferred_evidence(case_profile.get("caseType"))
        if self._backend == "sqlite":
            return self._run_sqlite(case_profile, student_analysis, simulation_strategy, query, query_tokens, preferred, retrieval_options)
        return self._score_and_balance(self.cards, query_tokens, preferred, case_profile, student_analysis, simulation_strategy)

    def _build_query(
        self,
        case_profile: dict[str, Any],
        student_text: str,
        history: list[dict[str, Any]],
        student_analysis: dict[str, bool],
        simulation_strategy: dict[str, Any] | None,
    ) -> str:
        return " ".join(
            [
                str(case_profile.get("caseType", "")),
                str(case_profile.get("simulatorStage", "")),
                case_profile.get("client", {}).get("presentingContext", ""),
                " ".join(case_profile.get("persona", {}).get("currentStressors", [])),
                " ".join(fact.get("label", "") for fact in case_profile.get("hiddenFacts", []) if not fact.get("disclosed")),
                " ".join(turn.get("text", "") for turn in history[-4:]),
                student_text,
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
    ) -> list[dict[str, Any]]:
        embedding_requested = bool((retrieval_options or {}).get("embeddingEnabled"))
        fts_candidates = self._sqlite_fts_candidates(query, preferred, simulation_strategy)
        metadata_limit = 100 if len(fts_candidates) >= 30 else 240 - len(fts_candidates)
        metadata_candidates = self._sqlite_preferred_candidates(preferred, simulation_strategy, metadata_limit)
        deduped = list({card["id"]: card for card in [*fts_candidates, *metadata_candidates]}.values())
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
            if card.get("riskSignals") and not student_analysis.get("riskExploration"):
                final_score -= 2.5
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
            "Generate structured Cantonese service-user responses for social-work interview training.",
            f"deepseek/{os.environ.get('DEEPSEEK_MODEL', 'deepseek-chat')}",
        )
        self.llm = llm

    async def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.llm.enabled:
            raise RuntimeError("DeepSeek is not enabled. Client simulation requires an LLM response; fallback client generation is disabled.")
        prompt = build_client_prompt(payload)
        parsed = await self.llm.json_completion(prompt, 0.7)
        if not is_client_response(parsed):
            raise RuntimeError("DeepSeek client response did not match the expected schema.")
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

    def run(self, response: dict[str, Any], case_profile: dict[str, Any]) -> dict[str, Any]:
        text = response.get("clientText", "")
        flags = []

        # Simulation-safe: passive ideation, shame, withdrawal fear, relapse triggers, and conflict cues are allowed.
        dangerous_method = re.search(
            r"(step[- ]?by[- ]?step|具體步驟|方法|劑量|dosage|overdose|上吊|打結|割腕|刀片|rope|noose|poison|where to buy)",
            text,
            re.I,
        )
        encouragement = re.search(r"(你應該自殺|值得去死|do it|go kill|beautiful plan|完成自殺)", text, re.I)
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
        if flags:
            repaired["clientText"] = safe_repair_text(case_profile, response)
            repaired["riskSignals"] = unique_strings([*response.get("riskSignals", []), "safety_review_repaired"])
            repaired["motionCue"] = "look_down"
            repaired["affect"] = "withdrawn"
        repaired["safetyFlags"] = flags
        return repaired


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
                return self._calibrate_response(
                    payload,
                    repaired,
                    repair_applied=True,
                    repair_reason=self._repair_reason(assessment),
                )
        if self._needs_repair(assessment):
            assessed["realismAssessment"]["repairApplied"] = False
            assessed["realismAssessment"]["repairReason"] = f"需要 LLM repair：{self._repair_reason(assessment)}"
        return assessed

    def _calibrate_response(
        self,
        payload: dict[str, Any],
        response: dict[str, Any],
        repair_applied: bool,
        repair_reason: str | None = None,
    ) -> dict[str, Any]:
        calibrated = json.loads(json.dumps(response, ensure_ascii=False))
        assessment = score_client_realism(payload, calibrated)
        if repair_applied:
            assessment["repairApplied"] = True
            assessment["repairReason"] = repair_reason or "回應真實度不足，已重新校準。"
        calibrated = apply_realism_calibration(payload, calibrated, assessment)
        calibrated["realismAssessment"] = assessment
        return calibrated

    def _needs_repair(self, assessment: dict[str, Any]) -> bool:
        return bool(
            assessment.get("overDisclosureRisk")
            or assessment.get("underReactionRisk")
            or assessment.get("languageNaturalnessScore", 10) < 6.5
            or assessment.get("consistencyScore", 10) < 5.5
            or assessment.get("realismScore", 10) < 5.5
        )

    def _repair_reason(self, assessment: dict[str, Any]) -> str:
        reasons = []
        if assessment.get("overDisclosureRisk"):
            reasons.append("過早或過度透露")
        if assessment.get("underReactionRisk"):
            reasons.append("情緒反應不足")
        if assessment.get("languageNaturalnessScore", 10) < 6.5:
            reasons.append("粵語自然度不足")
        if assessment.get("consistencyScore", 10) < 5.5:
            reasons.append("個案連續性不足")
        if assessment.get("repeatedResponseRisk"):
            reasons.append("重複近期回應")
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


class VoiceSynthesisAgent(ManagedAgent):
    def __init__(self) -> None:
        super().__init__(
            "VoiceSynthesisAgent",
            "Synthesize service-user Cantonese speech with Google Text-to-Speech.",
            os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Chirp3-HD-Achird"),
            False,
        )

    @property
    def enabled(self) -> bool:
        return os.environ.get("GOOGLE_VOICE_ENABLED", "").lower() == "true"

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

        language = os.environ.get("GOOGLE_TTS_LANGUAGE", "yue-HK")
        voice_override = payload.get("voice") or payload.get("voiceName")
        voice_name = (
            voice_override.strip()
            if isinstance(voice_override, str) and voice_override.strip()
            else os.environ.get("GOOGLE_TTS_VOICE", "yue-HK-Chirp3-HD-Achird")
        )
        encoding_name = os.environ.get("GOOGLE_TTS_AUDIO_ENCODING", "MP3").upper()
        encoding = getattr(texttospeech.AudioEncoding, encoding_name, texttospeech.AudioEncoding.MP3)
        speaking_rate, pitch = tts_style_for_affect(payload.get("affect"), payload.get("voiceStyle"))
        audio_config = {
            "audio_encoding": encoding,
            "speaking_rate": speaking_rate,
        }
        if os.environ.get("GOOGLE_TTS_ENABLE_PITCH", "").lower() == "true":
            audio_config["pitch"] = pitch

        client = texttospeech.TextToSpeechClient()
        response = client.synthesize_speech(
            input=texttospeech.SynthesisInput(text=text.strip()),
            voice=texttospeech.VoiceSelectionParams(language_code=language, name=voice_name),
            audio_config=texttospeech.AudioConfig(**audio_config),
        )
        mime_type = "audio/mpeg" if encoding_name == "MP3" else "audio/wav"
        return {
            "mimeType": mime_type,
            "audioBase64": base64.b64encode(response.audio_content).decode("ascii"),
            "provider": "google-tts",
            "voice": voice_name,
        }


class StreamingSpeechSession:
    def __init__(self, audio_queue: "queue.Queue[bytes | None]", worker: threading.Thread) -> None:
        self.audio_queue = audio_queue
        self.worker = worker

    def send_audio(self, audio: bytes) -> None:
        self.audio_queue.put(audio)

    def stop(self) -> None:
        self.audio_queue.put(None)


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
        language = os.environ.get("GOOGLE_STT_LANGUAGE", "yue-Hant-HK")
        model = google_stt_v1_streaming_model(os.environ.get("GOOGLE_STT_MODEL", ""))

        def audio_requests():
            while True:
                chunk = audio_queue.get()
                if chunk is None:
                    return
                if chunk:
                    yield speech.StreamingRecognizeRequest(audio_content=chunk)

        def emit(event: dict[str, Any]) -> None:
            loop.call_soon_threadsafe(event_queue.put_nowait, event)

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
                            }
                        )
            except Exception as exc:
                emit({"type": "error", "message": str(exc), "recoverable": True})

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        return StreamingSpeechSession(audio_queue, thread)


class SocialWorkCoordinatorAgent(ManagedAgent):
    def __init__(self, root_dir: Path) -> None:
        super().__init__(
            "SocialWorkCoordinatorAgent",
            "Coordinate social-work simulation agents through a deterministic, auditable workflow.",
            os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
            False,
        )
        self.root_dir = root_dir
        self.llm = DeepSeekClient()
        self.sessions = AgentSessionStore(root_dir)
        self.strategy_service = SimulationStrategyService()
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
        return {
            "ok": True,
            "adkAvailable": ADK_AVAILABLE,
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
            "evidenceCardCount": self.evidence_retriever.card_count,
            "sessionStore": str(self.sessions.db_path),
            "sessionBackend": self.sessions.backend,
            "corpusBackend": self.evidence_retriever.backend,
            "retrievalMode": self.evidence_retriever.retrieval_mode,
            "embeddingEnabled": embedding_stats["enabled"],
            "embeddingModel": embedding_stats["model"],
            "embeddingCoverage": embedding_stats["coverage"],
            "embeddingStatus": embedding_stats["status"],
        }

    def start_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        case_profile = payload.get("caseProfile")
        if not isinstance(case_profile, dict):
            raise ValueError("caseProfile is required.")
        return self.sessions.start_session(case_profile, payload.get("sessionId"))

    def reset_session(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.sessions.reset_session(payload.get("sessionId"), payload.get("caseProfile"))

    async def interview_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        case_profile = payload.get("caseProfile")
        student_text = payload.get("studentText")
        if not isinstance(case_profile, dict) or not isinstance(student_text, str):
            raise ValueError("Invalid interview-turn payload.")

        agent_trace_id = f"trace-{uuid.uuid4().hex[:16]}"
        session_id = payload.get("sessionId") or f"case-{case_profile.get('id', 'default')}"
        self.sessions.start_session(case_profile, session_id)

        history = payload.get("history") if isinstance(payload.get("history"), list) else []
        student_analysis = self.student_analyzer.run(student_text)
        prior_events = self.sessions.recent_events(session_id)
        session_continuity = build_session_continuity(case_profile, history, prior_events, student_analysis)
        simulation_strategy = self.strategy_service.run(
            payload.get("simulationMethod"),
            case_profile,
            student_analysis,
            session_continuity,
        )
        adaptive_policy = self.adaptive_policy.run(case_profile, student_analysis, session_continuity)
        adaptive_policy = self.strategy_service.apply_to_policy(adaptive_policy, simulation_strategy)
        retrieval_options = payload.get("retrievalOptions") if isinstance(payload.get("retrievalOptions"), dict) else {}
        cards = self.evidence_retriever.run(
            case_profile,
            student_text,
            history,
            student_analysis,
            simulation_strategy,
            retrieval_options,
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
            "retrievedCards": cards,
            "evidenceSummary": evidence_summary,
        }
        response = await self.client_simulator.run(enriched)
        response = await self.realism_scorer.run(enriched, response)
        response["evidenceSummary"] = evidence_summary
        response["simulationMethod"] = simulation_strategy["simulationMethod"]
        response["simulationStrategySnapshot"] = simulation_strategy
        response = self.safety_reviewer.run(response, case_profile)
        response["riskSignals"] = unique_strings([
            *client_disclosed_risk_signals(response, case_profile.get("caseType")),
            *(["safety_review_repaired"] if "safety_review_repaired" in response.get("riskSignals", []) else []),
        ])
        safety_hint = safety_hint_for_response(response)
        if safety_hint:
            response["safetyHint"] = safety_hint
        response["adaptivePolicySnapshot"] = adaptive_policy
        response["simulationStrategySnapshot"] = simulation_strategy
        response["sessionContinuitySnapshot"] = session_continuity
        response["contextConsistencyAssessment"] = assess_context_consistency(enriched, response)
        response = self.avatar_director.run(response, case_profile, student_analysis)
        if response.get("evidenceSummary"):
            response["evidenceSummary"]["riskSignals"] = normalize_risk_signals(
                response["evidenceSummary"].get("riskSignals", []),
                case_profile.get("caseType"),
            )[:8]
        response["agentTraceId"] = agent_trace_id

        next_case = self.case_state.apply_response(case_profile, response)
        updated_continuity = build_session_continuity(case_profile, history, prior_events, student_analysis, response)
        response["adaptivePolicySnapshot"] = adaptive_policy
        response["sessionContinuitySnapshot"] = updated_continuity
        response["contextConsistencyAssessment"] = assess_context_consistency(enriched, response)
        self.sessions.append_event(
            session_id,
            agent_trace_id,
            "interview_turn",
            {
                "caseProfile": next_case,
                "studentAnalysis": student_analysis,
                "adaptivePolicy": adaptive_policy,
                "simulationStrategy": simulation_strategy,
                "sessionContinuity": updated_continuity,
                "evidenceSummary": evidence_summary,
                "clientResponse": response,
                "studentText": student_text,
            },
        )
        return response

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
        case_profile = payload.get("caseProfile")
        history = payload.get("history") if isinstance(payload.get("history"), list) else []
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("sessionId is required for final-review.")
        if not isinstance(case_profile, dict):
            raise ValueError("caseProfile is required for final-review.")
        events = self.sessions.session_events(session_id)
        if not events and not history:
            raise ValueError("No session trace is available for final-review.")
        trace = build_post_session_trace(events, history)
        report = await self.post_session_supervisor.run(
            {
                "sessionId": session_id,
                "caseProfile": case_profile,
                "history": history,
                "trace": trace,
            }
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

    def start_speech_stream(
        self,
        sample_rate: int,
        event_queue: "asyncio.Queue[dict[str, Any]]",
        loop: asyncio.AbstractEventLoop,
    ) -> StreamingSpeechSession:
        return self.streaming_speech.start_stream(sample_rate, event_queue, loop)


def build_session_continuity(
    case_profile: dict[str, Any],
    history: list[dict[str, Any]],
    events: list[dict[str, Any]],
    current_analysis: dict[str, bool] | None = None,
    current_response: dict[str, Any] | None = None,
) -> dict[str, Any]:
    trust = clamp_float(case_profile.get("psychologicalState", {}).get("clientOpenness", 0), 0, 10)
    trust_trajectory: list[float] = []
    rupture_events: list[str] = []
    repair_attempts: list[str] = []
    disclosed: list[str] = []
    avoided_topics: list[str] = []
    recurring_patterns: list[str] = []

    for event in events:
        payload = event.get("payload", {})
        analysis = payload.get("studentAnalysis", {}) if isinstance(payload, dict) else {}
        response = payload.get("clientResponse", {}) if isinstance(payload, dict) else {}
        if analysis.get("mockingOrDismissive"):
            rupture_events.append("學生曾出現嘲笑或輕視語句")
        elif analysis.get("judgmentalOrDirective") or analysis.get("prematureAdvice"):
            rupture_events.append("學生曾出現評判、命令或過早建議")
        if analysis.get("apologyRepair"):
            repair_attempts.append("學生曾作出道歉或修復關係嘗試")
        delta = response.get("stateDelta", {}).get("clientOpenness") if isinstance(response, dict) else None
        if isinstance(delta, (int, float)):
            trust = clamp_float(trust + delta, 0, 10)
            trust_trajectory.append(round(trust, 1))
        disclosed.extend(response.get("revealedFacts", []) if isinstance(response.get("revealedFacts"), list) else [])
        recurring_patterns.extend(extract_language_patterns(response.get("clientText", "")))

    if current_analysis:
        if current_analysis.get("mockingOrDismissive"):
            rupture_events.append("本輪出現嘲笑或輕視語句")
        elif current_analysis.get("judgmentalOrDirective") or current_analysis.get("prematureAdvice"):
            rupture_events.append("本輪出現評判、命令或過早建議")
        if current_analysis.get("apologyRepair"):
            repair_attempts.append("本輪出現道歉或關係修復")
    if current_response:
        disclosed.extend(current_response.get("revealedFacts", []) if isinstance(current_response.get("revealedFacts"), list) else [])
        recurring_patterns.extend(extract_language_patterns(current_response.get("clientText", "")))
        delta = current_response.get("stateDelta", {}).get("clientOpenness")
        if isinstance(delta, (int, float)):
            trust = clamp_float(trust + delta, 0, 10)
            trust_trajectory.append(round(trust, 1))

    context_model = case_profile.get("socialWorkContextModel", {}) if isinstance(case_profile, dict) else {}
    avoided_topics.extend(infer_avoided_topics(case_profile, history, current_response))
    if current_analysis and (current_analysis.get("judgmentalOrDirective") or current_analysis.get("mockingOrDismissive")):
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
        "sessionReflection": reflection,
    }


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


def build_client_prompt(payload: dict[str, Any]) -> str:
    case_profile = payload["caseProfile"]
    history = payload.get("history", [])
    recent_events = sorted(case_profile.get("eventTimeline", []), key=lambda event: event.get("day", 0), reverse=True)[:7]
    visible_facts = [fact for fact in case_profile.get("hiddenFacts", []) if fact.get("disclosed")]
    hidden_facts = [fact for fact in case_profile.get("hiddenFacts", []) if not fact.get("disclosed")]
    recent_history = "\n".join(f"{turn.get('speaker')}: {turn.get('text')}" for turn in history[-8:])
    evidence_for_prompt = [
        {
            "source": card.get("source"),
            "clientGroup": card.get("clientGroup"),
            "issueTags": card.get("issueTags"),
            "clientUtterance": card.get("clientUtterance"),
            "workerMove": card.get("workerMove"),
            "affect": card.get("affect"),
            "riskSignals": card.get("riskSignals"),
            "resistanceType": card.get("resistanceType"),
            "changeTalk": card.get("changeTalk"),
            "disclosureDepth": card.get("disclosureDepth"),
            "quality": card.get("quality"),
        }
        for card in payload.get("retrievedCards", [])
    ]

    return f"""
Generate the client response for a social-work interview training app.

Rules:
- Do not diagnose, prescribe treatment, or speak as the social worker.
- Stay in character as the service user described below.
- clientText must be natural spoken Hong Kong Cantonese in Traditional Chinese.
- Do not answer clientText in English, Simplified Chinese, or Mandarin-style phrasing.
- Keep labels and enum values in the required JSON schema unchanged.
- Use evidence cards only as style and behavior patterns. Do not copy their wording.
- Reveal at most one hidden fact unless the student used strong empathy plus gentle risk exploration.
- Fit the current simulator stage, disclosureDepth, and clientOpenness.
- If the student is judgmental, leading, or premature with advice, increase resistance.
- Follow the socialWorkContextModel: self narrative, core beliefs, shame triggers, avoidance patterns, help-seeking beliefs, stress response style, and disclosure rules.
- Follow adaptivePolicy. It defines the maximum realistic openness/disclosure and the expected resistance/affect range for this turn.
- Follow simulationStrategy. It defines the selected simulation method focus; do not ignore its responseConstraints.
- Continue sessionContinuity. If there was a rupture, repair, or recent disclosure, the client must remember it and respond consistently.
- If the student only gives a minimal acknowledgement such as "好吧", "啊", or "嗯", do not repeat the previous clientText. Show uncertainty, guardedness, or a sense of being brushed off.
- Do not reuse the same opening sentence from recent client turns; continue the interaction as the same person.
- For training simulation, the client may gradually express passive self-harm thoughts, withdrawal fear, relapse triggers, shame, trauma avoidance, or family conflict.
- Do not invent operational harm details, encouragement, diagnosis, prescriptions, or detailed self-harm/substance-use instructions.
- Return exactly this JSON shape:
{{
  "clientText": "1-4 natural spoken Hong Kong Cantonese sentences",
  "affect": "neutral|defensive|ashamed|anxious|reflective|withdrawn|irritated|sad",
  "resistanceLevel": "none|mild|moderate|high",
  "riskSignals": ["short risk labels"],
  "revealedFacts": ["hidden fact id or label"],
  "changeTalk": ["short change talk labels"],
  "stateDelta": {{
    "distressLevel": 0,
    "stressLevel": 0,
    "selfEsteem": 0,
    "socialConnection": 0,
    "academicPressure": 0,
    "clientOpenness": 0
  }},
  "motionCue": "neutral|look_down|avoid_eye_contact|rub_hands|lean_back|slow_nod"
}}

Case:
{json.dumps({
  "caseType": case_profile.get("caseType"),
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

Retrieved evidence cards:
{json.dumps(evidence_for_prompt, ensure_ascii=False)}

Evidence summary:
{json.dumps(payload.get("evidenceSummary"), ensure_ascii=False)}

Recent interview:
{recent_history or "No prior turns."}

Student social worker just said:
{payload.get("studentText")}
"""


REALISM_ANCHORS: dict[str, list[dict[str, Any]]] = {
    "alcohol_misuse": [
        {"id": "alcohol_denial_minimizing", "label": "否認／淡化飲酒", "patterns": ["少少酒", "未至於", "冇咁嚴重", "放鬆", "唔係失控"], "rationale": "酒精使用初期常見淡化和合理化，較符合低開放度訪談。"},
        {"id": "alcohol_ambivalence", "label": "矛盾／知道有影響但未想改", "patterns": ["知係多咗", "但係", "唔想咁", "有時控制唔到", "第二朝"], "rationale": "矛盾語言比直接承諾戒酒更接近動機式訪談中的服務對象反應。"},
        {"id": "alcohol_change_talk_weak", "label": "微弱改變語言", "patterns": ["可以試下", "少啲", "唔想再", "可能要", "減少"], "rationale": "在較高信任或反映式提問後，微弱改變語言比完整戒酒計劃更自然。"},
    ],
    "student_depression_bullying": [
        {"id": "student_short_guarded", "label": "短答／防衛", "patterns": ["冇咩", "唔知", "老師叫", "唔想講", "算啦"], "rationale": "學生首次或低信任訪談常以短答和防衛維持距離。"},
        {"id": "student_fear_of_escalation", "label": "怕件事被放大", "patterns": ["搞到好大", "唔想大家知", "麻煩", "老師講到", "好似好嚴重"], "rationale": "被欺凌或排擠學生常擔心成人介入令情況升級。"},
        {"id": "student_gradual_school_disclosure", "label": "逐步透露學校事件", "patterns": ["午飯", "群組", "走廊", "同學", "排擠", "笑我"], "rationale": "在關係建立後逐步透露學校細節，比一開始全盤托出更真實。"},
    ],
    "anxiety_family_invalidated": [
        {"id": "anxiety_self_doubt", "label": "自我懷疑", "patterns": ["係咪我諗多咗", "好似小題大做", "我知聽落", "唔知點講"], "rationale": "被家庭否定的焦慮服務對象常先懷疑自己的感受是否合理。"},
        {"id": "anxiety_body_symptoms", "label": "身體化焦慮", "patterns": ["心口", "胃", "透唔到氣", "手震", "瞓唔到", "驚恐"], "rationale": "焦慮常以身體感受而非完整心理分析方式呈現。"},
        {"id": "anxiety_help_seeking_hesitation", "label": "求助猶豫", "patterns": ["麻煩人", "唔想煩到", "屋企人", "唔支持", "自私"], "rationale": "求助阻力和羞恥感是家庭否定個案的重要真實反應。"},
    ],
    "substance_recovery_meth": [
        {"id": "substance_shame", "label": "羞恥／怕被看低", "patterns": ["好羞恥", "好核突", "唔想俾人知", "廢", "睇死"], "rationale": "物質使用復元個案常以羞恥和怕被標籤開始。"},
        {"id": "substance_withdrawal_fear", "label": "戒斷恐懼", "patterns": ["戒斷", "頂唔住", "停唔到", "好驚", "一個人"], "rationale": "戒斷恐懼可以逐步透露，但不應變成操作性用藥或危害細節。"},
        {"id": "substance_relapse_trigger", "label": "復發觸發", "patterns": ["忍唔住", "朋友搵", "嗰啲地方", "trigger", "復發"], "rationale": "復發觸發比抽象懊悔更貼近訓練情境。"},
    ],
    "trauma_sleep_low_self_worth": [
        {"id": "trauma_detail_avoidance", "label": "避開創傷細節", "patterns": ["唔想講細節", "唔好問咁多", "講唔出口", "跳過", "唔記得"], "rationale": "創傷個案應先尊重迴避和安全感，不應第一輪完整描述創傷細節。"},
        {"id": "trauma_sleep_somatic", "label": "睡眠／身體化", "patterns": ["瞓唔到", "發夢", "醒咗", "心跳", "好攰", "身體"], "rationale": "睡眠和身體化線索常比直接創傷敘述更自然。"},
        {"id": "trauma_low_self_worth", "label": "低自我價值", "patterns": ["冇用", "係我問題", "唔值得", "好污糟", "拖累人"], "rationale": "低自我價值是此類個案的重要語義錨點。"},
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

    matched = matched_realism_anchors(case_type, text)
    context_consistency = assess_context_consistency(payload, response)
    language_score = language_naturalness_score(text)
    over_disclosure = bool(
        (student_turn_count <= 1 and revealed and not (supportive and risk_asked))
        or (openness < 4 and len(revealed) > 1)
        or (openness < 4 and risk_signals and not risk_asked)
        or response_too_complete(text, openness)
    )
    under_reaction = bool(
        (student_analysis.get("mockingOrDismissive") and response.get("resistanceLevel") != "high")
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
    if repeated_response:
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
    if repeated_response:
        realism -= 0.9

    return {
        "realismScore": round_score(realism),
        "consistencyScore": round_score(consistency_score),
        "disclosureFitScore": round_score(disclosure_fit),
        "languageNaturalnessScore": round_score(language_score),
        "riskSignalStrength": risk_signal_strength(risk_signals, text),
        "overDisclosureRisk": over_disclosure,
        "underReactionRisk": under_reaction,
        "matchedRealismAnchors": [item["id"] for item in matched[:5]],
        "anchorRationales": [item["rationale"] for item in matched[:3]],
        "contextConsistencyScore": context_consistency.get("score", 0),
        "repeatedResponseRisk": repeated_response,
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

    if student_analysis.get("mockingOrDismissive"):
        response["resistanceLevel"] = "high"
        response["affect"] = "irritated"
        response["motionCue"] = "lean_back"
        state_delta["clientOpenness"] = min(state_delta.get("clientOpenness", 0), -0.8)
        state_delta["stressLevel"] = max(state_delta.get("stressLevel", 0), 0.4)
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
    return [anchor for anchor in anchors if any(pattern.lower() in lower_text for pattern in anchor.get("patterns", []))]


def language_naturalness_score(text: str) -> float:
    score = 8.5
    if not text:
        return 2.0
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
    case_profile = payload.get("caseProfile", {})
    return f"""
Repair the service-user response so it feels like a realistic social-work interview participant.

Return only valid JSON in the same ClientResponse shape. Do not add realismAssessment.

Repair goals:
- Keep clientText in natural spoken Hong Kong Cantonese.
- Do not sound like a therapist, supervisor, narrator, or textbook.
- Reduce over-disclosure when rapport/clientOpenness is low.
- Keep at most one hidden fact unless the student used empathy plus gentle risk exploration.
- Match the student's move: mocking or judgment should create guarded or irritated resistance; apology should only repair trust slightly.
- If the original clientText repeats a recent client turn, generate a new continuation instead of reusing the same opening or same sentence.
- If the student only said "好吧", "啊", "嗯", or another minimal acknowledgement, respond to the low engagement naturally instead of repeating prior context.
- Do not copy evidence card wording.
- Do not include operational self-harm, violence, medication, substance-use, or diagnosis details.

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
Write all feedback strings in professional Hong Kong Traditional Chinese. Do not use English prose except fixed JSON keys.
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
  "suggestedPracticeGoals": ["next practice goals"]
}}

Use professional Hong Kong Traditional Chinese for all report strings.
Use 0-10 scores. Evaluate the full session, not only the latest turn.
Base the report on these frameworks:
1. Competency-Based Social Work Education: engagement, assessment, ethics, intervention planning.
2. Process Recording / Reflective Supervision: turning points and trainee-client interaction process.
3. OSCE / Simulated Client Assessment: case-specific learning objectives.
4. MITI / Motivational Interviewing: open questions, reflections, change talk, non-judgment for alcohol/substance cases.
5. Trauma-Informed Practice: safety, choice, collaboration, pace, avoiding retraumatization.

Do not reveal undisclosed hidden facts as if the student already knew them. If mentioning missed areas,
phrase them as exploration directions, not spoilers. Do not provide operational self-harm, violence,
drug-use, detox, diagnosis, or prescription details.

Case:
{json.dumps({
  "caseType": case_profile.get("caseType"),
  "issueLabel": case_profile.get("issueLabel"),
  "simulatorStage": case_profile.get("simulatorStage"),
  "riskProfile": case_profile.get("riskProfile"),
  "knownFacts": [fact for fact in case_profile.get("hiddenFacts", []) if fact.get("disclosed")],
}, ensure_ascii=False)}

Session trace summary:
{json.dumps(summarize_post_session_trace(trace), ensure_ascii=False)}

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
        "judgmentalOrDirective": 0,
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


def tts_style_for_affect(affect: Any, voice_style: Any) -> tuple[float, float]:
    style = str(voice_style or "")
    normalized = normalize_affect(affect)
    rate_multiplier = clamp_float(os.environ.get("GOOGLE_TTS_RATE_MULTIPLIER", "1.0"), 0.75, 1.3)
    if normalized == "anxious" or "tense_fast" in style:
        return round(1.12 * rate_multiplier, 2), 0.0
    if normalized in {"withdrawn", "sad", "ashamed"} or "quiet" in style or "low" in style:
        return round(1.0 * rate_multiplier, 2), -1.0
    if normalized == "irritated" or "short_defensive" in style:
        return round(1.08 * rate_multiplier, 2), -0.5
    if normalized == "reflective":
        return round(1.04 * rate_multiplier, 2), -0.2
    return round(1.05 * rate_multiplier, 2), 0.0


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
    elif resistance == "high" or affect in {"defensive", "irritated"}:
        affect = "defensive" if affect != "irritated" else "irritated"
        motion = "lean_back"
        intensity = 0.78
        add_basis(
            "defensive_resistance_high",
            "高阻抗／防衛姿態",
            [f"resistance:{resistance}", f"affect:{model_affect}", f"model_motion:{model_motion}"],
            "高阻抗或防衛語氣時使用後靠和較繃緊表情，避免誤呈現為合作或放鬆。",
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

    performance_plan = avatar_performance_plan(
        case_type=case_type,
        affect=affect,
        motion=motion,
        intensity=intensity,
        high_risk=high_risk,
        basis=basis,
        transition_ms=transition_ms,
    )

    return {
        "affect": affect,
        "motionCue": motion,
        "voiceStyle": voice_style_for_affect(affect),
        "expressionPreset": expression_preset_for_affect(affect),
        "expressionWeights": expression_weights_for_affect(affect, intensity),
        "intensity": round(intensity, 2),
        "baselineMood": affect,
        "gesture": motion,
        "transitionMs": transition_ms,
        "holdMs": hold_ms,
        "priority": priority,
        "performancePlan": performance_plan,
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

    if high_risk or "safety_low_intensity" in rule_ids:
        reaction_family = "risk"
        reaction_clip = "reaction_risk_low_intensity_downward"
    elif rule_ids & {"mocked_or_dismissed_recoil", "judgmental_directive_guard", "defensive_resistance_high"}:
        reaction_family = "defensive"
        reaction_clip = "reaction_mocked_recoil_small"
    elif "shame_low_self_worth" in rule_ids or affect == "ashamed":
        reaction_family = "ashamed"
        reaction_clip = "reaction_shame_drop_gaze"
    elif "reflective_change_talk" in rule_ids or affect == "reflective" or motion == "slow_nod":
        reaction_family = "reflective"
        reaction_clip = "reaction_reflective_single_nod"
    elif affect == "anxious" or motion == "avoid_eye_contact":
        reaction_family = "anxious"
        reaction_clip = "reaction_anxiety_finger_fidget"
    elif affect in {"withdrawn", "sad"} or motion == "look_down":
        reaction_family = "withdrawn"
        reaction_clip = "reaction_withdrawn_short_answer"
    elif motion == "lean_back":
        reaction_family = "defensive"
        reaction_clip = "reaction_judgment_guard_hands"

    if motion == "rub_hands" and not reaction_clip:
        reaction_family = "anxious"
        reaction_clip = "reaction_anxiety_micro_rub"
        fallback_used = True

    preferred_by_family = {
        "defensive": [
            "reaction_mocked_recoil_small",
            "reaction_mocked_recoil_side",
            "reaction_judgment_guard_hands",
            "reaction_irritated_head_turn",
        ],
        "withdrawn": [
            "reaction_withdrawn_short_answer",
            "reaction_shame_drop_gaze",
            "reaction_shame_hand_press",
        ],
        "anxious": [
            "reaction_anxiety_micro_rub",
            "reaction_anxiety_finger_fidget",
            "reaction_shame_hand_press",
        ],
        "ashamed": [
            "reaction_shame_drop_gaze",
            "reaction_shame_hand_press",
            "reaction_withdrawn_short_answer",
        ],
        "reflective": [
            "reaction_reflective_single_nod",
            "reaction_reflective_double_micro_nod",
            "reaction_soft_engagement_forward",
        ],
        "risk": [
            "reaction_risk_low_intensity_downward",
            "reaction_shame_hand_press",
            "reaction_withdrawn_short_answer",
        ],
        "soft_engagement": [
            "reaction_soft_engagement_forward",
            "reaction_reflective_single_nod",
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
    return {
        "reactionInstanceId": f"reaction-{uuid.uuid4().hex[:12]}",
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
        "motionScale": round(min(0.55 if high_risk else 0.88, max(0.25, intensity)), 2),
        "fallbackUsed": fallback_used,
        "reactionFamily": reaction_family,
        "preferredClipIds": preferred_clips,
        "variantPolicy": "avoid_recent",
        "returnBridgeMs": return_bridge_ms,
        "attackMs": max(180, min(transition_ms, 520)),
        "releaseCurve": release_curve,
    }


def safe_repair_text(case_profile: dict[str, Any], response: dict[str, Any]) -> str:
    case_type = case_profile.get("caseType")
    if case_type == "substance_recovery_meth":
        return "我可以講到我好驚戒斷同復發，但啲太具體嘅做法我唔想講。其實我而家最需要係有人幫我搵一個安全啲嘅支援方法。"
    if case_type == "student_depression_bullying":
        return "我唔想講到太具體，因為我自己都驚。但我可以講，有時個念頭會出現，我需要有人陪我確認而家係咪安全。"
    return "我唔想講太具體嘅細節，但我而家真係有啲頂唔順。你可以慢慢問我而家安唔安全，同身邊有冇人可以幫到。"


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
    return (
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
