"""Harness Evolution Service.

Manages evidence-backed repository lessons, verified tool guidance recipes,
and operator governance controls (1-click veto, safe mode sentinel).
Includes TypeSafe Jev System 1 curation gate to reject hallucinated or low-value lessons.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import fnmatch
import json
import logging
from pathlib import Path
from typing import Any

from factory.jev_client import JevClient, NoulAnswer, ScoreAnswer

logger = logging.getLogger(__name__)

SAFE_MODE_SENTINEL = "NO_HARNESS_MEMORY"
LESSONS_FILE = "lessons.jsonl"
TOOL_GUIDANCE_FILE = "tool-guidance.json"


class HarnessEvolutionError(Exception):
    """Base exception for harness evolution errors."""
    pass


class LessonRejectedError(HarnessEvolutionError):
    """Raised when a candidate lesson fails TypeSafe Jev curation thresholds."""
    pass


@dataclass
class LessonCandidate:
    topic: str
    trigger_patterns: list[str]
    rule: str
    evidence: str


@dataclass
class Lesson:
    id: str
    topic: str
    trigger_patterns: list[str]
    rule: str
    evidence: str
    vetoed: bool = False
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Lesson:
        return cls(
            id=str(data.get("id", "")),
            topic=str(data.get("topic", "")),
            trigger_patterns=list(data.get("trigger_patterns", [])),
            rule=str(data.get("rule", "")),
            evidence=str(data.get("evidence", "")),
            vetoed=bool(data.get("vetoed", False)),
            created_at=str(data.get("created_at", "")),
        )


def _get_lessons_path(root: Path) -> Path:
    return root / ".factory" / LESSONS_FILE


def _get_tool_guidance_path(root: Path) -> Path:
    return root / ".factory" / TOOL_GUIDANCE_FILE


def _get_safe_mode_path(root: Path) -> Path:
    return root / ".factory" / SAFE_MODE_SENTINEL


def is_safe_mode_active(root: Path) -> bool:
    """Check if emergency safe mode sentinel exists."""
    return _get_safe_mode_path(root).exists()


def set_safe_mode(root: Path, active: bool) -> None:
    """Enable or disable emergency safe mode sentinel."""
    sentinel = _get_safe_mode_path(root)
    sentinel.parent.mkdir(parents=True, exist_ok=True)
    if active:
        sentinel.touch(exist_ok=True)
    else:
        if sentinel.exists():
            sentinel.unlink()


def load_lessons(
    root: Path,
    include_vetoed: bool = False,
    topic: str | None = None,
    pattern: str | None = None,
) -> list[Lesson]:
    """Load lessons from .factory/lessons.jsonl with optional filters."""
    path = _get_lessons_path(root)
    if not path.is_file():
        return []

    lessons: list[Lesson] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                lesson = Lesson.from_dict(data)
            except Exception as err:
                logger.warning(f"Skipping malformed lesson entry: {line} ({err})")
                continue

            if not include_vetoed and lesson.vetoed:
                continue

            if topic is not None and lesson.topic != topic:
                continue

            if pattern is not None:
                matches = any(
                    fnmatch.fnmatch(pattern, pat) or pat in pattern
                    for pat in lesson.trigger_patterns
                )
                if not matches:
                    continue

            lessons.append(lesson)

    return lessons


def add_lesson(
    root: Path,
    candidate: LessonCandidate,
    jev_client: JevClient | None = None,
) -> Lesson:
    """Evaluate candidate lesson via TypeSafe Jev and append if approved."""
    if jev_client and jev_client.is_configured:
        questions = {
            "is_grounded": {
                "type": "noul",
                "instructions": (
                    "Is this lesson rule strictly grounded in the execution evidence "
                    "without hallucination or unverified speculation?"
                ),
            },
            "importance": {
                "type": "score",
                "instructions": "Rate importance and utility of the rule for future agent laps",
                "criteria": [
                    "trivial_or_redundant",
                    "low_value_cosmetic",
                    "actionable_gotcha",
                    "critical_architectural_rule",
                ],
            },
        }
        context = (
            f"Topic: {candidate.topic}\n"
            f"Rule: {candidate.rule}\n"
            f"Evidence: {candidate.evidence}\n"
            f"Trigger Patterns: {candidate.trigger_patterns}"
        )

        try:
            eval_result = jev_client.evaluate(context, questions)
            grounded_ans = eval_result.answers.get("is_grounded")
            importance_ans = eval_result.answers.get("importance")

            is_grounded = (
                isinstance(grounded_ans, NoulAnswer) and grounded_ans.noul >= 0.70
            )
            is_important = (
                isinstance(importance_ans, ScoreAnswer)
                and importance_ans.confidence >= 0.70
                and importance_ans.score >= 1.0
            )

            if not is_grounded or not is_important:
                reasons = []
                if not is_grounded:
                    reasons.append(
                        f"low_groundedness ({grounded_ans.noul if isinstance(grounded_ans, NoulAnswer) else 'missing'} < 0.70)"
                    )
                if not is_important:
                    reasons.append("low_importance_or_confidence")
                raise LessonRejectedError(
                    f"Candidate lesson rejected by Jev: {', '.join(reasons)}"
                )
        except LessonRejectedError:
            raise
        except Exception as err:
            logger.warning(f"Jev evaluation failed: {err}; failing closed.")
            raise LessonRejectedError(f"Jev evaluation failed: {err}") from err

    # Generate sequence ID
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    existing_lessons = load_lessons(root, include_vetoed=True)
    today_prefix = f"lsn-{date_str}-"
    today_seqs = []
    for l in existing_lessons:
        if l.id.startswith(today_prefix):
            try:
                seq = int(l.id[len(today_prefix) :])
                today_seqs.append(seq)
            except ValueError:
                pass

    next_seq = max(today_seqs, default=0) + 1
    lesson_id = f"{today_prefix}{next_seq:02d}"

    lesson = Lesson(
        id=lesson_id,
        topic=candidate.topic,
        trigger_patterns=candidate.trigger_patterns,
        rule=candidate.rule,
        evidence=candidate.evidence,
        vetoed=False,
        created_at=datetime.now(timezone.utc).isoformat(),
    )

    path = _get_lessons_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(lesson.to_dict()) + "\n")

    return lesson


def veto_lesson(root: Path, lesson_id: str) -> bool:
    """Mark a lesson as vetoed in .factory/lessons.jsonl."""
    path = _get_lessons_path(root)
    if not path.is_file():
        return False

    all_lessons = load_lessons(root, include_vetoed=True)
    found = False
    for lesson in all_lessons:
        if lesson.id == lesson_id:
            lesson.vetoed = True
            found = True
            break

    if not found:
        return False

    # Rewrite file
    with open(path, "w", encoding="utf-8") as f:
        for lesson in all_lessons:
            f.write(json.dumps(lesson.to_dict()) + "\n")

    return True


def update_tool_guidance(root: Path, task: str, command: str) -> None:
    """Record verified zero-exit command in .factory/tool-guidance.json."""
    path = _get_tool_guidance_path(root)
    data: dict[str, str] = {}
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as err:
            logger.warning(f"Could not parse existing tool guidance: {err}")

    data[task] = command
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def load_tool_guidance(root: Path) -> dict[str, str]:
    """Load tool guidance mapping."""
    path = _get_tool_guidance_path(root)
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as err:
        logger.warning(f"Could not load tool guidance: {err}")
        return {}


class HarnessEvolutionService:
    """Service wrapping harness memory operations for high-level coordinators."""

    def __init__(self, root: Path, jev_client: JevClient | None = None) -> None:
        self.root = root
        self.jev_client = jev_client

    def is_safe_mode(self) -> bool:
        return is_safe_mode_active(self.root)

    def set_safe_mode(self, active: bool) -> None:
        set_safe_mode(self.root, active)

    def get_lessons(
        self,
        include_vetoed: bool = False,
        topic: str | None = None,
        pattern: str | None = None,
    ) -> list[Lesson]:
        if self.is_safe_mode():
            return []
        return load_lessons(
            self.root,
            include_vetoed=include_vetoed,
            topic=topic,
            pattern=pattern,
        )

    def get_all_lessons_raw(self) -> list[Lesson]:
        """Return all lessons including vetoed even in safe mode (for dashboard inspection)."""
        return load_lessons(self.root, include_vetoed=True)

    def add_lesson(self, candidate: LessonCandidate) -> Lesson:
        return add_lesson(self.root, candidate, jev_client=self.jev_client)

    def veto_lesson(self, lesson_id: str) -> bool:
        return veto_lesson(self.root, lesson_id)

    def get_tools(self) -> dict[str, str]:
        if self.is_safe_mode():
            return {}
        return load_tool_guidance(self.root)

    def update_tool(self, task: str, command: str) -> None:
        update_tool_guidance(self.root, task, command)
