"""Offline checks for STT audio starvation, bounded buffering and shutdown."""
import queue
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adk_service.runtime import StreamingSpeechSession, realtime_pcm_chunks, AudioCaptureGap

audio_queue = queue.Queue(maxsize=25)
session = StreamingSpeechSession(audio_queue, threading.Thread())
chunks = realtime_pcm_chunks(audio_queue, 16000)
started = time.monotonic()
assert next(chunks) == bytes(3200)
assert time.monotonic() - started >= 0.09, "Silence must be paced, not emitted in a busy loop"
session.send_audio(b"live")
assert next(chunks) == b"live"
session.send_audio(bytes(32001))
assert session.stopped, "Overflow must explicitly stop stale audio"
session.stop()
session.stop()
session.send_audio(b"after stop")
assert list(chunks) == [], "Stopping must discard queued audio immediately"
q = queue.Queue()
finishing = StreamingSpeechSession(q, threading.Thread())
finishing.send_audio(b"accepted")
finishing.finish()
assert list(realtime_pcm_chunks(q, 16000)) == [b"accepted"]
q = queue.Queue()
try:
    list(realtime_pcm_chunks(q, 16000))
    raise AssertionError("Missing audio was concealed by unlimited silence")
except AudioCaptureGap:
    pass
print("Passed paced/bounded silence, live audio recovery, overflow, graceful finish and abort.")

class ContinuousSilentMicrophone:
    frames = 600
    def get(self, timeout):
        self.frames -= 1
        return bytes(3200) if self.frames >= 0 else None

assert len(list(realtime_pcm_chunks(ContinuousSilentMicrophone(), 16000))) == 600
print("Sixty seconds of real silent microphone frames do not trigger capture starvation.")
