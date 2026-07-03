#!/usr/bin/env python3
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import VoiceSynthesisAgent, load_local_env  # noqa: E402


def synthesize(agent: VoiceSynthesisAgent, text: str, language: str) -> dict:
    response = agent.synthesize({
        "text": text,
        "language": language,
        "affect": "reflective",
        "voiceStyle": "soft_reflective",
    })
    return {
        "language": language,
        "voice": response.get("voice"),
        "voiceGender": response.get("voiceGender"),
        "mimeType": response.get("mimeType"),
        "audioBytes": len(response.get("audioBase64", "")),
        "lipSyncProvider": response.get("lipSync", {}).get("provider"),
        "lipSyncFallbackUsed": response.get("lipSync", {}).get("fallbackUsed", False),
        "lipSyncCueCount": len(response.get("lipSync", {}).get("mappedVisemes", [])),
    }


def main() -> None:
    load_local_env(ROOT / ".env.local")
    load_local_env(ROOT / "adk_service" / ".env")
    agent = VoiceSynthesisAgent()
    results = [
        synthesize(agent, "我而家可以慢慢講。", "cantonese"),
        synthesize(agent, "I can talk about it slowly.", "english"),
    ]
    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
