from __future__ import annotations

import asyncio
import threading
import os
import uuid
from pathlib import Path
from typing import Any

from .runtime import SocialWorkCoordinatorAgent, load_local_env

ROOT_DIR = Path(__file__).resolve().parents[1]
load_local_env(ROOT_DIR / ".env.local")
load_local_env(Path(__file__).resolve().parent / ".env")

try:
    from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
except ModuleNotFoundError as exc:  # pragma: no cover - exercised when deps are missing
    raise RuntimeError(
        "Missing ADK service dependencies. Run: "
        "python3 -m venv .venv-adk && "
        ".venv-adk/bin/pip install -r adk_service/requirements.txt"
    ) from exc

app = FastAPI(title="Social Work ADK Service", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

coordinator = SocialWorkCoordinatorAgent(ROOT_DIR)


@app.get("/health")
async def health() -> dict[str, Any]:
    return coordinator.health()


@app.post("/api/shutdown")
async def shutdown_service() -> dict[str, Any]:
    threading.Timer(0.25, lambda: os._exit(0)).start()
    return {"ok": True, "message": "ADK service shutting down."}


@app.post("/api/session/start")
async def start_session(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return coordinator.start_session(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/reset")
async def reset_session(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return coordinator.reset_session(payload)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/export")
async def export_session(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return coordinator.export_session(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/interview-turn")
async def interview_turn(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return await coordinator.interview_turn(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/supervisor-review")
async def supervisor_review(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return await coordinator.supervisor_review(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/session/final-review")
async def final_review(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return await coordinator.final_review(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/evidence-cards")
async def evidence_cards(request: Request) -> dict[str, Any]:
    try:
        return coordinator.list_evidence_cards(dict(request.query_params))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/tts")
async def tts(request: Request) -> dict[str, Any]:
    payload = await request.json()
    try:
        return coordinator.synthesize_tts(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.websocket("/api/voice-stream")
async def voice_stream(websocket: WebSocket) -> None:
    await websocket.accept()
    speech_session = None
    event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    state: dict[str, Any] = {
        "sessionId": None,
        "caseProfile": None,
        "history": [],
        "lastFinal": "",
        "lastProcessedTranscript": "",
        "lastProcessedUtteranceId": "",
        "lastProcessedAt": 0.0,
        "finalSegments": [],
        "latestPartial": "",
        "utteranceSeq": 0,
        "activeUtteranceId": "",
        "streamId": "",
        "bargeInSeq": 0,
        "assistantSpeaking": False,
        "displaySeq": 0,
        "processingTurn": False,
        "simulationMethod": "social_work_default",
        "retrievalOptions": {},
        "responseLanguage": "cantonese",
        "ttsVoice": None,
        "sampleRate": 16000,
        "streamRestartCount": 0,
        "ignoreNextStreamEnded": False,
    }

    async def process_final_transcript(transcript: str, utterance_id: str, reason: str = "final") -> None:
        if not transcript:
            return
        now = asyncio.get_running_loop().time()
        if utterance_id and utterance_id == state.get("lastProcessedUtteranceId"):
            return
        if transcript == state.get("lastProcessedTranscript") and now - float(state.get("lastProcessedAt") or 0) < 3.0:
            return
        if state.get("processingTurn"):
            schedule_turn_processing(0.45, reason)
            return
        state["lastProcessedTranscript"] = transcript
        state["lastProcessedUtteranceId"] = utterance_id
        state["lastProcessedAt"] = now
        state["processingTurn"] = True
        state["assistantSpeaking"] = False
        response_barge_seq = int(state.get("bargeInSeq") or 0)
        case_profile = state.get("caseProfile")
        history = state.get("history") if isinstance(state.get("history"), list) else []
        if not isinstance(case_profile, dict):
            state["processingTurn"] = False
            await websocket.send_json({"type": "error", "message": "caseProfile is required before ASR final.", "recoverable": True})
            return

        try:
            await websocket.send_json({
                "type": "utterance_committed",
                "utteranceId": utterance_id,
                "transcript": transcript,
                "reason": reason,
            })
            await websocket.send_json({"type": "turn_started", "studentText": transcript})
            payload = {
                "caseProfile": case_profile,
                "studentText": transcript,
                "history": [*history, {"speaker": "student", "text": transcript}],
                "sessionId": state.get("sessionId"),
                "simulationMethod": state.get("simulationMethod"),
                "retrievalOptions": state.get("retrievalOptions"),
                "responseLanguage": state.get("responseLanguage"),
            }
            response = await coordinator.interview_turn(payload)
            await websocket.send_json({"type": "client_response", "response": response})
            if response.get("avatarDirective"):
                await websocket.send_json({"type": "avatar_directive", "avatarDirective": response["avatarDirective"]})

            state["history"] = [
                *history,
                {"speaker": "student", "text": transcript},
                {"speaker": "client", "text": response.get("clientText", ""), "revealedFacts": response.get("revealedFacts", [])},
            ]
            state["caseProfile"] = coordinator.case_state.apply_response(case_profile, response)

            text = response.get("avatarDirective", {}).get("ttsText") or response.get("clientText")
            try:
                if response_barge_seq != int(state.get("bargeInSeq") or 0):
                    await websocket.send_json({"type": "avatar_speech_cancelled"})
                    return
                tts_response = coordinator.synthesize_tts(
                    {
                        "text": text,
                        "affect": response.get("affect"),
                        "voiceStyle": response.get("avatarDirective", {}).get("voiceStyle"),
                        "voice": state.get("ttsVoice") if state.get("responseLanguage") != "english" else None,
                        "language": state.get("responseLanguage"),
                    }
                )
                if response_barge_seq != int(state.get("bargeInSeq") or 0):
                    await websocket.send_json({"type": "avatar_speech_cancelled"})
                    return
                state["assistantSpeaking"] = True
                await websocket.send_json({"type": "tts_audio", **tts_response})
            except Exception as exc:
                await websocket.send_json({"type": "error", "message": f"TTS failed: {exc}", "recoverable": True})
        finally:
            state["processingTurn"] = False
            if buffered_transcript_for_submit():
                schedule_turn_processing(0.25, "queued")

    def normalized_final_transcript() -> str:
        segments = [str(item).strip() for item in state.get("finalSegments", []) if str(item).strip()]
        if not segments:
            return ""
        return " ".join(segments).strip()

    def buffered_transcript_for_display() -> str:
        final_text = normalized_final_transcript()
        if final_text:
            return final_text
        return str(state.get("latestPartial", "")).strip()

    def buffered_transcript_for_submit() -> str:
        final_text = normalized_final_transcript()
        if final_text:
            return final_text
        return str(state.get("latestPartial", "")).strip()

    def next_display_seq() -> int:
        state["displaySeq"] = int(state.get("displaySeq") or 0) + 1
        return int(state["displaySeq"])

    def next_utterance_id() -> str:
        state["utteranceSeq"] = int(state.get("utteranceSeq") or 0) + 1
        state["activeUtteranceId"] = f"utt-{state['utteranceSeq']}"
        return str(state["activeUtteranceId"])

    def append_final_segment(transcript: str) -> None:
        segment = transcript.strip()
        if not segment:
            return
        segments = [str(item).strip() for item in state.get("finalSegments", []) if str(item).strip()]
        joined = " ".join(segments).strip()
        if joined and segment.startswith(joined):
            state["finalSegments"] = [segment]
        elif not joined or (segment not in joined and (not segments or segment != segments[-1])):
            state["finalSegments"] = [*segments, segment]
        state["latestPartial"] = ""

    async def process_buffered_utterance(reason: str = "final") -> bool:
        transcript = buffered_transcript_for_submit()
        utterance_id = str(state.get("activeUtteranceId") or next_utterance_id())
        state["finalSegments"] = []
        state["latestPartial"] = ""
        state["activeUtteranceId"] = ""
        if not transcript:
            return False
        await websocket.send_json({
            "type": "asr_final",
            "transcript": transcript,
            "utteranceSeq": next_display_seq(),
            "utteranceId": utterance_id,
        })
        await process_final_transcript(transcript, utterance_id, reason)
        return True

    turn_task: asyncio.Task | None = None

    def cancel_turn_task() -> None:
        nonlocal turn_task
        if turn_task and not turn_task.done():
            turn_task.cancel()
        turn_task = None

    def schedule_turn_processing(delay: float = 1.15, reason: str = "final") -> None:
        nonlocal turn_task
        cancel_turn_task()
        token = str(state.get("activeUtteranceId") or next_utterance_id())

        async def run_when_stable() -> None:
            try:
                await asyncio.sleep(delay)
                if token == state.get("activeUtteranceId"):
                    await process_buffered_utterance(reason)
            except asyncio.CancelledError:
                return

        turn_task = asyncio.create_task(run_when_stable())

    async def restart_speech_stream_once(reason: str = "ended") -> None:
        nonlocal speech_session
        max_restarts = 6 if reason == "ended" else 2
        if int(state.get("streamRestartCount") or 0) >= max_restarts:
            return
        state["streamRestartCount"] = int(state.get("streamRestartCount") or 0) + 1
        if reason == "error":
            state["ignoreNextStreamEnded"] = True
        if speech_session:
            speech_session.stop()
            speech_session = None
        try:
            speech_session = coordinator.start_speech_stream(int(state.get("sampleRate") or 16000), event_queue, loop)
            state["streamId"] = f"stream-{uuid.uuid4().hex[:12]}"
            await websocket.send_json({"type": "listening_ready", "streamId": state["streamId"]})
        except Exception as exc:
            await websocket.send_json({"type": "error", "message": str(exc), "recoverable": True})

    async def forward_speech_events() -> None:
        while True:
            event = await event_queue.get()
            event_type = event.get("type")
            if event_type == "asr_partial":
                if normalized_final_transcript():
                    continue
                cancel_turn_task()
                is_new_utterance = not state.get("activeUtteranceId")
                utterance_id = str(state.get("activeUtteranceId") or next_utterance_id())
                state["latestPartial"] = str(event.get("transcript", "")).strip()
                if is_new_utterance:
                    await websocket.send_json({"type": "speech_started", "utteranceId": utterance_id})
                await websocket.send_json({
                    "type": "asr_partial",
                    "transcript": buffered_transcript_for_display(),
                    "utteranceSeq": next_display_seq(),
                    "utteranceId": utterance_id,
                })
                if len(state["latestPartial"]) >= 2:
                    schedule_turn_processing(0.95, "silence")
            elif event_type == "asr_final":
                utterance_id = str(state.get("activeUtteranceId") or next_utterance_id())
                append_final_segment(str(event.get("transcript", "")))
                await websocket.send_json({
                    "type": "asr_partial",
                    "transcript": buffered_transcript_for_display(),
                    "utteranceSeq": next_display_seq(),
                    "utteranceId": utterance_id,
                })
                schedule_turn_processing(1.15, "final")
            elif event_type == "error":
                await websocket.send_json(event)
                await restart_speech_stream_once("error")
            elif event_type == "stream_ended":
                if state.get("ignoreNextStreamEnded"):
                    state["ignoreNextStreamEnded"] = False
                    continue
                await restart_speech_stream_once("ended")

    event_task = asyncio.create_task(forward_speech_events())
    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            if message_type == "start":
                state["sessionId"] = message.get("sessionId")
                state["caseProfile"] = message.get("caseProfile")
                state["history"] = message.get("history") if isinstance(message.get("history"), list) else []
                state["lastProcessedTranscript"] = ""
                state["lastProcessedUtteranceId"] = ""
                state["lastProcessedAt"] = 0.0
                state["finalSegments"] = []
                state["latestPartial"] = ""
                state["utteranceSeq"] = 0
                state["activeUtteranceId"] = ""
                state["streamId"] = f"stream-{uuid.uuid4().hex[:12]}"
                state["bargeInSeq"] = 0
                state["assistantSpeaking"] = False
                state["displaySeq"] = 0
                state["processingTurn"] = False
                state["simulationMethod"] = message.get("simulationMethod") or "social_work_default"
                state["retrievalOptions"] = message.get("retrievalOptions") if isinstance(message.get("retrievalOptions"), dict) else {}
                state["responseLanguage"] = "english" if message.get("responseLanguage") == "english" else "cantonese"
                state["ttsVoice"] = message.get("ttsVoice")
                sample_rate = int(message.get("sampleRate") or 16000)
                state["sampleRate"] = sample_rate
                state["streamRestartCount"] = 0
                state["ignoreNextStreamEnded"] = False
                if speech_session:
                    speech_session.stop()
                try:
                    speech_session = coordinator.start_speech_stream(sample_rate, event_queue, loop)
                    await websocket.send_json({"type": "voice_ready"})
                    await websocket.send_json({"type": "listening_ready", "streamId": state["streamId"]})
                except Exception as exc:
                    await websocket.send_json({"type": "error", "message": str(exc), "recoverable": True})
            elif message_type == "audio":
                if speech_session:
                    audio_base64 = message.get("audioBase64")
                    if isinstance(audio_base64, str) and audio_base64:
                        import base64

                        speech_session.send_audio(base64.b64decode(audio_base64))
            elif message_type == "retrieval_options":
                state["retrievalOptions"] = message.get("retrievalOptions") if isinstance(message.get("retrievalOptions"), dict) else {}
            elif message_type == "response_language":
                state["responseLanguage"] = "english" if message.get("responseLanguage") == "english" else "cantonese"
            elif message_type == "stop_utterance":
                cancel_turn_task()
                if not await process_buffered_utterance("manual"):
                    await websocket.send_json({"type": "listening_ready", "streamId": state.get("streamId")})
            elif message_type == "commit_utterance":
                cancel_turn_task()
                reason = message.get("reason") if isinstance(message.get("reason"), str) else "manual"
                if not await process_buffered_utterance(reason):
                    await websocket.send_json({"type": "listening_ready", "streamId": state.get("streamId")})
            elif message_type == "barge_in":
                state["bargeInSeq"] = int(state.get("bargeInSeq") or 0) + 1
                state["assistantSpeaking"] = False
                await websocket.send_json({"type": "barge_in_ack", "previousResponseId": message.get("utteranceId")})
            elif message_type == "cancel_avatar_speech":
                state["assistantSpeaking"] = False
                await websocket.send_json({"type": "avatar_speech_cancelled"})
            elif message_type == "cancel":
                if speech_session:
                    speech_session.stop()
                    speech_session = None
                await websocket.send_json({"type": "cancelled"})
    except WebSocketDisconnect:
        pass
    finally:
        cancel_turn_task()
        if speech_session:
            speech_session.stop()
        event_task.cancel()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "adk_service.main:app",
        host="127.0.0.1",
        port=int(os.environ.get("ADK_SERVICE_PORT", "8765")),
        reload=False,
    )
