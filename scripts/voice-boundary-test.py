import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adk_service.voice_turns import VoiceTurnManager
from adk_service.spoken_text import validate_spoken_text, require_spoken_text

for text in ["（皺一皺眉，望住你）……你講咩話？", "*frowns* What?", "（低頭）", "Client: Hello", "The client nods."]:
    assert not validate_spoken_text(text)["valid"], text
for text in ["……我唔明。", "佢話「你唔好再問」。", "我低頭係因為攰。", "他看不起我。", 'He said "leave me alone".', "I looked away because I was upset."]:
    assert validate_spoken_text(text)["valid"], text
try:
    require_spoken_text({"clientText": "*sighs*"})
    raise AssertionError("Invalid speech escaped the final gate")
except ValueError:
    pass

m = VoiceTurnManager()
m.rotate("s0")
now = 0.0
for i in range(24):
    now += 3
    old = m.stream_id
    final = i % 2 == 0
    event = {"speechStreamId": old, "type": "asr_final" if final else "asr_partial", "transcript": "你好", "resultEndMs": (i + 1) * 2000}
    assert m.receive(event, now)
    deadline = m.deadline
    m.receive(event, now + 0.2)
    assert m.deadline == deadline, "Repeated interim reset deadline"
    result = m.commit(now + 1.3)
    assert result and result["transcript"] == "你好"
    assert m.commit(now + 1.4, manual=True) is None
    if not final:
        m.rotate(f"s{i + 1}")
    assert not m.receive({**event, "type": "asr_final"}, now + 1.5)
assert len(m.commits) == 24
m.speech_start()
m.receive({"transcript": "下一句", "type": "asr_partial", "resultEndMs": 100000}, 90)
m.speech_end(90.2)
assert m.commit(90.8) is None
assert m.commit(91.2)
m.speech_end(92)
assert m.commit(93) is None
assert not m.utterance_id
print("Passed 24 turns, missing/late finals, identical real utterances, VAD/manual boundaries and spoken-text structure.")
