#!/usr/bin/env python3
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service.runtime import (  # noqa: E402
    google_stt_v1_streaming_model,
    tts_style_for_affect,
    tts_voice_candidates,
)


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    os.environ["GOOGLE_TTS_VOICE"] = "yue-HK-Standard-D"
    os.environ["GOOGLE_TTS_MALE_VOICES"] = "yue-HK-Standard-D,yue-HK-Standard-B"
    os.environ["GOOGLE_TTS_EN_VOICE"] = "en-US-Wavenet-D"
    os.environ["GOOGLE_TTS_EN_MALE_VOICES"] = "en-US-Wavenet-D,en-US-Neural2-D"
    os.environ["GOOGLE_TTS_RATE_VARIATION_ENABLED"] = "true"
    os.environ.pop("GOOGLE_TTS_ALLOW_ANY_VOICE_OVERRIDE", None)

    cantonese_candidates = tts_voice_candidates("cantonese", "some-female-or-unknown-voice")
    expect(cantonese_candidates[0] == "yue-HK-Standard-D", "Cantonese TTS must prefer configured male voice.")
    expect("some-female-or-unknown-voice" not in cantonese_candidates, "Unknown voice override should not bypass male allowlist.")
    expect(None in cantonese_candidates, "Unnamed MALE fallback should be available.")

    english_candidates = tts_voice_candidates("english", None)
    expect(english_candidates[0] == "en-US-Wavenet-D", "English TTS must prefer configured male voice.")

    expect(google_stt_v1_streaming_model("chirp_2") is None, "Speech-to-Text v2 Chirp model must not be sent to v1 streaming.")
    expect(google_stt_v1_streaming_model("google-stt-v1-auto") is None, "Auto STT model should use Google v1 default.")
    expect(google_stt_v1_streaming_model("latest_short") == "latest_short", "Valid v1 model should pass through.")

    rate_a, pitch_a = tts_style_for_affect("anxious", "tense_fast", "我有啲驚。")
    rate_b, pitch_b = tts_style_for_affect("withdrawn", "low_flat", "我唔係好想講……")
    expect(rate_a > rate_b, "Anxious voice should be faster than withdrawn voice.")
    expect(pitch_b < pitch_a, "Withdrawn voice should keep lower pitch target.")

    print("Validated voice policy, male TTS allowlist, STT model normalization, and style variation.")


if __name__ == "__main__":
    main()
