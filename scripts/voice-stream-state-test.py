#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import adk_service.main as service_main  # noqa: E402

SEEN_EVENTS: list[dict[str, Any]] = []
FAKE_COORDINATOR = None


class FakeCaseState:
    def apply_response(self, case_profile: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        return {**case_profile, "lastClientText": response.get("clientText", "")}


class FakeSpeechSession:
    def __init__(self, audio_chunks: list[bytes]) -> None:
        self.audio_chunks = audio_chunks

    def send_audio(self, audio: bytes) -> None:
        self.audio_chunks.append(audio)

    def stop(self) -> None:
        return None


class FakeCoordinator:
    def __init__(self) -> None:
        self.event_queue = None
        self.loop = None
        self.student_texts: list[str] = []
        self.audio_chunks: list[bytes] = []
        self.case_state = FakeCaseState()

    def start_speech_stream(self, sample_rate: int, event_queue: Any, loop: Any) -> FakeSpeechSession:
        self.event_queue = event_queue
        self.loop = loop
        return FakeSpeechSession(self.audio_chunks)

    def emit(self, event: dict[str, Any]) -> None:
        if not self.event_queue or not self.loop:
            raise RuntimeError("Speech stream was not started.")
        self.loop.call_soon_threadsafe(self.event_queue.put_nowait, event)

    async def interview_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.student_texts.append(str(payload.get("studentText", "")))
        if len(self.student_texts) == 1:
            await asyncio.sleep(0.25)
        return {
            "clientText": f"回覆：{payload.get('studentText')}",
            "affect": "reflective",
            "riskSignals": [],
            "revealedFacts": [],
            "resistanceLevel": "mild",
            "stateDelta": {},
            "motionCue": "slow_nod",
            "avatarDirective": {
                "ttsText": f"回覆：{payload.get('studentText')}",
                "voiceStyle": "soft_reflective",
                "motionCue": "slow_nod",
            },
        }

    def synthesize_tts(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {
            "mimeType": "audio/wav",
            "audioBase64": "AA==",
            "provider": "fake-google-tts",
            "voice": "fake-male",
            "voiceGender": "male",
        }


def receive_until(ws: Any, event_type: str, seen: list[dict[str, Any]]) -> dict[str, Any]:
    while True:
        message = ws.receive_json()
        seen.append(message)
        if message.get("type") == event_type:
            return message


def receive_until_count(ws: Any, event_type: str, count: int, seen: list[dict[str, Any]]) -> list[dict[str, Any]]:
    while len([item for item in seen if item.get("type") == event_type]) < count:
        message = ws.receive_json()
        seen.append(message)
    return [item for item in seen if item.get("type") == event_type]


def handle_timeout(signum: int, frame: Any) -> None:
    processed = getattr(FAKE_COORDINATOR, "student_texts", None)
    print({"timeout": True, "processedTranscripts": processed, "seen": SEEN_EVENTS}, flush=True)
    raise TimeoutError("voice stream state test timed out")


def main() -> None:
    global FAKE_COORDINATOR
    signal.signal(signal.SIGALRM, handle_timeout)
    signal.alarm(15)
    fake = FakeCoordinator()
    FAKE_COORDINATOR = fake
    original = service_main.coordinator
    service_main.coordinator = fake
    seen = SEEN_EVENTS
    try:
        client = TestClient(service_main.app)
        with client.websocket_connect("/api/voice-stream") as ws:
            ws.send_json({
                "type": "start",
                "sessionId": "voice-state-test",
                "caseProfile": {"id": "case", "caseType": "student_depression_bullying"},
                "history": [],
                "responseLanguage": "cantonese",
                "sampleRate": 16000,
            })
            receive_until(ws, "voice_ready", seen)
            receive_until(ws, "listening_ready", seen)
            ws.send_bytes(b"\x00\x01\x02\x03")

            fake.emit({"type": "asr_final", "transcript": "你好"})
            receive_until(ws, "asr_partial", seen)
            fake.emit({"type": "asr_partial", "transcript": "你好我想講多啲"})
            receive_until(ws, "asr_partial", seen)
            receive_until(ws, "turn_started", seen)

            fake.emit({"type": "asr_final", "transcript": "第二句"})
            receive_until_count(ws, "client_response", 2, seen)
            receive_until_count(ws, "tts_audio", 2, seen)

        if fake.student_texts[:2] != ["你好我想講多啲", "第二句"]:
            raise AssertionError(f"Unexpected processed transcripts: {fake.student_texts}")
        if fake.audio_chunks != [b"\x00\x01\x02\x03"]:
            raise AssertionError(f"Binary PCM frame was not forwarded: {fake.audio_chunks}")
        committed = [item.get("transcript") for item in seen if item.get("type") == "utterance_committed"]
        if committed[:2] != ["你好我想講多啲", "第二句"]:
            raise AssertionError(f"Unexpected committed transcripts: {committed}")
        client_texts = [
            item.get("response", {}).get("clientText")
            for item in seen
            if item.get("type") == "client_response"
        ]
        if client_texts[:2] != ["回覆：你好我想講多啲", "回覆：第二句"]:
            raise AssertionError(f"Unexpected client responses: {client_texts}")
        tts_genders = [item.get("voiceGender") for item in seen if item.get("type") == "tts_audio"]
        if tts_genders[:2] != ["male", "male"]:
            raise AssertionError(f"Unexpected TTS genders: {tts_genders}")
        timed_events = [
            item.get("type")
            for item in seen
            if item.get("type") in {"asr_final", "utterance_committed", "turn_started", "client_response", "tts_audio"}
            and isinstance(item.get("serverElapsedMs"), int)
        ]
        for required_event in ["asr_final", "utterance_committed", "turn_started", "client_response", "tts_audio"]:
            if required_event not in timed_events:
                raise AssertionError(f"Missing serverElapsedMs on {required_event}: {seen}")
        print({
            "ok": True,
            "processedTranscripts": fake.student_texts,
            "committedTranscripts": committed,
            "clientResponses": client_texts,
            "timedEvents": timed_events,
            "eventCount": len(seen),
            "binaryPcmFrames": len(fake.audio_chunks),
        })
    finally:
        service_main.coordinator = original
        signal.alarm(0)


if __name__ == "__main__":
    main()
