from __future__ import annotations

import asyncio
import threading
import os
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
        "simulationMethod": "social_work_default",
        "retrievalOptions": {},
        "ttsVoice": None,
    }

    async def process_final_transcript(transcript: str) -> None:
        if not transcript or transcript == state.get("lastFinal"):
            return
        state["lastFinal"] = transcript
        case_profile = state.get("caseProfile")
        history = state.get("history") if isinstance(state.get("history"), list) else []
        if not isinstance(case_profile, dict):
            await websocket.send_json({"type": "error", "message": "caseProfile is required before ASR final.", "recoverable": True})
            return

        await websocket.send_json({"type": "turn_started", "studentText": transcript})
        payload = {
            "caseProfile": case_profile,
            "studentText": transcript,
            "history": [*history, {"speaker": "student", "text": transcript}],
            "sessionId": state.get("sessionId"),
            "simulationMethod": state.get("simulationMethod"),
            "retrievalOptions": state.get("retrievalOptions"),
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
            tts_response = coordinator.synthesize_tts(
                {
                    "text": text,
                    "affect": response.get("affect"),
                    "voiceStyle": response.get("avatarDirective", {}).get("voiceStyle"),
                    "voice": state.get("ttsVoice"),
                }
            )
            await websocket.send_json({"type": "tts_audio", **tts_response})
        except Exception as exc:
            await websocket.send_json({"type": "error", "message": f"TTS failed: {exc}", "recoverable": True})

    async def forward_speech_events() -> None:
        while True:
            event = await event_queue.get()
            event_type = event.get("type")
            if event_type in {"asr_partial", "asr_final"}:
                await websocket.send_json(event)
                if event_type == "asr_final":
                    await process_final_transcript(str(event.get("transcript", "")).strip())
            elif event_type == "error":
                await websocket.send_json(event)

    event_task = asyncio.create_task(forward_speech_events())
    try:
        while True:
            message = await websocket.receive_json()
            message_type = message.get("type")
            if message_type == "start":
                state["sessionId"] = message.get("sessionId")
                state["caseProfile"] = message.get("caseProfile")
                state["history"] = message.get("history") if isinstance(message.get("history"), list) else []
                state["simulationMethod"] = message.get("simulationMethod") or "social_work_default"
                state["retrievalOptions"] = message.get("retrievalOptions") if isinstance(message.get("retrievalOptions"), dict) else {}
                state["ttsVoice"] = message.get("ttsVoice")
                sample_rate = int(message.get("sampleRate") or 16000)
                if speech_session:
                    speech_session.stop()
                try:
                    speech_session = coordinator.start_speech_stream(sample_rate, event_queue, loop)
                    await websocket.send_json({"type": "voice_ready"})
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
            elif message_type == "stop_utterance":
                if speech_session:
                    speech_session.stop()
                    speech_session = None
            elif message_type == "cancel":
                if speech_session:
                    speech_session.stop()
                    speech_session = None
                await websocket.send_json({"type": "cancelled"})
    except WebSocketDisconnect:
        pass
    finally:
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
