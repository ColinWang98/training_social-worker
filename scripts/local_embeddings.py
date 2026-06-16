from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import struct
import time
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CORPUS_DB = ROOT / "data" / "corpus" / "social-work-client-corpus.sqlite"
EMBEDDING_DB = ROOT / "data" / "corpus" / "social-work-client-embeddings.sqlite"
DEFAULT_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"


def load_local_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_local_env(ROOT / ".env.local")
load_local_env(ROOT / "adk_service" / ".env")


def embedding_model_name() -> str:
    return os.environ.get("LOCAL_EMBEDDING_MODEL", DEFAULT_MODEL)


def embedding_batch_size() -> int:
    try:
        return max(1, int(os.environ.get("LOCAL_EMBEDDING_BATCH_SIZE", "64")))
    except ValueError:
        return 64


def embedding_device() -> str:
    return os.environ.get("LOCAL_EMBEDDING_DEVICE", "cpu")


def runtime_card_rows(limit: int | None = None) -> list[sqlite3.Row]:
    if not CORPUS_DB.exists():
        raise SystemExit(f"Missing corpus SQLite: {CORPUS_DB}")
    sql = """
        SELECT id, source, client_group, issue_tags, client_utterance, worker_move,
               affect, risk_signals, resistance_type, change_talk, disclosure_depth,
               quality
        FROM evidence_cards
        WHERE quality IN ('approved', 'review')
          AND source != 'reddit_mental_health_private'
        ORDER BY id
    """
    if limit:
        sql += " LIMIT ?"
    with sqlite3.connect(CORPUS_DB) as db:
        db.row_factory = sqlite3.Row
        return db.execute(sql, (limit,) if limit else ()).fetchall()


def embedding_text(row: sqlite3.Row | dict[str, Any]) -> str:
    issue_tags = json_list(row["issue_tags"])
    risk_signals = json_list(row["risk_signals"])
    change_talk = json_list(row["change_talk"])
    parts = [
        str(row["client_utterance"] or ""),
        str(row["worker_move"] or ""),
        " ".join(issue_tags),
        str(row["affect"] or ""),
        str(row["resistance_type"] or ""),
        " ".join(risk_signals),
        " ".join(change_talk[:4]),
        str(row["client_group"] or ""),
        str(row["source"] or ""),
    ]
    return normalize_embedding_text(" ".join(part for part in parts if part))


def normalize_embedding_text(text: str) -> str:
    return " ".join(text.replace("\n", " ").split())


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def json_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except json.JSONDecodeError:
            return [value]
    return []


def connect_embedding_db() -> sqlite3.Connection:
    EMBEDDING_DB.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(EMBEDDING_DB)
    db.row_factory = sqlite3.Row
    db.execute(
        """
        CREATE TABLE IF NOT EXISTS evidence_card_embeddings (
          card_id TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_dim INTEGER NOT NULL,
          embedding_text_hash TEXT NOT NULL,
          embedding_vector_blob BLOB NOT NULL,
          embedded_at TEXT NOT NULL,
          PRIMARY KEY (card_id, embedding_model)
        )
        """
    )
    columns = db.execute("PRAGMA table_info(evidence_card_embeddings)").fetchall()
    primary_key_columns = [column[1] for column in sorted(columns, key=lambda item: item[5]) if column[5]]
    if primary_key_columns == ["card_id"]:
        db.executescript(
            """
            ALTER TABLE evidence_card_embeddings RENAME TO evidence_card_embeddings_legacy;
            CREATE TABLE evidence_card_embeddings (
              card_id TEXT NOT NULL,
              embedding_model TEXT NOT NULL,
              embedding_dim INTEGER NOT NULL,
              embedding_text_hash TEXT NOT NULL,
              embedding_vector_blob BLOB NOT NULL,
              embedded_at TEXT NOT NULL,
              PRIMARY KEY (card_id, embedding_model)
            );
            INSERT OR REPLACE INTO evidence_card_embeddings
              (card_id, embedding_model, embedding_dim, embedding_text_hash, embedding_vector_blob, embedded_at)
            SELECT card_id, embedding_model, embedding_dim, embedding_text_hash, embedding_vector_blob, embedded_at
            FROM evidence_card_embeddings_legacy;
            DROP TABLE evidence_card_embeddings_legacy;
            """
        )
    db.execute("CREATE INDEX IF NOT EXISTS idx_embedding_model ON evidence_card_embeddings(embedding_model)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_embedding_hash ON evidence_card_embeddings(embedding_text_hash)")
    return db


def load_sentence_transformer(model_name: str, device: str):
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:
        raise SystemExit(
            "sentence-transformers is required for local embeddings. "
            "Install it in your Python environment, for example: "
            "python3 -m pip install 'sentence-transformers>=3,<4'"
        ) from exc
    local_model = resolve_local_model_snapshot(model_name)
    if local_model:
        return SentenceTransformer(str(local_model), device=device, local_files_only=True)
    return SentenceTransformer(model_name, device=device)


def resolve_local_model_snapshot(model_name: str) -> Path | None:
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


def encode_texts(model: Any, texts: list[str]) -> list[list[float]]:
    vectors = model.encode(
        texts,
        batch_size=max(1, embedding_batch_size()),
        normalize_embeddings=True,
        show_progress_bar=True,
    )
    return [[float(value) for value in vector] for vector in vectors]


def pack_vector(vector: Iterable[float]) -> bytes:
    values = list(vector)
    return struct.pack(f"<{len(values)}f", *values)


def unpack_vector(blob: bytes) -> list[float]:
    if not blob:
        return []
    return list(struct.unpack(f"<{len(blob) // 4}f", blob))


def stale_or_missing_rows(rows: list[sqlite3.Row], model_name: str, limit: int | None = None) -> list[tuple[sqlite3.Row, str, str]]:
    with connect_embedding_db() as db:
        existing = {
            row["card_id"]: row
            for row in db.execute(
                "SELECT card_id, embedding_model, embedding_text_hash FROM evidence_card_embeddings WHERE embedding_model = ?",
                (model_name,),
            )
        }
    pending: list[tuple[sqlite3.Row, str, str]] = []
    for row in rows:
        text = embedding_text(row)
        digest = text_hash(text)
        current = existing.get(row["id"])
        if not current or current["embedding_text_hash"] != digest:
            pending.append((row, text, digest))
            if limit and len(pending) >= limit:
                break
    return pending


def write_embeddings(items: list[tuple[sqlite3.Row, str, str]], vectors: list[list[float]], model_name: str) -> None:
    if len(items) != len(vectors):
        raise RuntimeError("Embedding item/vector count mismatch.")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with connect_embedding_db() as db:
        db.executemany(
            """
            INSERT INTO evidence_card_embeddings (
              card_id, embedding_model, embedding_dim, embedding_text_hash, embedding_vector_blob, embedded_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(card_id, embedding_model) DO UPDATE SET
              embedding_dim = excluded.embedding_dim,
              embedding_text_hash = excluded.embedding_text_hash,
              embedding_vector_blob = excluded.embedding_vector_blob,
              embedded_at = excluded.embedded_at
            """,
            [
                (row["id"], model_name, len(vector), digest, pack_vector(vector), now)
                for (row, _, digest), vector in zip(items, vectors)
            ],
        )
        db.commit()


def embedding_stats(model_name: str | None = None) -> dict[str, Any]:
    rows = runtime_card_rows()
    total = len(rows)
    model = model_name or embedding_model_name()
    with connect_embedding_db() as db:
        db.row_factory = sqlite3.Row
        embedded = int(
            db.execute(
                "SELECT COUNT(*) FROM evidence_card_embeddings WHERE embedding_model = ?",
                (model,),
            ).fetchone()[0]
        )
        dims = [
            dict(row)
            for row in db.execute(
                "SELECT embedding_dim, COUNT(*) AS count FROM evidence_card_embeddings WHERE embedding_model = ? GROUP BY embedding_dim",
                (model,),
            ).fetchall()
        ]
    pending = stale_or_missing_rows(rows, model)
    return {
        "model": model,
        "dbPath": str(EMBEDDING_DB),
        "runtimeEligibleCards": total,
        "embeddedCards": embedded,
        "coverage": round(embedded / total, 4) if total else 0,
        "staleOrMissingCards": len(pending),
        "dimensions": dims,
    }


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=embedding_model_name())
    parser.add_argument("--limit", type=int, default=None)
