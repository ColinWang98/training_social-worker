from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import threading
import os
import time
import uuid
import logging
from pathlib import Path
from typing import Any

from .runtime import SocialWorkCoordinatorAgent, load_local_env
from .voice_turns import VoiceTurnManager
from .case_registry import PROFILES, case_view, client_view, session_view, trainee_report_view
from .session_authority import SessionError

ROOT_DIR = Path(__file__).resolve().parents[1]
load_local_env(ROOT_DIR / ".env.local")
load_local_env(Path(__file__).resolve().parent / ".env")

try:
    from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
    from fastapi.middleware.cors import CORSMiddleware
except ModuleNotFoundError as exc:  # pragma: no cover - exercised when deps are missing
    raise RuntimeError(
        "Missing ADK service dependencies. Run: "
        "python3.11 -m venv .venv-adk && "
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


def identity(connection):
    headers = getattr(connection, 'headers', {})
    return {'_role': headers.get('x-app-role', 'trainee'),
            '_owner': headers.get('x-app-subject', 'anonymous')}


async def trusted_payload(request):
    return {**await request.json(), **identity(request)}


@app.get('/api/cases')
async def cases(request: Request):
    return {'cases': [case_view(case, identity(request)['_role']) for case in PROFILES]}


@app.get('/live')
async def live():
    return {'ok': True}


@app.get('/ready')
async def ready():
    health = coordinator.health()
    return {'ok': health['ok'], 'providers': 'configured_not_call_verified',
            'corpusBackend': health['corpusBackend'], 'voiceProtocolVersion': health['voiceProtocolVersion']}


@app.get("/health")
async def health() -> dict[str, Any]:
    return coordinator.health()


@app.post("/api/shutdown")
async def shutdown_service() -> dict[str, Any]:
    threading.Timer(0.25, lambda: os._exit(0)).start()
    return {"ok": True, "message": "ADK service shutting down."}


@app.post("/api/session/start")
async def start_session(request: Request) -> dict[str, Any]:
    payload = await trusted_payload(request)
    try:
        return coordinator.start_session(payload)
    except SessionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/reset")
async def reset_session(request: Request) -> dict[str, Any]:
    payload = await trusted_payload(request)
    try:
        return coordinator.reset_session(payload)
    except SessionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/session/export")
async def export_session(request: Request) -> dict[str, Any]:
    if identity(request)['_role'] != 'instructor':
        raise HTTPException(status_code=403, detail='instructor_required')
    payload = await trusted_payload(request)
    try:
        from .reaction_planning import public_projection
        return public_projection(coordinator.export_session(payload), request.headers.get("x-app-role", "trainee"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/interview-turn")
async def interview_turn(request: Request) -> dict[str, Any]:
    payload = await trusted_payload(request)
    try:
        return client_view(await coordinator.interview_turn(payload), identity(request)['_role'])
    except SessionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/supervisor-review")
async def supervisor_review(request: Request) -> dict[str, Any]:
    if identity(request)['_role'] != 'instructor':
        raise HTTPException(status_code=403, detail='instructor_required')
    payload = await trusted_payload(request)
    try:
        return await coordinator.supervisor_review(payload)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/session/final-review")
async def final_review(request: Request) -> dict[str, Any]:
    payload = await trusted_payload(request)
    try:
        report = await coordinator.final_review(payload)
        if identity(request)['_role'] == 'instructor':
            return report
        return trainee_report_view(report)
    except SessionError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.code) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/api/evidence-cards")
async def evidence_cards(request: Request) -> dict[str, Any]:
    if identity(request)['_role'] != 'instructor':
        raise HTTPException(status_code=403, detail='instructor_required')
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
    tts_session = None
    event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    restart_lock = asyncio.Lock()
    turn_manager = VoiceTurnManager()
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
        "queuedUtterances": [],
        "voiceStartedAt": 0.0,
        "protocolVersion": "1",
        "eventSequence": 0,
        "activeResponseId": "",
        "responseCommitted": False,
        "cancelledResponseIds": set(),
        "ttsFallbackResponseIds": set(),
        "ttsPayloads": {},
        "ttsSessions": {},
        "recentAudio": [],
        "recentAudioBytes": 0,
        "streamErrorCount": 0,
        "streamRecoveryExhausted": False,
        "lastRecognitionWasFinal": True,
        "recognitionEndMs": 0,
        "committedRecognitionEndMs": 0,
    }

    def envelope(event: dict[str, Any], realtime_type: str | None = None) -> dict[str, Any]:
        started_at = float(state.get("voiceStartedAt") or 0)
        state["eventSequence"] = int(state.get("eventSequence") or 0) + 1
        return {
            **event,
            "eventId": f"evt-{uuid.uuid4().hex[:16]}",
            "sessionId": state.get("sessionId"),
            "streamId": state.get("streamId"),
            "sequence": int(state["eventSequence"]),
            "serverTimeMs": int(time.time() * 1000),
            "serverElapsedMs": int(max(0, (loop.time() - started_at) * 1000)) if started_at else 0,
            "streamRestartCount": int(state.get("streamRestartCount") or 0),
            "protocolVersion": str(state.get("protocolVersion") or "1"),
            **({"realtimeType": realtime_type} if realtime_type else {}),
        }

    async def send_event(event: dict[str, Any], realtime_type: str | None = None) -> None:
        role = identity(websocket)['_role']
        if 'response' in event:
            event = {**event, 'response': client_view(event['response'], role)}
        if 'avatarDirective' in event and role != 'instructor':
            event = {**event, 'avatarDirective': client_view({'avatarDirective': event['avatarDirective']}, role)['avatarDirective']}
        if event.get("type") in {"utterance_committed", "audio_gap", "recovery_status", "response_cancelled"}:
            logging.getLogger("uvicorn.error").info("voice_event type=%s stream=%s utterance=%s response=%s reason=%s", event.get("type"), state.get("streamId"), event.get("utteranceId"), event.get("responseId"), event.get("reason"))
        async with send_lock:
            await websocket.send_json(envelope(event, realtime_type))

    def queue_utterance(transcript: str, utterance_id: str, reason: str) -> None:
        queued = state.get("queuedUtterances")
        if not isinstance(queued, list):
            queued = []
        if any(item.get("utteranceId") == utterance_id for item in queued):
            return
        queued.append({"transcript": transcript, "utteranceId": utterance_id, "reason": reason})
        state["queuedUtterances"] = queued[-5:]

    def remember_recent_audio(audio_bytes: bytes) -> None:
        recent_audio = [*state.get("recentAudio", []), audio_bytes]
        recent_size = int(state.get("recentAudioBytes") or 0) + len(audio_bytes)
        max_recent = int(state.get("sampleRate") or 16000)
        while recent_audio and recent_size > max_recent:
            recent_size -= len(recent_audio.pop(0))
        state["recentAudio"] = recent_audio
        state["recentAudioBytes"] = recent_size

    async def process_final_transcript(transcript: str, utterance_id: str, reason: str = "final") -> None:
        nonlocal tts_session, response_task
        if not transcript:
            return
        now = asyncio.get_running_loop().time()
        if utterance_id and utterance_id == state.get("lastProcessedUtteranceId"):
            return
        if state.get("processingTurn"):
            queue_utterance(transcript, utterance_id, reason)
            return
        state["lastProcessedTranscript"] = transcript
        state["lastProcessedUtteranceId"] = utterance_id
        state["lastProcessedAt"] = now
        state["processingTurn"] = True
        state["assistantSpeaking"] = False
        response_id = f"resp-{uuid.uuid4().hex[:16]}"
        state["activeResponseId"] = response_id
        state["responseCommitted"] = False
        response_barge_seq = int(state.get("bargeInSeq") or 0)
        case_profile = state.get("caseProfile")
        history = state.get("history") if isinstance(state.get("history"), list) else []
        if not isinstance(case_profile, dict):
            state["processingTurn"] = False
            await send_event({"type": "error", "message": "caseProfile is required before ASR final.", "recoverable": True})
            return

        try:
            await send_event({
                "type": "utterance_committed",
                "utteranceId": utterance_id,
                "transcript": transcript,
                "reason": reason,
            }, "input_audio_buffer.committed")
            await send_event({
                "type": "turn_started",
                "studentText": transcript,
                "utteranceId": utterance_id,
                "responseId": response_id,
            }, "response.created")
            payload = {
                **identity(websocket),
                'turnId': utterance_id,
                'responseId': response_id,
                "caseProfile": case_profile,
                "studentText": transcript,
                "history": [*history, {"speaker": "student", "text": transcript}],
                "sessionId": state.get("sessionId"),
                "simulationMethod": state.get("simulationMethod"),
                "retrievalOptions": state.get("retrievalOptions"),
                "responseLanguage": state.get("responseLanguage"),
            }
            response = await coordinator.interview_turn(payload)
            if response_id in state["cancelledResponseIds"]:
                return
            state["responseCommitted"] = True
            await send_event({
                "type": "client_response",
                "response": response,
                "utteranceId": utterance_id,
                "responseId": response_id,
                "deliveryStatus": "completed",
            }, "response.client_text.done")
            if response.get("avatarDirective"):
                await send_event({
                    "type": "avatar_directive",
                    "avatarDirective": response["avatarDirective"],
                    "utteranceId": utterance_id,
                    "responseId": response_id,
                })

            state["history"] = [
                *history,
                {"speaker": "student", "text": transcript},
                {"speaker": "client", "text": response.get("clientText", ""), "revealedFacts": response.get("revealedFacts", [])},
            ]
            state["caseProfile"] = response.get('sessionView', case_profile)

            text = response.get("avatarDirective", {}).get("ttsText") or response.get("clientText")
            try:
                if response_barge_seq != int(state.get("bargeInSeq") or 0):
                    await send_event({"type": "avatar_speech_cancelled", "responseId": response_id, "deliveryStatus": "interrupted"}, "response.cancelled")
                    return
                tts_payload = {
                    "text": text,
                    "affect": response.get("affect"),
                    "voiceStyle": response.get("avatarDirective", {}).get("voiceStyle"),
                    "voice": state.get("ttsVoice") if state.get("responseLanguage") != "english" else None,
                    "language": state.get("responseLanguage"),
                }
                state["ttsPayloads"][response_id] = tts_payload
                voice_service = getattr(coordinator, "voice_synthesis", None)
                streaming_capability = getattr(voice_service, "streaming_capability", lambda: {"available": False})()
                if streaming_capability.get("available") and hasattr(coordinator, "start_tts_stream"):
                    tts_session = coordinator.start_tts_stream(tts_payload, event_queue, loop, response_id)
                    state["ttsSessions"][response_id] = tts_session
                    state["assistantSpeaking"] = True
                    return
                tts_response = await asyncio.to_thread(coordinator.synthesize_tts, tts_payload)
                if response_barge_seq != int(state.get("bargeInSeq") or 0):
                    await send_event({"type": "avatar_speech_cancelled", "responseId": response_id, "deliveryStatus": "interrupted"}, "response.cancelled")
                    return
                state["assistantSpeaking"] = True
                await send_event({"type": "tts_audio", "responseId": response_id, **tts_response}, "response.output_audio.done")
                await send_event({"type": "response_done", "responseId": response_id, "deliveryStatus": "completed"}, "response.done")
            except Exception as exc:
                await send_event({"type": "error", "responseId": response_id, "message": f"TTS failed: {exc}", "recoverable": True})
        except asyncio.CancelledError:
            state["cancelledResponseIds"].add(response_id)
            with contextlib.suppress(Exception):
                await send_event({
                    "type": "response_cancelled",
                    "responseId": response_id,
                    "utteranceId": utterance_id,
                    "deliveryStatus": "interrupted" if state.get("responseCommitted") else "cancelled",
                }, "response.cancelled")
            raise
        except Exception as exc:
            await send_event({"type": "error", "responseId": response_id, "utteranceId": utterance_id,
                              "message": str(exc), "recoverable": True})
        finally:
            owns_pipeline = response_task is asyncio.current_task() or response_task is None
            if owns_pipeline:
                state["processingTurn"] = False
            if response_task is asyncio.current_task():
                response_task = None
            queued = state.get("queuedUtterances") if isinstance(state.get("queuedUtterances"), list) else []
            if queued and owns_pipeline:
                next_item = queued.pop(0)
                state["queuedUtterances"] = queued
                start_response_task(
                    str(next_item.get("transcript", "")),
                    str(next_item.get("utteranceId", "")),
                    str(next_item.get("reason", "queued")),
                )

    def next_display_seq() -> int:
        state["displaySeq"] = int(state.get("displaySeq") or 0) + 1
        return int(state["displaySeq"])

    async def process_buffered_utterance(reason: str = "final") -> bool:
        committed = turn_manager.commit(loop.time(), manual=reason in {"manual", "duration_rotation"})
        state["activeUtteranceId"] = ""
        if not committed:
            await send_event({"type": "listening_ready", "commitAcknowledgement": "empty"})
            return False
        transcript = committed["transcript"]
        utterance_id = committed["utteranceId"]
        if committed["partial"] or reason == "duration_rotation":
            await restart_speech_stream_once("partial_commit")
        await send_event({
            "type": "asr_final",
            "transcript": transcript,
            "utteranceSeq": next_display_seq(),
            "utteranceId": utterance_id,
            "commitAcknowledgement": "accepted",
            "streamEpoch": committed["streamEpoch"],
            "audioEndMs": committed["audioEndMs"],
        }, "transcription.completed")
        start_response_task(transcript, utterance_id, reason)
        return True

    turn_task: asyncio.Task | None = None
    response_task: asyncio.Task | None = None
    proactive_restart_task: asyncio.Task | None = None

    def cancel_turn_task() -> None:
        nonlocal turn_task
        if turn_task and not turn_task.done():
            turn_task.cancel()
        turn_task = None

    def start_response_task(transcript: str, utterance_id: str, reason: str) -> None:
        nonlocal response_task
        if response_task and not response_task.done():
            queue_utterance(transcript, utterance_id, reason)
            return
        response_task = asyncio.create_task(process_final_transcript(transcript, utterance_id, reason))

    def cancel_active_response() -> str | None:
        nonlocal response_task, tts_session
        response_id = str(state.get("activeResponseId") or "") or None
        if response_id:
            state["cancelledResponseIds"].add(response_id)
        if response_task and not response_task.done():
            response_task.cancel()
        response_task = None
        active_tts_session = state.get("ttsSessions", {}).pop(response_id, None) if response_id else None
        if active_tts_session:
            active_tts_session.stop()
        if tts_session is active_tts_session:
            tts_session = None
        if response_id:
            state.get("ttsPayloads", {}).pop(response_id, None)
        return response_id

    def schedule_turn_processing(delay: float = 1.15, reason: str = "final") -> None:
        nonlocal turn_task
        cancel_turn_task()
        token = turn_manager.utterance_id

        async def run_when_stable() -> None:
            nonlocal turn_task
            try:
                await asyncio.sleep(delay)
                if token == turn_manager.utterance_id:
                    turn_task = None
                    await process_buffered_utterance(reason)
            except asyncio.CancelledError:
                return

        turn_task = asyncio.create_task(run_when_stable())

    async def restart_speech_stream_once(reason: str = "ended") -> None:
        async with restart_lock:
            await restart_speech_stream(reason)

    async def restart_speech_stream(reason: str) -> None:
        nonlocal speech_session, proactive_restart_task
        if state["streamRecoveryExhausted"]:
            return
        if reason == "error":
            state["streamErrorCount"] = int(state.get("streamErrorCount") or 0) + 1
            if int(state["streamErrorCount"]) > 3:
                state["streamRecoveryExhausted"] = True
                if speech_session:
                    speech_session.stop()
                    speech_session = None
                await send_event({"type": "error", "message": "Google STT stream could not be recovered.", "recoverable": False})
                return
            await send_event({"type": "recovery_status", "status": "recovering", "attempt": state["streamErrorCount"]})
            await asyncio.sleep(0.5 * (2 ** (int(state["streamErrorCount"]) - 1)))
        state["streamRestartCount"] = int(state.get("streamRestartCount") or 0) + 1
        if speech_session:
            if reason in {"partial_commit", "duration_rotation"} and hasattr(speech_session, "finish"):
                speech_session.finish()
                loop.call_later(2, speech_session.stop)
            else:
                speech_session.stop()
            speech_session = None
        try:
            state["streamId"] = f"stream-{uuid.uuid4().hex[:12]}"
            turn_manager.rotate(state["streamId"])
            state["stableAudioSince"] = 0
            try:
                speech_session = coordinator.start_speech_stream(int(state.get("sampleRate") or 16000), event_queue, loop, state["streamId"], "en-US" if state.get("responseLanguage") == "english" else "yue-Hant-HK")
            except TypeError:
                speech_session = coordinator.start_speech_stream(int(state.get("sampleRate") or 16000), event_queue, loop)
            # Replaying a tail without Google's confirmed audio offset can submit it twice.
            state["recentAudio"] = []
            state["recentAudioBytes"] = 0
            state["recognitionEndMs"] = 0
            state["committedRecognitionEndMs"] = 0
            await send_event({"type": "listening_ready", "streamId": state["streamId"], "restartReason": reason}, "session.updated")
            if (
                proactive_restart_task
                and proactive_restart_task is not asyncio.current_task()
                and not proactive_restart_task.done()
            ):
                proactive_restart_task.cancel()
            proactive_restart_task = asyncio.create_task(proactive_stream_restart())
        except Exception as exc:
            event_queue.put_nowait({"type": "error", "message": str(exc), "speechStreamId": state["streamId"], "recoverable": True})

    async def proactive_stream_restart() -> None:
        try:
            await asyncio.sleep(270)
            deadline = loop.time() + 15
            while turn_manager.utterance_id and loop.time() < deadline:
                await asyncio.sleep(0.25)
            if turn_manager.utterance_id:
                await process_buffered_utterance("duration_rotation")
            else:
                await restart_speech_stream_once("duration_rotation")
        except asyncio.CancelledError:
            return

    async def fallback_standard_tts(response_id: str) -> None:
        if response_id in state["cancelledResponseIds"] or response_id in state["ttsFallbackResponseIds"]:
            return
        payload = state.get("ttsPayloads", {}).get(response_id)
        if not isinstance(payload, dict):
            return
        state["ttsFallbackResponseIds"].add(response_id)
        try:
            tts_response = await asyncio.to_thread(coordinator.synthesize_tts, payload)
            if response_id not in state["cancelledResponseIds"]:
                state["assistantSpeaking"] = True
                await send_event({"type": "tts_audio", "responseId": response_id, "streamingFallback": True, **tts_response}, "response.output_audio.done")
                await send_event({"type": "response_done", "responseId": response_id, "deliveryStatus": "completed"}, "response.done")
        except Exception as exc:
            await send_event({"type": "error", "responseId": response_id, "message": f"TTS failed: {exc}", "recoverable": True})

    async def forward_speech_events() -> None:
        nonlocal tts_session
        while True:
            event = await event_queue.get()
            event_type = event.get("type")
            speech_stream_id = event.get("speechStreamId")
            if speech_stream_id and speech_stream_id != state.get("streamId"):
                if event_type in {"asr_partial", "asr_final"}:
                    turn_manager.late_results += 1
                continue
            if event_type in {"asr_partial", "asr_final"}:
                is_new_utterance = not turn_manager.utterance_id
                if not turn_manager.receive(event, loop.time()):
                    continue
                utterance_id = turn_manager.utterance_id
                state["activeUtteranceId"] = utterance_id
                if is_new_utterance:
                    await send_event({"type": "speech_started", "utteranceId": utterance_id}, "input_audio_buffer.speech_started")
                await send_event({
                    "type": "asr_partial",
                    "transcript": turn_manager.text,
                    "utteranceSeq": next_display_seq(),
                    "utteranceId": utterance_id,
                    **turn_manager.debug(),
                }, "transcription.delta")
                if turn_manager.deadline is not None:
                    schedule_turn_processing(max(0, turn_manager.deadline - loop.time()), "final" if turn_manager.is_final else "silence")
            elif event_type == "audio_gap":
                if speech_session:
                    speech_session.stop()
                state["capturePaused"] = True
                cancel_turn_task()
                await send_event({**event, **turn_manager.debug()})
            elif event_type == "error":
                await send_event(event)
                await restart_speech_stream_once("error")
            elif event_type == "stream_ended":
                if not state.get("capturePaused"):
                    await restart_speech_stream_once("error")
            elif event_type == "tts_stream_started":
                if event.get("responseId") not in state["cancelledResponseIds"]:
                    await send_event({**event, "type": "tts_stream_started", "streaming": True}, "response.output_audio.delta")
            elif event_type == "tts_stream_chunk":
                if event.get("responseId") not in state["cancelledResponseIds"]:
                    await send_event({**event, "type": "tts_audio_delta", "streaming": True}, "response.output_audio.delta")
            elif event_type == "tts_stream_done":
                response_id = str(event.get("responseId") or "")
                state.get("ttsSessions", {}).pop(response_id, None)
                state.get("ttsPayloads", {}).pop(response_id, None)
                if response_id in state["cancelledResponseIds"]:
                    continue
                state["assistantSpeaking"] = False
                tts_session = None
                await send_event({"type": "tts_audio_done", "responseId": response_id, "streaming": True}, "response.output_audio.done")
                await send_event({"type": "response_done", "responseId": response_id, "deliveryStatus": "completed"}, "response.done")
            elif event_type == "tts_stream_cancelled":
                response_id = str(event.get("responseId") or "")
                state.get("ttsSessions", {}).pop(response_id, None)
                state.get("ttsPayloads", {}).pop(response_id, None)
                tts_session = None
                if response_id not in state["cancelledResponseIds"]:
                    await send_event({"type": "response_cancelled", "responseId": response_id, "deliveryStatus": "interrupted"}, "response.cancelled")
            elif event_type == "tts_stream_error":
                response_id = str(event.get("responseId") or "")
                state.get("ttsSessions", {}).pop(response_id, None)
                tts_session = None
                if response_id not in state["cancelledResponseIds"]:
                    await fallback_standard_tts(response_id)

    event_task = asyncio.create_task(forward_speech_events())

    async def accept_audio(audio_bytes):
        if not audio_bytes or state.get("streamRecoveryExhausted"):
            return
        if state.get("capturePaused"):
            state["capturePaused"] = False
            await restart_speech_stream_once("audio_resumed")
        if speech_session:
            speech_session.send_audio(audio_bytes)
            now = loop.time()
            if now - float(state.get("lastRealAudioAt") or 0) > 0.5:
                state["stableAudioSince"] = now
            state["lastRealAudioAt"] = now
            if now - float(state.get("stableAudioSince") or now) >= 10:
                state["streamErrorCount"] = 0

    try:
        while True:
            packet = await websocket.receive()
            if packet.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            audio_bytes = packet.get("bytes")
            if isinstance(audio_bytes, bytes):
                await accept_audio(audio_bytes)
                continue
            message_text = packet.get("text")
            if not isinstance(message_text, str):
                continue
            try:
                message = json.loads(message_text)
            except json.JSONDecodeError:
                await send_event({"type": "error", "message": "Invalid voice event JSON.", "recoverable": True})
                continue
            message_type = message.get("type")
            if message_type in {"start", "session.update"}:
                for active_tts_session in list(state.get("ttsSessions", {}).values()):
                    active_tts_session.stop()
                if hasattr(coordinator, 'authority'):
                    session = coordinator.authority.read(message.get('sessionId'), identity(websocket)['_owner'])
                    state['sessionId'] = session['sessionId']
                    state['caseProfile'] = session['caseProfile']
                    state['history'] = session['history']
                else:
                    state['sessionId'] = message.get('sessionId')
                    state['caseProfile'] = message.get('caseProfile')
                    state['history'] = message.get('history', [])
                state["lastProcessedTranscript"] = ""
                state["lastProcessedUtteranceId"] = ""
                state["lastProcessedAt"] = 0.0
                state["finalSegments"] = []
                state["latestPartial"] = ""
                state["utteranceSeq"] = 0
                state["activeUtteranceId"] = ""
                state["streamId"] = f"stream-{uuid.uuid4().hex[:12]}"
                turn_manager.rotate(state["streamId"])
                state["capturePaused"] = False
                state["streamRecoveryExhausted"] = False
                state["bargeInSeq"] = 0
                state["assistantSpeaking"] = False
                state["displaySeq"] = 0
                state["processingTurn"] = False
                state["activeResponseId"] = None
                state["responseCommitted"] = False
                state["simulationMethod"] = message.get("simulationMethod") or "social_work_default"
                state["retrievalOptions"] = message.get("retrievalOptions") if isinstance(message.get("retrievalOptions"), dict) else {}
                state["responseLanguage"] = "english" if message.get("responseLanguage") == "english" else "cantonese"
                state["ttsVoice"] = message.get("ttsVoice")
                sample_rate = int(message.get("sampleRate") or 16000)
                state["sampleRate"] = sample_rate
                state["streamRestartCount"] = 0
                state["ignoreNextStreamEnded"] = False
                state["queuedUtterances"] = []
                state["voiceStartedAt"] = asyncio.get_running_loop().time()
                state["protocolVersion"] = str(message.get("protocolVersion") or "1")
                state["eventSequence"] = 0
                state["cancelledResponseIds"] = set()
                state["ttsFallbackResponseIds"] = set()
                state["ttsPayloads"] = {}
                state["ttsSessions"] = {}
                state["recentAudio"] = []
                state["recentAudioBytes"] = 0
                state["streamErrorCount"] = 0
                if speech_session:
                    speech_session.stop()
                try:
                    try:
                        speech_session = coordinator.start_speech_stream(sample_rate, event_queue, loop, state["streamId"], "en-US" if state.get("responseLanguage") == "english" else "yue-Hant-HK")
                    except TypeError:
                        speech_session = coordinator.start_speech_stream(sample_rate, event_queue, loop)
                    await send_event({"type": "voice_ready"}, "session.created")
                    await send_event({"type": "listening_ready", "streamId": state["streamId"]}, "session.updated")
                    proactive_restart_task = asyncio.create_task(proactive_stream_restart())
                except Exception as exc:
                    await send_event({"type": "error", "message": str(exc), "recoverable": True})
            elif message_type == "audio":
                if speech_session:
                    audio_base64 = message.get("audioBase64")
                    if isinstance(audio_base64, str) and audio_base64:
                        try:
                            decoded_audio = base64.b64decode(audio_base64, validate=True)
                        except (binascii.Error, ValueError, TypeError):
                            await send_event({"type": "error", "message": "Invalid base64 audio frame.", "recoverable": True})
                            continue
                        await accept_audio(decoded_audio)
            elif message_type == "speech_start":
                turn_manager.speech_start()
                cancel_turn_task()
            elif message_type == "speech_end":
                turn_manager.speech_end(loop.time())
                schedule_turn_processing(0.9, "vad_end")
            elif message_type == "capture_status":
                capture = message.get("capture") if isinstance(message.get("capture"), dict) else {}
                await send_event({"type": "capture_status", "capture": {
                    **capture, **getattr(speech_session, "stats", {}),
                    "lastReceivedAgeMs": round((loop.time() - state["lastRealAudioAt"]) * 1000) if state.get("lastRealAudioAt") else None,
                }, **turn_manager.debug()})
            elif message_type == "retrieval_options":
                state["retrievalOptions"] = message.get("retrievalOptions") if isinstance(message.get("retrievalOptions"), dict) else {}
            elif message_type == "response_language":
                state["responseLanguage"] = "english" if message.get("responseLanguage") == "english" else "cantonese"
                cancel_turn_task()
                await restart_speech_stream_once("language_changed")
            elif message_type == "stop_utterance":
                cancel_turn_task()
                if not await process_buffered_utterance("manual"):
                    await send_event({"type": "listening_ready", "streamId": state.get("streamId")}, "session.updated")
            elif message_type == "commit_utterance":
                cancel_turn_task()
                reason = message.get("reason") if isinstance(message.get("reason"), str) else "manual"
                if reason != "manual":
                    turn_manager.speech_end(loop.time())
                    schedule_turn_processing(0.9, reason)
                    continue
                if not await process_buffered_utterance(reason):
                    await send_event({"type": "listening_ready", "streamId": state.get("streamId")}, "session.updated")
            elif message_type == "barge_in":
                state["bargeInSeq"] = int(state.get("bargeInSeq") or 0) + 1
                state["assistantSpeaking"] = False
                previous_response_id = cancel_active_response()
                if state.get("responseCommitted") and hasattr(coordinator, "record_voice_delivery"):
                    coordinator.record_voice_delivery(
                        state.get("sessionId"),
                        previous_response_id,
                        "interrupted",
                        state.get("lastProcessedUtteranceId"),
                    )
                await send_event({
                    "type": "barge_in_ack",
                    "responseId": previous_response_id,
                    "previousResponseId": previous_response_id,
                    "deliveryStatus": "interrupted",
                }, "response.cancelled")
            elif message_type == "cancel_avatar_speech":
                state["assistantSpeaking"] = False
                previous_response_id = cancel_active_response()
                if state.get("responseCommitted") and hasattr(coordinator, "record_voice_delivery"):
                    coordinator.record_voice_delivery(
                        state.get("sessionId"),
                        previous_response_id,
                        "interrupted",
                        state.get("lastProcessedUtteranceId"),
                    )
                await send_event({"type": "avatar_speech_cancelled", "responseId": previous_response_id, "deliveryStatus": "interrupted"}, "response.cancelled")
            elif message_type == "playback_completed":
                response_id = str(message.get("responseId") or state.get("activeResponseId") or "")
                if response_id and response_id not in state["cancelledResponseIds"]:
                    state["assistantSpeaking"] = False
                    state.get("ttsPayloads", {}).pop(response_id, None)
                    if hasattr(coordinator, "record_voice_delivery"):
                        coordinator.record_voice_delivery(
                            state.get("sessionId"),
                            response_id,
                            "completed",
                            state.get("lastProcessedUtteranceId"),
                        )
            elif message_type == "cancel":
                cancel_active_response()
                if speech_session:
                    speech_session.stop()
                    speech_session = None
                await send_event({"type": "cancelled", "deliveryStatus": "cancelled"}, "response.cancelled")
    except WebSocketDisconnect:
        pass
    finally:
        pending_response_task = response_task
        cancel_turn_task()
        cancel_active_response()
        if pending_response_task:
            with contextlib.suppress(asyncio.CancelledError, RuntimeError):
                await pending_response_task
        if proactive_restart_task:
            proactive_restart_task.cancel()
        if speech_session:
            speech_session.stop()
        for active_tts_session in list(state.get("ttsSessions", {}).values()):
            active_tts_session.stop()
        event_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await event_task


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "adk_service.main:app",
        host="127.0.0.1",
        port=int(os.environ.get("ADK_SERVICE_PORT", "8765")),
        reload=False,
    )
