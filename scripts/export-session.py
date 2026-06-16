#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a persisted simulator session trace.")
    parser.add_argument("--session-id", required=True, help="ADK simulator session id")
    parser.add_argument("--out", help="Output JSON path. Defaults to data/session-logs/<session-id>.json")
    args = parser.parse_args()

    from adk_service.runtime import SocialWorkCoordinatorAgent, load_local_env

    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")
    coordinator = SocialWorkCoordinatorAgent(ROOT)
    record = coordinator.export_session({"sessionId": args.session_id})

    out_path = Path(args.out) if args.out else ROOT / "data" / "session-logs" / f"{args.session_id}.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    record["exportedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    out_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", "utf-8")
    print(json.dumps({"ok": True, "path": str(out_path), "sessionId": args.session_id}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
