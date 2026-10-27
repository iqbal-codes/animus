"""Unit tests for consumer scheduler gating, work window, and target binding."""
from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock

from factory import consumer
from intake import IntakeService


class WorkWindowTests(unittest.TestCase):
    def test_empty_window_always_active(self) -> None:
        self.assertTrue(consumer.is_within_work_window({}))
        self.assertTrue(consumer.is_within_work_window({"work_window": None}))

    def test_midnight_crossing_window(self) -> None:
        schedule = {"work_window": {"start": "20:00", "end": "05:00", "timezone": "UTC"}}
        # 21:00 UTC -> inside
        dt_inside_evening = datetime(2026, 10, 27, 21, 0, tzinfo=timezone.utc)
        self.assertTrue(consumer.is_within_work_window(schedule, dt_inside_evening))

        # 03:00 UTC -> inside
        dt_inside_morning = datetime(2026, 10, 27, 3, 0, tzinfo=timezone.utc)
        self.assertTrue(consumer.is_within_work_window(schedule, dt_inside_morning))

        # 05:00 UTC -> boundary (end is exclusive) -> outside
        dt_boundary = datetime(2026, 10, 27, 5, 0, tzinfo=timezone.utc)
        self.assertFalse(consumer.is_within_work_window(schedule, dt_boundary))

        # 12:00 UTC -> midday -> outside
        dt_outside = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)
        self.assertFalse(consumer.is_within_work_window(schedule, dt_outside))

    def test_daytime_window(self) -> None:
        schedule = {"work_window": "09:00-17:00"}
        dt_inside = datetime(2026, 10, 27, 10, 30, tzinfo=timezone.utc)
        self.assertTrue(consumer.is_within_work_window(schedule, dt_inside))

        dt_outside = datetime(2026, 10, 27, 18, 0, tzinfo=timezone.utc)
        self.assertFalse(consumer.is_within_work_window(schedule, dt_outside))


class BaseBranchTests(unittest.TestCase):
    def test_archon_loop_defaults_to_develop(self) -> None:
        base = consumer.base_branch(Path("/dummy"), {"workflow": "archon-loop"})
        self.assertEqual(base, "develop")

    def test_custom_base_branch_preserved(self) -> None:
        base = consumer.base_branch(Path("/dummy"), {"workflow": "archon-loop", "base_branch": "feature-base"})
        self.assertEqual(base, "feature-base")


class LaunchDecisionGatingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        subprocess.run(["git", "init", "-b", "main"], cwd=self.root, check=True, capture_output=True)
        (self.root / ".factory").mkdir(parents=True, exist_ok=True)

        self.logs: list[str] = []
        self.write = self.logs.append

        self.settings = {"bun": "bun"}
        self.source = self.root

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def setup_trigger(self, workflow: str = "archon-loop") -> None:
        trigger = {
            "version": 1,
            "binding": {
                "resource": f"github:test:{workflow}",
                "capacity": 2,
                "launch": {
                    "workflowName": workflow,
                    "inputs": {},
                },
            },
        }
        (self.root / ".factory/trigger.json").write_text(json.dumps(trigger), encoding="utf-8")

    def test_pause_blocks_launch(self) -> None:
        (self.root / ".factory/PAUSE").write_text("freeze", encoding="utf-8")
        self.setup_trigger()

        decision = consumer.launch_decision(self.root, self.settings, self.source, self.write)
        self.assertFalse(decision)
        self.assertTrue(any(".factory/PAUSE is set" in line for line in self.logs))

    def test_outside_work_window_blocks_launch(self) -> None:
        self.setup_trigger()
        schedule = {"work_window": {"start": "20:00", "end": "05:00", "timezone": "UTC"}}
        (self.root / ".factory/schedule.json").write_text(json.dumps(schedule), encoding="utf-8")

        # 12:00 UTC is outside 20:00-05:00
        midday = datetime(2026, 10, 27, 12, 0, tzinfo=timezone.utc)
        decision = consumer.launch_decision(self.root, self.settings, self.source, self.write, now_dt=midday)
        self.assertFalse(decision)
        self.assertTrue(any("outside configured work window" in line for line in self.logs))

    def test_no_admitted_issue_blocks_launch(self) -> None:
        self.setup_trigger()
        mock_intake = MagicMock(spec=IntakeService)
        mock_intake.get_next_admitted.return_value = None

        decision = consumer.launch_decision(
            self.root, self.settings, self.source, self.write,
            now_dt=datetime(2026, 10, 27, 21, 0, tzinfo=timezone.utc),
            intake_service=mock_intake,
        )
        self.assertFalse(decision)
        self.assertTrue(any("no admitted issues in backlog" in line for line in self.logs))

    def test_admitted_issue_binds_target_to_trigger(self) -> None:
        self.setup_trigger()
        mock_intake = MagicMock(spec=IntakeService)
        mock_intake.get_next_admitted.return_value = 42

        decision = consumer.launch_decision(
            self.root, self.settings, self.source, self.write,
            now_dt=datetime(2026, 10, 27, 21, 0, tzinfo=timezone.utc),
            intake_service=mock_intake,
        )
        self.assertTrue(decision)
        self.assertTrue(any("target #42 bound" in line for line in self.logs))

        # Verify trigger.json has inputs.target set to "#42"
        saved_trigger = json.loads((self.root / ".factory/trigger.json").read_text(encoding="utf-8"))
        self.assertEqual(saved_trigger["binding"]["launch"]["inputs"]["target"], "#42")


if __name__ == "__main__":
    unittest.main()
