"""Native read boundary and HTTP lap behavior without launching workflows."""
from __future__ import annotations

from copy import deepcopy
from http.server import HTTPServer
import json
from pathlib import Path
import subprocess
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

from app import handler
from laps import NativeLaps, project_lap


HEAD = "a" * 40
PR = "https://github.com/org/repo/pull/7"
FIRST = "11111111-1111-1111-1111-111111111111"
SECOND = "22222222-2222-2222-2222-222222222222"


def record(run_id: str = FIRST, status: str = "completed") -> dict:
    run = {"id": run_id, "workflow_name": "archon-loop", "status": status,
           "metadata": {"inputs": {"merge": "approve"}},
           "working_path": f"/worktrees/{run_id}", "conversation_id": f"session-{run_id}",
           "checkout_baseline": {"commit": "b" * 40},
           "started_at": "2026-10-26T08:00:00Z", "completed_at": "2026-10-26T08:10:00Z",
           "events": []}
    for node, output in (("subject", {"pr": PR, "head": HEAD}),
                         ("check-app", {"pr": PR, "head": HEAD, "overall": "PASS"}),
                         ("evidence", {"ok": "true"}),
                         ("review", {"pr": PR, "sha": HEAD, "outcome": "approved"}),
                         ("land", {})):
        order = len(run["events"]) + 1
        run["events"].append({
            "id": f"{run_id}-{order}", "workflow_run_id": run_id, "event_order": order,
            "event_type": "node_skipped" if node == "land" else "node_completed",
            "step_name": node, "created_at": f"2026-10-26T08:0{order}:00Z",
            "data": {"structured_output": output,
                     "attempt": {"checkoutStart": {"kind": "git", "commit": HEAD}},
                     "session_id": f"agent-{run_id}"}})
    return run


class LapHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.runs = [record()]
        self.calls = []
        self.failure = None
        self.listing = None
        self.native = patch("laps.native_json", side_effect=self.query).start()
        self.addCleanup(patch.stopall)
        patch("laps.read_settings", return_value={}).start()
        patch("laps.verify_source", return_value=Path("/pin")).start()
        self.server = HTTPServer(("127.0.0.1", 0), handler("candidate", NativeLaps(Path.cwd())))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop)
        self.http = build_opener(ProxyHandler({}))

    def stop(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())

    def query(self, settings: dict, source: Path, args: list[str], root: Path) -> dict:
        self.calls.append(args)
        if self.failure:
            raise self.failure
        if args[:2] == ["workflow", "runs"]:
            return self.listing if self.listing is not None else {"runs": self.runs}
        self.assertEqual(args[:2], ["workflow", "get"])
        self.assertEqual(args[3:], ["--verbose", "--events"])
        return deepcopy(next(run for run in self.runs if run["id"] == args[2]))

    def get(self, path: str) -> tuple[int, object]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        try:
            response = self.http.open(url, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Content-Type"], "application/json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.loads(response.read())

    def test_empty_and_other_workflows(self) -> None:
        for runs in ([], [{**record(), "workflow_name": "archon-backlog"}]):
            self.runs = runs
            self.assertEqual(self.get("/api/laps"), (200, []))
        self.assertEqual(self.get(f"/api/laps/{FIRST}")[0], 404)
        self.listing = {"runs": [], "scopeFallback": True}
        self.assertEqual(self.get("/api/laps"), (200, []))

    def test_native_statuses_are_not_success(self) -> None:
        for status in ("pending", "running", "failed", "cancelled", "completed"):
            with self.subTest(status=status):
                run = record(status=status)
                run["events"] = []
                self.runs = [run]
                code, body = self.get(f"/api/laps/{FIRST}")
                self.assertEqual(code, 200)
                self.assertEqual(body["native_status"], status)
                self.assertEqual(body["product_status"], status)
                self.assertEqual(body["id"], FIRST)
                self.assertEqual(body["session"]["working_path"], f"/worktrees/{FIRST}")

    def test_list_detail_and_ten_polls_are_isolated_and_read_only(self) -> None:
        self.runs = [record(FIRST), record(SECOND, "running")]
        for _ in range(10):
            status, rows = self.get("/api/laps")
            self.assertEqual(status, 200)
            self.assertEqual([row["id"] for row in rows], [FIRST, SECOND])
            for run_id, other in ((FIRST, SECOND), (SECOND, FIRST)):
                status, detail = self.get(f"/api/laps/{run_id}")
                self.assertEqual(status, 200)
                self.assertEqual(detail, next(row for row in rows if row["id"] == run_id))
                self.assertNotIn(other, json.dumps(detail))
        self.assertTrue(self.calls)
        self.assertTrue(all(call[:2] in (["workflow", "runs"], ["workflow", "get"])
                            for call in self.calls))

    def test_unknown_and_invalid_ids(self) -> None:
        for value in (SECOND, "--all", "../health", "", FIRST + "/extra"):
            with self.subTest(value=value):
                self.assertEqual(self.get("/api/laps/" + value), (404, {"error": "lap_not_found"}))

    def test_engine_failures_are_unavailable_not_empty_or_not_found(self) -> None:
        for error in (ValueError("token=private"), OSError("private"),
                      subprocess.TimeoutExpired("private", 1)):
            self.failure = error
            for path in ("/api/laps", f"/api/laps/{FIRST}", f"/api/laps/{SECOND}"):
                self.assertEqual(self.get(path), (503, {"error": "native_state_unavailable"}))
        self.failure = None
        for listing in ({}, {"runs": [record()], "scopeFallback": True}):
            self.listing = listing
            self.assertEqual(self.get("/api/laps")[0], 503)

    def test_detail_identity_and_event_identity_mismatch_fail_closed(self) -> None:
        self.runs[0]["events"][0]["workflow_run_id"] = SECOND
        self.assertEqual(self.get(f"/api/laps/{FIRST}")[0], 503)
        with patch("laps.native_json", side_effect=[{"runs": [record()]}, record(SECOND)]):
            self.assertEqual(self.get(f"/api/laps/{FIRST}")[0], 503)


class ApprovalTests(unittest.TestCase):
    def test_current_head_evidence_only(self) -> None:
        result = project_lap(record())
        self.assertEqual(result["native_status"], "completed")
        self.assertEqual(result["product_status"], "waiting_approval")
        self.assertEqual(result["candidate_head"], HEAD)
        self.assertEqual(result["approval_evidence"]["head"], HEAD)
        self.assertEqual(result["approval_evidence"]["events"]["review"]["id"], f"{FIRST}-4")
        self.assertEqual(len(result["transitions"]), 5)

    def test_stale_incomplete_or_non_supervised_evidence_does_not_approve(self) -> None:
        mutations = [
            ("review", "sha", "c" * 40), ("subject", "head", "c" * 40),
            ("check-app", "head", "c" * 40), ("check-app", "overall", "FAIL"),
            ("evidence", "ok", "false"), ("review", "outcome", "merge"),
            ("review", "pr", PR + "1"), ("check-app", "pr", PR + "1"),
        ]
        for node, key, value in mutations:
            with self.subTest(node=node, key=key):
                run = record()
                next(e for e in run["events"] if e["step_name"] == node)["data"]["structured_output"][key] = value
                self.assertEqual(project_lap(run)["product_status"], "completed")
        for node in ("subject", "check-app", "evidence", "review", "land"):
            for kind in ("node_started", "node_failed"):
                with self.subTest(node=node, kind=kind):
                    run = record()
                    next(e for e in run["events"] if e["step_name"] == node)["event_type"] = kind
                    self.assertEqual(project_lap(run)["product_status"], "completed")
        for mode in (None, "auto"):
            run = record()
            run["metadata"]["inputs"]["merge"] = mode
            self.assertEqual(project_lap(run)["product_status"], "completed")
        for status in ("pending", "failed", "cancelled"):
            self.assertEqual(project_lap(record(status=status))["product_status"], status)

    def test_later_candidate_or_restarted_review_invalidates_approval(self) -> None:
        for node, head in (("release", "c" * 40), ("review", HEAD)):
            run = record()
            event = deepcopy(run["events"][0])
            event.update(event_order=6, event_type="node_started", step_name=node)
            event["data"]["attempt"]["checkoutStart"]["commit"] = head
            run["events"].append(event)
            self.assertEqual(project_lap(run)["product_status"], "completed")

    def test_native_land_prevents_waiting_even_if_later_skipped(self) -> None:
        run = record()
        event = deepcopy(run["events"][-1])
        event.update(event_type="node_completed", event_order=0)
        run["events"].insert(0, event)
        self.assertEqual(project_lap(run)["product_status"], "completed")

    def test_no_raw_prose_credentials_or_holdout_contents(self) -> None:
        run = record()
        secret = "DO-NOT-EXPOSE-PRIVATE-CONTENTS"
        run.update(user_message=secret, transcript_path=secret)
        run["metadata"]["password"] = secret
        run["events"][0]["data"]["structured_output"]["private_holdout"] = secret
        run["events"][0]["data"]["node_output"] = secret
        run["working_path"] = "/work/token=private/ghp_privatecredential"
        run["events"][0]["data"]["structured_output"]["pr"] = "https://user:password@github.com/o/r/pull/7?token=private"
        encoded = json.dumps(project_lap(run))
        for value in (secret, "user:password", "privatecredential", "token=private"):
            self.assertNotIn(value, encoded)
        self.assertIn("[redacted]", encoded)


if __name__ == "__main__":
    unittest.main()
