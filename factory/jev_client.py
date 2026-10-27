"""TypeSafe Jev System 1 Decision Client.

Communicates with OpenRouter /api/v1/systemone endpoint using model typesafe/jev-1.14.
Provides non-autoregressive, sub-300ms typed decisions with calibrated confidence
for boolean (noul), categorical (choice), and ordinal (score) questions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
import logging
import os
import socket
from typing import Any, Callable
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "typesafe/jev-1.14"
DEFAULT_TIMEOUT = 5.0


class JevError(Exception):
    """Base exception for all Jev client errors."""
    pass


class JevConfigurationError(JevError):
    """Raised when client is missing required configuration such as API key."""
    pass


class JevTimeoutError(JevError):
    """Raised when Jev API call times out."""
    pass


class JevAPIError(JevError):
    """Raised when Jev API returns a non-2xx status code."""
    def __init__(self, status_code: int, message: str, body: str = "") -> None:
        super().__init__(f"Jev API HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.body = body


class JevParseError(JevError):
    """Raised when Jev API response structure is invalid or unparseable."""
    pass


@dataclass(frozen=True)
class NoulAnswer:
    noul: float  # Calibrated probability [0.0, 1.0]


@dataclass(frozen=True)
class ChoiceAnswer:
    choice: str  # Winning label key
    confidence: float  # Calibrated confidence score
    probabilities: dict[str, float]  # Full probability distribution


@dataclass(frozen=True)
class ScoreAnswer:
    score: float  # Continuous calibrated score
    confidence: float
    legend: dict[int, str]
    probabilities: dict[int, float]


@dataclass(frozen=True)
class JevEvaluationResult:
    id: str
    model: str
    answers: dict[str, NoulAnswer | ChoiceAnswer | ScoreAnswer]
    usage: dict[str, Any] = field(default_factory=dict)


def parse_answer(ans_data: dict[str, Any]) -> NoulAnswer | ChoiceAnswer | ScoreAnswer:
    """Parse a single question's answer payload into typed dataclass."""
    if not isinstance(ans_data, dict):
        raise JevParseError(f"Expected dict for answer, got {type(ans_data)}")

    if "noul" in ans_data:
        try:
            return NoulAnswer(noul=float(ans_data["noul"]))
        except (ValueError, TypeError) as err:
            raise JevParseError(f"Invalid noul value: {ans_data['noul']}") from err

    if "choice" in ans_data:
        try:
            choice = str(ans_data["choice"])
            confidence = float(ans_data.get("confidence", 0.0))
            raw_probs = ans_data.get("probabilities", {})
            probs = {str(k): float(v) for k, v in raw_probs.items()}
            return ChoiceAnswer(choice=choice, confidence=confidence, probabilities=probs)
        except (ValueError, TypeError) as err:
            raise JevParseError(f"Invalid choice answer payload: {ans_data}") from err

    if "score" in ans_data:
        try:
            score = float(ans_data["score"])
            confidence = float(ans_data.get("confidence", 0.0))
            raw_legend = ans_data.get("legend", {})
            legend = {int(k): str(v) for k, v in raw_legend.items()}
            raw_probs = ans_data.get("probabilities", {})
            probs = {int(k): float(v) for k, v in raw_probs.items()}
            return ScoreAnswer(score=score, confidence=confidence, legend=legend, probabilities=probs)
        except (ValueError, TypeError) as err:
            raise JevParseError(f"Invalid score answer payload: {ans_data}") from err

    raise JevParseError(f"Unrecognized answer shape: {ans_data}")


class JevClient:
    """Client for OpenRouter TypeSafe Jev System 1 Decision Endpoint."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY")
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.transport = transport

    @property
    def is_configured(self) -> bool:
        """True if client has an API key or an explicit transport provided."""
        return bool(self.api_key or self.transport)

    def evaluate(
        self, state: str, questions: dict[str, Any]
    ) -> JevEvaluationResult:
        """Evaluate state context against structured questions via Jev System 1."""
        payload = {
            "model": self.model,
            "state": state,
            "questions": questions,
        }

        if self.transport is not None:
            try:
                raw_response = self.transport(payload)
            except (TimeoutError, socket.timeout) as err:
                raise JevTimeoutError(f"Transport timed out: {err}") from err
            except JevError:
                raise
            except Exception as err:
                raise JevError(f"Transport error: {err}") from err
        else:
            raw_response = self._default_transport(payload)

        return self._parse_response(raw_response)

    def _default_transport(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Execute default HTTP POST via urllib."""
        if not self.api_key:
            logger.warning("OPENROUTER_API_KEY not configured for JevClient.")
            raise JevConfigurationError("OPENROUTER_API_KEY is required for default transport.")

        endpoint = f"{self.base_url}/systemone"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
                "User-Agent": "LabQ-Software-Factory/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
                return json.loads(body)
        except urllib.error.HTTPError as err:
            err_body = ""
            try:
                err_body = err.read().decode("utf-8")
            except Exception:
                pass
            raise JevAPIError(
                status_code=err.code,
                message=err.reason,
                body=err_body,
            ) from err
        except (urllib.error.URLError, socket.timeout, TimeoutError) as err:
            if isinstance(err, socket.timeout) or "timed out" in str(err).lower():
                raise JevTimeoutError(f"Jev request timed out: {err}") from err
            raise JevError(f"Network error contacting Jev endpoint: {err}") from err

    def _parse_response(self, raw: Any) -> JevEvaluationResult:
        if not isinstance(raw, dict):
            raise JevParseError(f"Response root must be a dict, got {type(raw)}")

        if "id" not in raw or "answers" not in raw:
            raise JevParseError(f"Response missing 'id' or 'answers': {raw}")

        eval_id = str(raw["id"])
        model = str(raw.get("model", self.model))
        answers_raw = raw.get("answers")
        if not isinstance(answers_raw, dict):
            raise JevParseError(f"'answers' must be a dict, got {type(answers_raw)}")

        parsed_answers: dict[str, NoulAnswer | ChoiceAnswer | ScoreAnswer] = {}
        for q_name, ans_payload in answers_raw.items():
            parsed_answers[q_name] = parse_answer(ans_payload)

        usage = raw.get("usage") or {}
        return JevEvaluationResult(
            id=eval_id,
            model=model,
            answers=parsed_answers,
            usage=usage if isinstance(usage, dict) else {},
        )
