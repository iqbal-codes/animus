from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from factory.harness_evolution import (
    HarnessEvolutionService,
    Lesson,
    LessonCandidate,
    LessonRejectedError,
    add_lesson,
    deprecate_tool_guidance,
    is_safe_mode_active,
    load_lessons,
    load_tool_guidance,
    set_safe_mode,
    update_tool_guidance,
    veto_lesson,
)
from factory.jev_client import JevClient


class TestHarnessEvolution(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.factory_dir = self.root / ".factory"
        self.factory_dir.mkdir(parents=True, exist_ok=True)

        # Baseline files
        self.guidance_file = self.factory_dir / "tool-guidance.json"
        self.guidance_file.write_text(
            json.dumps({"test": "python3 -m unittest discover -s tests"}),
            encoding="utf-8",
        )

        self.lessons_file = self.factory_dir / "lessons.jsonl"
        self.baseline_lesson = {
            "id": "lsn-20261027-01",
            "topic": "test-execution",
            "trigger_patterns": ["tests/*", "unittest"],
            "rule": "Run tests offline.",
            "evidence": "Lap test suite requires offline mock fixtures.",
            "vetoed": False,
            "created_at": "2026-10-27T08:00:00Z",
        }
        self.lessons_file.write_text(
            json.dumps(self.baseline_lesson) + "\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_load_lessons_active_and_filtered(self) -> None:
        # Add a vetoed lesson
        vetoed_lesson = {
            "id": "lsn-20261027-02",
            "topic": "linting",
            "trigger_patterns": ["*.py"],
            "rule": "Use flake8.",
            "evidence": "Lap 2 logs.",
            "vetoed": True,
            "created_at": "2026-10-27T08:30:00Z",
        }
        with open(self.lessons_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(vetoed_lesson) + "\n")

        # Load only active
        active_lessons = load_lessons(self.root)
        self.assertEqual(len(active_lessons), 1)
        self.assertEqual(active_lessons[0].id, "lsn-20261027-01")

        # Load all including vetoed
        all_lessons = load_lessons(self.root, include_vetoed=True)
        self.assertEqual(len(all_lessons), 2)

        # Filter by topic
        test_lessons = load_lessons(self.root, topic="test-execution")
        self.assertEqual(len(test_lessons), 1)
        lint_lessons = load_lessons(self.root, topic="linting")
        self.assertEqual(len(lint_lessons), 0)

        # Filter by trigger pattern
        matching = load_lessons(self.root, pattern="tests/foo.py")
        self.assertEqual(len(matching), 1)
        non_matching = load_lessons(self.root, pattern="docs/readme.md")
        self.assertEqual(len(non_matching), 0)

    def test_add_lesson_with_high_jev_confidence(self) -> None:
        def high_confidence_transport(payload: dict) -> dict:
            return {
                "id": "jev-res-1",
                "model": "typesafe/jev-1.14",
                "answers": {
                    "is_grounded": {"noul": 0.95},
                    "importance": {
                        "score": 2.5,
                        "confidence": 0.92,
                        "legend": {0: "trivial", 1: "low", 2: "actionable", 3: "critical"},
                        "probabilities": {0: 0.02, 1: 0.06, 2: 0.60, 3: 0.32},
                    },
                },
                "usage": {},
            }

        client = JevClient(transport=high_confidence_transport)
        candidate = LessonCandidate(
            topic="async-testing",
            trigger_patterns=["tests/async_*.py"],
            rule="Configure pytest-asyncio auto mode.",
            evidence="Lap #5 failed without event loop initialization.",
        )

        lesson = add_lesson(self.root, candidate, jev_client=client)
        self.assertIsNotNone(lesson)
        self.assertEqual(lesson.topic, "async-testing")
        self.assertFalse(lesson.vetoed)

        # Check it was written to lessons.jsonl
        lessons = load_lessons(self.root)
        self.assertEqual(len(lessons), 2)
        self.assertEqual(lessons[1].topic, "async-testing")

    def test_reject_lesson_with_low_jev_confidence(self) -> None:
        def low_confidence_transport(payload: dict) -> dict:
            return {
                "id": "jev-res-2",
                "model": "typesafe/jev-1.14",
                "answers": {
                    "is_grounded": {"noul": 0.45},  # Low groundedness (< 0.70)
                    "importance": {
                        "score": 0.5,
                        "confidence": 0.50,
                        "legend": {0: "trivial", 1: "low"},
                        "probabilities": {0: 0.7, 1: 0.3},
                    },
                },
                "usage": {},
            }

        client = JevClient(transport=low_confidence_transport)
        candidate = LessonCandidate(
            topic="hallucinated-topic",
            trigger_patterns=["*"],
            rule="Always restart daemon twice.",
            evidence="Might have been needed once maybe.",
        )

        with self.assertRaises(LessonRejectedError):
            add_lesson(self.root, candidate, jev_client=client)

        # Confirm lessons.jsonl was not modified
        lessons = load_lessons(self.root)
        self.assertEqual(len(lessons), 1)

    def test_veto_lesson(self) -> None:
        # Veto existing lesson
        success = veto_lesson(self.root, "lsn-20261027-01")
        self.assertTrue(success)

        # Active lessons should now be empty
        active = load_lessons(self.root)
        self.assertEqual(len(active), 0)

        # All lessons should show vetoed=True
        all_lessons = load_lessons(self.root, include_vetoed=True)
        self.assertEqual(len(all_lessons), 1)
        self.assertTrue(all_lessons[0].vetoed)

        # Non-existent ID returns False
        self.assertFalse(veto_lesson(self.root, "non-existent-id"))

    def test_tool_guidance_update_and_invalidation(self) -> None:
        # Update command
        update_tool_guidance(self.root, "lint", "ruff check .")
        data = json.loads(self.guidance_file.read_text(encoding="utf-8"))
        self.assertEqual(data["lint"], "ruff check .")
        self.assertEqual(data["test"], "python3 -m unittest discover -s tests")

        # Invalidate / update existing command
        update_tool_guidance(self.root, "test", "pytest -v")
        data = json.loads(self.guidance_file.read_text(encoding="utf-8"))
        self.assertEqual(data["test"], "pytest -v")

        # Deprecate command
        deprecate_tool_guidance(self.root, "lint")
        active_tools = load_tool_guidance(self.root)
        self.assertNotIn("lint", active_tools)
        all_tools = load_tool_guidance(self.root, include_deprecated=True)
        self.assertTrue(all_tools["lint"].startswith("[DEPRECATED]"))

    def test_unconfigured_jev_client_fails_closed(self) -> None:
        candidate = LessonCandidate(
            topic="test-topic",
            trigger_patterns=["*.py"],
            rule="Do something.",
            evidence="Some evidence.",
        )
        # Without jev client
        with self.assertRaises(LessonRejectedError):
            add_lesson(self.root, candidate, jev_client=None)

        # With unconfigured jev client
        unconfigured = JevClient(api_key=None, transport=None)
        with self.assertRaises(LessonRejectedError):
            add_lesson(self.root, candidate, jev_client=unconfigured)

    def test_lesson_occurrence_count(self) -> None:
        lessons = load_lessons(self.root)
        self.assertEqual(lessons[0].occurrence_count, 1)

    def test_safe_mode_sentinel_lifecycle(self) -> None:
        sentinel = self.factory_dir / "NO_HARNESS_MEMORY"
        self.assertFalse(sentinel.exists())
        self.assertFalse(is_safe_mode_active(self.root))

        # Enable safe mode
        set_safe_mode(self.root, active=True)
        self.assertTrue(sentinel.exists())
        self.assertTrue(is_safe_mode_active(self.root))

        # Disable safe mode
        set_safe_mode(self.root, active=False)
        self.assertFalse(sentinel.exists())
        self.assertFalse(is_safe_mode_active(self.root))

    def test_harness_evolution_service_class(self) -> None:
        service = HarnessEvolutionService(self.root)
        self.assertEqual(len(service.get_lessons()), 1)
        self.assertIn("test", service.get_tools())
        self.assertFalse(service.is_safe_mode())

        service.set_safe_mode(True)
        self.assertTrue(service.is_safe_mode())


if __name__ == "__main__":
    unittest.main()
