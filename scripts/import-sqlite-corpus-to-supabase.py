from __future__ import annotations

import argparse
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SQLITE = ROOT / "data" / "corpus" / "social-work-client-corpus.sqlite"


def main() -> None:
    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")

    parser = argparse.ArgumentParser(description="Import local SQLite corpus into Supabase Postgres.")
    parser.add_argument("--sqlite", default=str(DEFAULT_SQLITE), help="Path to local corpus SQLite database.")
    args = parser.parse_args()

    sqlite_path = Path(args.sqlite)
    database_url = os.environ.get("SUPABASE_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not database_url:
        raise SystemExit("SUPABASE_DATABASE_URL or DATABASE_URL is required.")
    if not sqlite_path.exists():
        raise SystemExit(f"SQLite corpus not found: {sqlite_path}")

    with sqlite3.connect(sqlite_path) as source:
        source.row_factory = sqlite3.Row
        with psycopg.connect(database_url) as target:
            with target.transaction():
                import_runs(source, target)
                raw_rows(source, target)
                evidence_cards(source, target)
                curation_flags(source, target)

    print(f"Imported SQLite corpus into Supabase from {sqlite_path}")


def import_runs(source: sqlite3.Connection, target: psycopg.Connection[Any]) -> None:
    rows = source.execute(
        """
        SELECT id, started_at, completed_at, source, dataset, config, split,
               requested_limit, row_count, card_count, error
        FROM import_runs
        """
    ).fetchall()
    target.executemany(
        """
        INSERT INTO import_runs (
          id, started_at, completed_at, source, dataset, config, split,
          requested_limit, row_count, card_count, error
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
          completed_at = EXCLUDED.completed_at,
          config = EXCLUDED.config,
          split = EXCLUDED.split,
          requested_limit = EXCLUDED.requested_limit,
          row_count = EXCLUDED.row_count,
          card_count = EXCLUDED.card_count,
          error = EXCLUDED.error
        """,
        [tuple(row) for row in rows],
    )
    print(f"import_runs: {len(rows)}")


def raw_rows(source: sqlite3.Connection, target: psycopg.Connection[Any]) -> None:
    rows = source.execute(
        """
        SELECT id, run_id, source, hf_row_idx, row_hash, raw_json, license_note, imported_at
        FROM raw_rows
        """
    ).fetchall()
    target.executemany(
        """
        INSERT INTO raw_rows (
          id, run_id, source, hf_row_idx, row_hash, raw_json, license_note, imported_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
          run_id = EXCLUDED.run_id,
          source = EXCLUDED.source,
          hf_row_idx = EXCLUDED.hf_row_idx,
          row_hash = EXCLUDED.row_hash,
          raw_json = EXCLUDED.raw_json,
          license_note = EXCLUDED.license_note,
          imported_at = EXCLUDED.imported_at
        """,
        [
            (
                row["id"],
                row["run_id"],
                row["source"],
                row["hf_row_idx"],
                row["row_hash"],
                Jsonb(json.loads(row["raw_json"])),
                row["license_note"],
                row["imported_at"],
            )
            for row in rows
        ],
    )
    print(f"raw_rows: {len(rows)}")


def evidence_cards(source: sqlite3.Connection, target: psycopg.Connection[Any]) -> None:
    rows = source.execute(
        """
        SELECT id, raw_row_id, source, client_group, issue_tags, client_utterance,
               worker_move, affect, risk_signals, resistance_type, change_talk,
               disclosure_depth, quality, license_note, provenance_note, review_flags
        FROM evidence_cards
        """
    ).fetchall()
    target.executemany(
        """
        INSERT INTO evidence_cards (
          id, raw_row_id, source, client_group, issue_tags, client_utterance,
          worker_move, affect, risk_signals, resistance_type, change_talk,
          disclosure_depth, quality, license_note, provenance_note, review_flags
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
          raw_row_id = EXCLUDED.raw_row_id,
          source = EXCLUDED.source,
          client_group = EXCLUDED.client_group,
          issue_tags = EXCLUDED.issue_tags,
          client_utterance = EXCLUDED.client_utterance,
          worker_move = EXCLUDED.worker_move,
          affect = EXCLUDED.affect,
          risk_signals = EXCLUDED.risk_signals,
          resistance_type = EXCLUDED.resistance_type,
          change_talk = EXCLUDED.change_talk,
          disclosure_depth = EXCLUDED.disclosure_depth,
          quality = EXCLUDED.quality,
          license_note = EXCLUDED.license_note,
          provenance_note = EXCLUDED.provenance_note,
          review_flags = EXCLUDED.review_flags
        """,
        [
            (
                row["id"],
                row["raw_row_id"],
                row["source"],
                row["client_group"],
                Jsonb(json.loads(row["issue_tags"])),
                row["client_utterance"],
                row["worker_move"],
                row["affect"],
                Jsonb(json.loads(row["risk_signals"])),
                row["resistance_type"],
                Jsonb(json.loads(row["change_talk"])),
                row["disclosure_depth"],
                row["quality"],
                row["license_note"],
                row["provenance_note"],
                Jsonb(json.loads(row["review_flags"])),
            )
            for row in rows
        ],
    )
    print(f"evidence_cards: {len(rows)}")


def curation_flags(source: sqlite3.Connection, target: psycopg.Connection[Any]) -> None:
    rows = source.execute("SELECT id, card_id, flag, reason FROM curation_flags").fetchall()
    target.executemany(
        """
        INSERT INTO curation_flags (id, card_id, flag, reason)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE SET
          card_id = EXCLUDED.card_id,
          flag = EXCLUDED.flag,
          reason = EXCLUDED.reason
        """,
        [tuple(row) for row in rows],
    )
    print(f"curation_flags: {len(rows)}")


def load_local_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text("utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


if __name__ == "__main__":
    main()
