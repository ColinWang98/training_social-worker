"""Session-local recognition boundaries, independent of transport and LLM work."""
from dataclasses import dataclass, field


@dataclass
class VoiceTurnManager:
    epoch: int = 0
    stream_id: str = ""
    sequence: int = 0
    utterance_id: str = ""
    text: str = ""
    final_text: str = ""
    is_final: bool = False
    end_ms: float = 0
    committed_end_ms: float = 0
    changed_at: float = 0
    deadline: float | None = None
    vad_active: bool = False
    vad_speaking: bool = False
    late_results: int = 0
    commits: list = field(default_factory=list)

    def rotate(self, stream_id):
        self.epoch += 1
        self.stream_id = stream_id
        self.clear()
        self.committed_end_ms = 0

    def clear(self):
        self.utterance_id = ""
        self.text = self.final_text = ""
        self.is_final = False
        self.end_ms = 0
        self.deadline = None

    def speech_start(self):
        self.vad_active = self.vad_speaking = True
        self.deadline = None

    def speech_end(self, now):
        self.vad_active = True
        self.vad_speaking = False
        self.deadline = now + 0.9

    def receive(self, event, now):
        if event.get("speechStreamId", self.stream_id) != self.stream_id:
            self.late_results += 1
            return False
        end = float(event.get("resultEndMs") or 0)
        if end and (end <= self.committed_end_ms or end < self.end_ms):
            self.late_results += 1
            return False
        text = str(event.get("transcript", "")).strip()
        final = event.get("type") == "asr_final"
        if not text:
            return False
        if end and end == self.end_ms and self.is_final:
            return False
        if not self.utterance_id:
            self.sequence += 1
            self.utterance_id = f"utt-{self.sequence}"
        if self.final_text and not text.startswith(self.final_text) and end >= self.end_ms:
            text = f"{self.final_text} {text}"
        changed = text != self.text or final != self.is_final
        self.text, self.is_final, self.end_ms = text, final, end
        if final:
            self.final_text = text
        if changed:
            self.changed_at = now
            if not self.vad_active:
                self.deadline = now + (0.9 if final else 1.2)
            elif self.deadline is None or self.vad_speaking:
                # A missed VAD end must not leave recognition waiting forever.
                self.deadline = now + (1.2 if final else 5.0)
        return changed

    def commit(self, now, manual=False):
        if not manual and (self.deadline is None or now < self.deadline):
            return None
        if not self.text or (not manual and not self.is_final and now - self.changed_at < 0.4):
            self.clear()
            return None
        result = {"transcript": self.text, "utteranceId": self.utterance_id,
                  "partial": not self.is_final, "streamEpoch": self.epoch,
                  "audioEndMs": self.end_ms}
        self.committed_end_ms = self.end_ms
        self.commits = [*self.commits[-99:], result["utteranceId"]]
        self.clear()
        return result

    def debug(self):
        return {"streamEpoch": self.epoch, "utteranceId": self.utterance_id,
                "lateResultsDiscarded": self.late_results,
                "utteranceState": "collecting" if self.utterance_id else "listening"}
