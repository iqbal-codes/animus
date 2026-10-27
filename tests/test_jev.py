"""Unit tests for TypeSafe Jev System 1 Decision Client (factory/jev_client.py)."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import MagicMock, patch
import urllib.error

from factory.jev_client import (
    ChoiceAnswer,
    JevAPIError,
    JevClient,
    JevConfigurationError,
    JevError,
    JevEvaluationResult,
    JevParseError,
    JevTimeoutError,
    NoulAnswer,
    ScoreAnswer,
)


class JevClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.sample_response = {
            "id": "jev-eval-12345",
            "model": "typesafe/jev-1.14",
            "answers": {
                "is_actionable": {
                    "noul": 0.88,
                },
                "triage_category": {
                    "choice": "ready_for_agent",
                    "confidence": 0.94,
                    "probabilities": {
                        "ready_for_agent": 0.94,
                        "needs_info": 0.04,
                        "ready_for_human": 0.02,
                    },
                },
                "complexity": {
                    "score": 1.75,
                    "confidence": 0.82,
                    "legend": {"0": "trivial", "1": "small", "2": "medium", "3": "large"},
                    "probabilities": {"0": 0.05, "1": 0.80, "2": 0.12, "3": 0.03},
                },
            },
            "usage": {
                "prompt_tokens": 150,
                "total_tokens": 150,
            },
        }

    def test_jev_payload_serialization(self) -> None:
        """AC1: Request payload formats noul, choice, and score correctly."""
        captured_payload = None

        def mock_transport(payload: dict) -> dict:
            nonlocal captured_payload
            captured_payload = payload
            return self.sample_response

        client = JevClient(api_key="test-key", transport=mock_transport)
        questions = {
            "is_actionable": {
                "type": "noul",
                "instructions": "Does the issue have clear acceptance criteria?",
            },
            "triage_category": {
                "type": "choice",
                "instructions": "Categorize the issue",
                "criteria": {
                    "ready_for_agent": "Fully specified with unambiguous acceptance criteria",
                    "needs_info": "Vague or missing acceptance criteria",
                    "ready_for_human": "Requires human decision or high-level architecture",
                },
            },
            "complexity": {
                "type": "score",
                "instructions": "Rate complexity of the task",
                "criteria": [
                    "trivial_single_line",
                    "small_single_file",
                    "medium_multi_file",
                    "large_system_wide",
                ],
            },
        }

        result = client.evaluate("Title: Fix crash\nBody: Null pointer", questions)

        self.assertIsNotNone(captured_payload)
        self.assertEqual(captured_payload["model"], "typesafe/jev-1.14")
        self.assertEqual(captured_payload["state"], "Title: Fix crash\nBody: Null pointer")
        self.assertEqual(captured_payload["questions"], questions)

    def test_jev_response_deserialization(self) -> None:
        """AC2: Parses response into typed dataclasses."""
        client = JevClient(api_key="test-key", transport=lambda p: self.sample_response)
        result = client.evaluate("some state", {"q": {"type": "noul", "instructions": "test"}})

        self.assertIsInstance(result, JevEvaluationResult)
        self.assertEqual(result.id, "jev-eval-12345")
        self.assertEqual(result.model, "typesafe/jev-1.14")

        # Noul check
        noul_ans = result.answers["is_actionable"]
        self.assertIsInstance(noul_ans, NoulAnswer)
        self.assertAlmostEqual(noul_ans.noul, 0.88)

        # Choice check
        choice_ans = result.answers["triage_category"]
        self.assertIsInstance(choice_ans, ChoiceAnswer)
        self.assertEqual(choice_ans.choice, "ready_for_agent")
        self.assertAlmostEqual(choice_ans.confidence, 0.94)
        self.assertEqual(choice_ans.probabilities["ready_for_agent"], 0.94)

        # Score check
        score_ans = result.answers["complexity"]
        self.assertIsInstance(score_ans, ScoreAnswer)
        self.assertAlmostEqual(score_ans.score, 1.75)
        self.assertAlmostEqual(score_ans.confidence, 0.82)
        self.assertEqual(score_ans.legend[1], "small")
        self.assertEqual(score_ans.probabilities[1], 0.80)

        # Usage check
        self.assertEqual(result.usage["total_tokens"], 150)

    def test_missing_api_key_raises_configuration_error(self) -> None:
        """AC4: Missing API key raises JevConfigurationError when using default transport."""
        with patch.dict(os.environ, {}, clear=True):
            client = JevClient(api_key=None)
            with self.assertRaises(JevConfigurationError):
                client.evaluate("state", {})

    def test_transport_timeout_raises_jev_timeout_error(self) -> None:
        """AC3: Timeout raises JevTimeoutError."""
        def timeout_transport(payload: dict) -> dict:
            raise TimeoutError("Connection timed out")

        client = JevClient(api_key="test-key", transport=timeout_transport)
        with self.assertRaises(JevTimeoutError):
            client.evaluate("state", {})

    def test_transport_api_error_raises_jev_api_error(self) -> None:
        """AC3: HTTP 429 / 500 raises JevAPIError with status code."""
        def error_transport(payload: dict) -> dict:
            raise JevAPIError(status_code=429, message="Rate limit exceeded")

        client = JevClient(api_key="test-key", transport=error_transport)
        with self.assertRaises(JevAPIError) as ctx:
            client.evaluate("state", {})
        self.assertEqual(ctx.exception.status_code, 429)

    def test_malformed_response_raises_jev_parse_error(self) -> None:
        """AC3: Non-dictionary or missing fields raises JevParseError."""
        client = JevClient(api_key="test-key", transport=lambda p: {"invalid": "shape"})
        with self.assertRaises(JevParseError):
            client.evaluate("state", {})

    def test_default_transport_network_error(self) -> None:
        """AC3: urllib.error.HTTPError gets mapped to JevAPIError."""
        client = JevClient(api_key="fake-key")
        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_urlopen.side_effect = urllib.error.HTTPError(
                url="https://openrouter.ai/api/v1/systemone",
                code=500,
                msg="Internal Server Error",
                hdrs=None,
                fp=None,
            )
            with self.assertRaises(JevAPIError) as ctx:
                client.evaluate("state", {})
            self.assertEqual(ctx.exception.status_code, 500)


if __name__ == "__main__":
    unittest.main()
