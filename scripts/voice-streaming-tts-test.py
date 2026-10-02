#!/usr/bin/env python3
from __future__ import annotations

import signal
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import adk_service.main as service_main  # noqa: E402


class FakeCaseState:
    def apply_response(self, case_profile: dict[str, Any], response: dict[str, Any]) -> dict[str, Any]:
        return case_profile


class FakeSpeechSession:
    def send_audio(self, _audio: bytes) -> None:
        return None

    def stop(self) -> None:
        return None


class FakeTtsSession:
    def stop(self) -> None:
        return None


class FakeVoiceSynthesis:
    def streaming_capability(self) -> dict[str, Any]:
        return {"available": True}


class FakeCoordinator:
    def __init__(self, fail_stream: bool = False) -> None:
        self.event_queue = None
        self.loop = None
        self.fail_stream = fail_stream
        self.standard_calls = 0
        self.standard_texts: list[str] = []
        self.voice_synthesis = FakeVoiceSynthesis()
        self.case_state = FakeCaseState()

    def start_speech_stream(self, _sample_rate: int, event_queue: Any, loop: Any, _stream_id: str | None = None) -> FakeSpeechSession:
        self.event_queue = event_queue
        self.loop = loop
        return FakeSpeechSession()

    def emit_asr(self, transcript: str) -> None:
        self.loop.call_soon_threadsafe(self.event_queue.put_nowait, {"type": "asr_final", "transcript": transcript})

    async def interview_turn(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = f"回覆：{payload['studentText']}"
        return {
            "clientText": text,
            "affect": "reflective",
            "riskSignals": [],
            "revealedFacts": [],
            "stateDelta": {},
            "motionCue": "slow_nod",
            "avatarDirective": {"ttsText": text, "motionCue": "slow_nod"},
        }

    def start_tts_stream(self, _payload: dict[str, Any], event_queue: Any, loop: Any, response_id: str) -> FakeTtsSession:
        events = (
            [{"type": "tts_stream_error", "responseId": response_id, "message": "preview unavailable"}]
            if self.fail_stream
            else [
                {"type": "tts_stream_started", "responseId": response_id, "sampleRate": 24000},
                {"type": "tts_stream_chunk", "responseId": response_id, "sampleRate": 24000, "audioPcmBase64": "AAE="},
                {"type": "tts_stream_chunk", "responseId": response_id, "sampleRate": 24000, "audioPcmBase64": "AgM="},
                {"type": "tts_stream_done", "responseId": response_id},
            ]
        )
        for event in events:
            loop.call_soon(event_queue.put_nowait, event)
        return FakeTtsSession()

    def synthesize_tts(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.standard_calls += 1
        self.standard_texts.append(str(payload.get("text") or ""))
        return {"mimeType": "audio/wav", "audioBase64": "AA==", "provider": "fallback", "voice": "male"}


def receive_until(ws: Any, event_type: str, seen: list[dict[str, Any]]) -> dict[str, Any]:
    while True:
        event = ws.receive_json()
        seen.append(event)
        if event.get("type") == event_type:
            return event


def run_scenario(fake: FakeCoordinator) -> tuple[list[dict[str, Any]], str]:
    seen: list[dict[str, Any]] = []
    with TestClient(service_main.app).websocket_connect("/api/voice-stream") as ws:
        ws.send_json({
            "type": "session.update",
            "protocolVersion": "2",
            "sessionId": "tts-stream-test",
            "caseProfile": {"id": "case", "caseType": "student_depression_bullying"},
            "history": [],
            "sampleRate": 16000,
        })
        receive_until(ws, "listening_ready", seen)
        fake.emit_asr("你好")
        turn = receive_until(ws, "turn_started", seen)
        terminal = "tts_audio" if fake.fail_stream else "tts_audio_done"
        receive_until(ws, terminal, seen)
        return seen, str(turn.get("responseId"))


def main() -> None:
    signal.alarm(15)
    original = service_main.coordinator
    try:
        streaming = FakeCoordinator()
        service_main.coordinator = streaming
        events, response_id = run_scenario(streaming)
        chunks = [event for event in events if event.get("type") == "tts_audio_delta"]
        if len(chunks) != 2 or any(event.get("responseId") != response_id for event in chunks):
            raise AssertionError(f"Streaming chunks lost response identity: {chunks}")
        if streaming.standard_calls != 0:
            raise AssertionError("Healthy streaming unexpectedly called Standard TTS.")

        fallback = FakeCoordinator(fail_stream=True)
        service_main.coordinator = fallback
        fallback_events, fallback_response_id = run_scenario(fallback)
        fallback_audio = [event for event in fallback_events if event.get("type") == "tts_audio"]
        if fallback.standard_calls != 1 or len(fallback_audio) != 1:
            raise AssertionError("Streaming failure must fall back to Standard TTS exactly once.")
        if fallback.standard_texts != ["回覆：你好"]:
            raise AssertionError(f"Fallback used the wrong response payload: {fallback.standard_texts}")
        if fallback_audio[0].get("responseId") != fallback_response_id or not fallback_audio[0].get("streamingFallback"):
            raise AssertionError(f"Fallback audio lost response identity: {fallback_audio}")
        print({"ok": True, "streamingChunks": len(chunks), "standardFallbackCalls": fallback.standard_calls})
    finally:
        service_main.coordinator = original
        signal.alarm(0)


if __name__ == "__main__":
    main()
