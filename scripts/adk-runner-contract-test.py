from __future__ import annotations

import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from adk_service import runtime


class FakeSessionService:
    async def create_session(self, **kwargs):
        return type("Session", (), {"id": kwargs["session_id"]})()


class FakeEvent:
    content = type("ContentValue", (), {
        "parts": [type("TextPart", (), {"text": '{"ok":true}'})()]
    })()

    def is_final_response(self):
        return True


class FakeRunner:
    calls = 0
    failure = False

    def __init__(self, **kwargs):
        self.kwargs = kwargs

    async def run_async(self, **kwargs):
        type(self).calls += 1
        if type(self).failure:
            raise RuntimeError("runner failed")
        yield FakeEvent()


class AdkRunnerContractTests(unittest.TestCase):
    def test_one_ephemeral_runner_call_and_no_direct_retry(self):
        FakeRunner.calls = 0
        FakeRunner.failure = False
        client = runtime.DeepSeekClient()
        client.api_key = "test-key"

        with (
            patch.dict(os.environ, ADK_LLM_EXECUTION_ENABLED="true"),
            patch.object(runtime, "ADK_AVAILABLE", True),
            patch.object(runtime, "LlmAgent", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "LiteLlm", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "Runner", FakeRunner),
            patch.object(runtime, "InMemorySessionService", FakeSessionService),
            patch.object(runtime, "Content", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "Part", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "GenerateContentConfig", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime.httpx, "AsyncClient", side_effect=AssertionError("direct retry must not run")),
        ):
            result = asyncio.run(client.json_completion("return JSON", 0.2))
        self.assertEqual(result, {"ok": True})
        self.assertEqual(FakeRunner.calls, 1)

    def test_runner_failure_does_not_fallback_to_direct_http(self):
        FakeRunner.calls = 0
        FakeRunner.failure = True
        client = runtime.DeepSeekClient()
        client.api_key = "test-key"
        with (
            patch.dict(os.environ, ADK_LLM_EXECUTION_ENABLED="true"),
            patch.object(runtime, "ADK_AVAILABLE", True),
            patch.object(runtime, "LlmAgent", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "LiteLlm", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "Runner", FakeRunner),
            patch.object(runtime, "InMemorySessionService", FakeSessionService),
            patch.object(runtime, "Content", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "Part", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime, "GenerateContentConfig", side_effect=lambda **kwargs: kwargs),
            patch.object(runtime.httpx, "AsyncClient", side_effect=AssertionError("direct retry must not run")),
        ):
            with self.assertRaisesRegex(RuntimeError, "runner failed"):
                asyncio.run(client.json_completion("return JSON", 0.2))
        self.assertEqual(FakeRunner.calls, 1)
        FakeRunner.failure = False


if __name__ == "__main__":
    unittest.main()
