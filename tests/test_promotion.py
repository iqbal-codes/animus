"""Unit and HTTP tests for the promotion engine and configuration endpoints."""
from __future__ import annotations

import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import HTTPServer
from unittest.mock import MagicMock
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from app import handler
from laps import NativeLaps
from promotion import (
    NoUnpromotedCommitsError,
    PromotionExecutionError,
    PromotionPROverlapError,
    PromotionService,
    read_models_config,
    read_schedule_config,
)


class PromotionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / ".factory").mkdir(parents=True, exist_ok=True)
        (self.root / ".archon").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_config_readers(self) -> None:
        # Schedule config
        (self.root / ".factory/schedule.json").write_text('{"parallel": 2, "base_branch": "develop"}', encoding="utf-8")
        sched = read_schedule_config(self.root)
        self.assertEqual(sched.get("parallel"), 2)
        self.assertEqual(sched.get("base_branch"), "develop")

        # Models config
        yaml_content = """
tiers:
  large:
    provider: pi
    model: router/ag/gemini-3.8-flash
aliases:
  '@reasoning':
    provider: pi
    model: router/ag/gemini-3.8-flash
"""
        (self.root / ".archon/config.yaml").write_text(yaml_content, encoding="utf-8")
        models = read_models_config(self.root)
        self.assertIn("tiers", models)
        self.assertEqual(models["tiers"]["large"]["model"], "router/ag/gemini-3.8-flash")
        self.assertEqual(models["aliases"]["@reasoning"]["model"], "router/ag/gemini-3.8-flash")

    def test_get_status_with_unpromoted_commits(self) -> None:
        def mock_runner(cmd: list[str], cwd: Path) -> str:
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return (
                    "aaa1111|feat: implement webhook verify (#42)|Alice|2026-10-27T01:00:00Z\n"
                    "bbb2222|fix: handle rate limit (#43)|Bob|2026-10-27T02:00:00Z\n"
                )
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        status = service.get_status()

        self.assertEqual(status["unpromoted_count"], 2)
        self.assertEqual(status["delivered_tickets"], [42, 43])
        self.assertFalse(status["candidate_freeze"])
        self.assertIsNone(status["existing_pr"])
        self.assertTrue(status["ready_to_promote"])

    def test_prepare_promotion_happy_path(self) -> None:
        executed_cmds: list[list[str]] = []

        def mock_runner(cmd: list[str], cwd: Path) -> str:
            executed_cmds.append(cmd)
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return "aaa1111|feat: implement webhook verify (#42)|Alice|2026-10-27T01:00:00Z\n"
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            if cmd[:3] == ["gh", "pr", "create"]:
                return "https://github.com/org/repo/pull/99\n"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        res = service.prepare_promotion()

        self.assertEqual(res["pr_number"], 99)
        self.assertEqual(res["pr_url"], "https://github.com/org/repo/pull/99")
        self.assertTrue(res["candidate_freeze"])

        # Candidate Freeze flag .factory/PAUSE must now exist
        pause_file = self.root / ".factory/PAUSE"
        self.assertTrue(pause_file.is_file())
        self.assertIn("promotion PR #99", pause_file.read_text(encoding="utf-8"))

        # Verify gh pr create command was called with proper branches
        create_calls = [c for c in executed_cmds if c[:3] == ["gh", "pr", "create"]]
        self.assertEqual(len(create_calls), 1)
        cmd = create_calls[0]
        self.assertIn("--base", cmd)
        self.assertEqual(cmd[cmd.index("--base") + 1], "main")
        self.assertIn("--head", cmd)
        self.assertEqual(cmd[cmd.index("--head") + 1], "develop")

    def test_prepare_promotion_fails_when_zero_commits(self) -> None:
        def mock_runner(cmd: list[str], cwd: Path) -> str:
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return ""  # 0 commits
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        with self.assertRaises(NoUnpromotedCommitsError):
            service.prepare_promotion()

    def test_prepare_promotion_fails_when_pr_already_open(self) -> None:
        def mock_runner(cmd: list[str], cwd: Path) -> str:
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return "aaa1111|feat: something (#1)|Dev|2026-10-27T01:00:00Z\n"
            if cmd[:3] == ["gh", "pr", "list"]:
                return json.dumps([{"number": 77, "url": "https://github.com/org/repo/pull/77", "title": "Batch PR"}])
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        with self.assertRaises(PromotionPROverlapError):
            service.prepare_promotion()

    def test_prepare_promotion_includes_harness_summary_when_present(self) -> None:
        executed_cmds: list[list[str]] = []

        def mock_runner(cmd: list[str], cwd: Path) -> str:
            executed_cmds.append(cmd)
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return "aaa1111|feat: improve memory (#21)|Dev|2026-10-27T01:00:00Z\n"
            if cmd[:2] == ["git", "diff"]:
                return (
                    "diff --git a/.factory/lessons.jsonl b/.factory/lessons.jsonl\n"
                    "--- a/.factory/lessons.jsonl\n"
                    "+++ b/.factory/lessons.jsonl\n"
                    '+{"id": "lsn-20261027-01", "topic": "test-run", "rule": "Use offline mock transport.", "evidence": "Lap logs."}\n'
                    "diff --git a/.factory/tool-guidance.json b/.factory/tool-guidance.json\n"
                    "--- a/.factory/tool-guidance.json\n"
                    "+++ b/.factory/tool-guidance.json\n"
                    '+  "test": "pytest -v"\n'
                )
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            if cmd[:3] == ["gh", "pr", "create"]:
                return "https://github.com/org/repo/pull/101\n"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        res = service.prepare_promotion()
        self.assertEqual(res["pr_number"], 101)

        create_calls = [c for c in executed_cmds if c[:3] == ["gh", "pr", "create"]]
        self.assertEqual(len(create_calls), 1)
        body = create_calls[0][create_calls[0].index("--body") + 1]

        self.assertIn("## Harness Evolution Summary", body)
        self.assertIn("### New Lessons", body)
        self.assertIn("**lsn-20261027-01** (`test-run`): Use offline mock transport.", body)
        self.assertIn("### Tool Guidance Updates", body)
        self.assertIn("`test`: `pytest -v`", body)

    def test_prepare_promotion_excludes_vetoed_lessons_from_summary(self) -> None:
        executed_cmds: list[list[str]] = []

        def mock_runner(cmd: list[str], cwd: Path) -> str:
            executed_cmds.append(cmd)
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return "aaa1111|feat: vetoed lesson (#21)|Dev|2026-10-27T01:00:00Z\n"
            if cmd[:2] == ["git", "diff"]:
                return (
                    "diff --git a/.factory/lessons.jsonl b/.factory/lessons.jsonl\n"
                    "--- a/.factory/lessons.jsonl\n"
                    "+++ b/.factory/lessons.jsonl\n"
                    '+{"id": "lsn-20261027-09", "topic": "bad-rule", "rule": "Never do this.", "vetoed": true}\n'
                )
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            if cmd[:3] == ["gh", "pr", "create"]:
                return "https://github.com/org/repo/pull/103\n"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        res = service.prepare_promotion()
        self.assertEqual(res["pr_number"], 103)

        create_calls = [c for c in executed_cmds if c[:3] == ["gh", "pr", "create"]]
        body = create_calls[0][create_calls[0].index("--body") + 1]
        self.assertNotIn("lsn-20261027-09", body)

    def test_prepare_promotion_handles_harness_summary_when_absent(self) -> None:
        executed_cmds: list[list[str]] = []

        def mock_runner(cmd: list[str], cwd: Path) -> str:
            executed_cmds.append(cmd)
            if cmd[:3] == ["git", "rev-parse", "--verify"]:
                return "abc1234"
            if cmd[:2] == ["git", "log"]:
                return "aaa1111|feat: ordinary work (#21)|Dev|2026-10-27T01:00:00Z\n"
            if cmd[:2] == ["git", "diff"]:
                return ""  # No changes in .factory/
            if cmd[:3] == ["gh", "pr", "list"]:
                return "[]"
            if cmd[:3] == ["gh", "pr", "create"]:
                return "https://github.com/org/repo/pull/102\n"
            return ""

        service = PromotionService(self.root, runner=mock_runner)
        res = service.prepare_promotion()
        self.assertEqual(res["pr_number"], 102)

        create_calls = [c for c in executed_cmds if c[:3] == ["gh", "pr", "create"]]
        self.assertEqual(len(create_calls), 1)
        body = create_calls[0][create_calls[0].index("--body") + 1]

        # Invariant: PR description generates cleanly without breaking
        self.assertIn("## Release Promotion", body)


class PromotionHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))
        self.mock_laps = MagicMock(spec=NativeLaps)
        self.mock_laps.root = Path(__file__).resolve().parents[1]
        self.mock_promotion = MagicMock(spec=PromotionService)

        handler_cls = handler("candidate-test", self.mock_laps, promotion=self.mock_promotion)
        self.server = HTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def get(self, path: str) -> tuple[int, dict]:
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with self.http.open(url, timeout=2.0) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except HTTPError as err:
            return err.status, json.loads(err.read().decode("utf-8"))

    def post(self, path: str, payload: dict | None = None) -> tuple[int, dict]:
        url = f"http://127.0.0.1:{self.port}{path}"
        body = json.dumps(payload).encode("utf-8") if payload else b""
        headers = {"Content-Type": "application/json"} if payload else {}
        req = Request(url, data=body, headers=headers, method="POST")
        try:
            with self.http.open(req, timeout=2.0) as res:
                return res.status, json.loads(res.read().decode("utf-8"))
        except HTTPError as err:
            return err.status, json.loads(err.read().decode("utf-8"))

    def test_get_promotion_status(self) -> None:
        self.mock_promotion.get_status.return_value = {
            "main_branch": "main",
            "develop_branch": "develop",
            "unpromoted_count": 3,
            "delivered_tickets": [10, 11],
            "candidate_freeze": False,
            "existing_pr": None,
            "ready_to_promote": True,
        }
        status, body = self.get("/api/promotion/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["unpromoted_count"], 3)
        self.assertEqual(body["delivered_tickets"], [10, 11])

    def test_post_promotion_prepare_success(self) -> None:
        self.mock_promotion.prepare_promotion.return_value = {
            "pr_number": 88,
            "pr_url": "https://github.com/org/repo/pull/88",
            "title": "chore(release): promote develop to main",
            "unpromoted_count": 3,
            "candidate_freeze": True,
        }
        status, body = self.post("/api/promotion/prepare", {"title": "Custom Title"})
        self.assertEqual(status, 201)
        self.assertEqual(body["pr_number"], 88)
        self.assertTrue(body["candidate_freeze"])
        self.mock_promotion.prepare_promotion.assert_called_with(title="Custom Title", summary=None)

    def test_post_promotion_prepare_zero_commits_409(self) -> None:
        self.mock_promotion.prepare_promotion.side_effect = NoUnpromotedCommitsError("0 commits")
        status, body = self.post("/api/promotion/prepare")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "no_unpromoted_commits")

    def test_post_promotion_prepare_already_open_409(self) -> None:
        self.mock_promotion.prepare_promotion.side_effect = PromotionPROverlapError("Already open")
        status, body = self.post("/api/promotion/prepare")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"], "promotion_pr_already_open")

    def test_get_config_endpoints(self) -> None:
        status, sched = self.get("/api/config/schedule")
        self.assertEqual(status, 200)
        self.assertIsInstance(sched, dict)

        status, models = self.get("/api/config/models")
        self.assertEqual(status, 200)
        self.assertIsInstance(models, dict)
        self.assertIn("tiers", models)


if __name__ == "__main__":
    unittest.main()
