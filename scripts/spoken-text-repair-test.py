import asyncio
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adk_service.runtime import ClientRealismScoringAgent
from adk_service.spoken_text import validate_spoken_text

class FakeLLM:
    enabled = True

class Scorer(ClientRealismScoringAgent):
    def __init__(self, repaired):
        super().__init__(FakeLLM())
        self.repaired = repaired
        self.calls = 0

    def _calibrate_response(self, payload, response, **kwargs):
        return {**response, "realismAssessment": {"spokenTextValidation": validate_spoken_text(response["clientText"])}}

    async def _repair_once(self, *args):
        self.calls += 1
        return self.repaired

async def main():
    invalid = {"clientText": "（皺一皺眉，望住你）……你講咩話？"}
    valid = {"clientText": "你講咩話？我唔係好明你想問乜。"}
    scorer = Scorer(valid)
    assert (await scorer.run({}, invalid))["clientText"] == valid["clientText"]
    assert scorer.calls == 1
    for repaired in [invalid, None, {"clientText": ""}]:
        scorer = Scorer(repaired)
        try:
            await scorer.run({}, invalid)
            raise AssertionError("Invalid repaired output must fail before persistence/TTS")
        except ValueError:
            assert scorer.calls == 1
    scorer = Scorer(invalid)
    await scorer.run({}, valid)
    assert scorer.calls == 0
    print("Passed one shared repair, failed repair rejection and valid speech without extra LLM calls.")

asyncio.run(main())
