"""Native read boundary and HTTP lap behavior without launching workflows."""
from __future__ import annotations

from copy import deepcopy
from http.server import HTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from app import handler
from laps import NativeLaps, NativeStateError, ReportNotFound, project_evidence, project_lap


HEAD = "a" * 40
PR = "https://github.com/org/repo/pull/7"
FIRST = "11111111-1111-1111-1111-111111111111"
SECOND = "22222222-2222-2222-2222-222222222222"
HEX32 = "422f3cf268fde7a9044739a93e3479d2"


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

    def test_thirty_two_character_hex_run_id_retrieval(self) -> None:
        self.runs = [record(HEX32)]
        code, body = self.get(f"/api/laps/{HEX32}")
        self.assertEqual(code, 200)
        self.assertEqual(body["id"], HEX32)
        self.assertEqual(body["session"]["working_path"], f"/worktrees/{HEX32}")

    def test_unknown_and_invalid_ids(self) -> None:
        for value in (SECOND, "--all", "../health", "", FIRST + "/extra",
                      HEX32[:31], HEX32 + "a" * 5, "z" * 32, "0" * 32):
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


class LapSubmissionHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.temp_root = Path(self.temp_dir.name).resolve()
        (self.temp_root / "harness").mkdir(parents=True, exist_ok=True)
        (self.temp_root / "harness/harness.config.json").write_text(
            json.dumps({"protected_paths": "MISSION.md,FACTORY.md"}),
            encoding="utf-8",
        )
        self.execute_calls = []
        self.execute_returncode = 0
        self.execute_stdout = json.dumps({
            "ok": True,
            "action": "run",
            "detached": True,
            "runId": FIRST,
            "workflow": "archon-loop",
            "branch": "archon/lap-test",
            "status": "pending",
        })
        self.execute_stderr = ""
        self.execute_side_effect = None

        def fake_execute(argv, cwd, **kwargs):
            self.execute_calls.append((argv, cwd, kwargs))
            if self.execute_side_effect:
                raise self.execute_side_effect
            return subprocess.CompletedProcess(argv, self.execute_returncode, self.execute_stdout, self.execute_stderr)

        patch("laps.execute", side_effect=fake_execute).start()
        patch("laps.shared_root", return_value=self.temp_root).start()
        patch("laps.read_settings", return_value={"bun": "bun"}).start()
        patch("laps.verify_source", return_value=Path("/pin")).start()
        self.addCleanup(patch.stopall)

        self.server = HTTPServer(("127.0.0.1", 0), handler("candidate", NativeLaps(self.temp_root)))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop)
        self.http = build_opener(ProxyHandler({}))

    def stop(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())

    def post(self, path: str, payload: bytes | str | dict | None = None) -> tuple[int, object]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        if isinstance(payload, dict):
            data = json.dumps(payload).encode("utf-8")
        elif isinstance(payload, str):
            data = payload.encode("utf-8")
        elif isinstance(payload, bytes):
            data = payload
        else:
            data = b""
        request = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            response = self.http.open(request, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Content-Type"], "application/json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.loads(response.read().decode("utf-8"))

    def test_valid_submission_starts_exactly_one_invocation_and_returns_genuine_run_id(self) -> None:
        status, body = self.post("/api/laps", {"specification": "Fix login bug", "merge_mode": "approve"})
        self.assertEqual(status, 202)
        self.assertEqual(body, {"id": FIRST, "status": "pending"})
        self.assertEqual(len(self.execute_calls), 1)
        argv, cwd, _ = self.execute_calls[0]
        self.assertEqual(cwd, self.temp_root)
        self.assertIn("workflow", argv)
        self.assertIn("run", argv)
        self.assertIn("archon-loop", argv)
        self.assertIn("--detach", argv)
        self.assertIn("--json", argv)
        self.assertIn("merge=approve", argv)
        self.assertIn("holdout=.factory/holdout/HOLDOUT.md", " ".join(argv))
        self.assertIn("protected_paths=", " ".join(argv))
        self.assertTrue(any(arg.startswith("archon/lap-") for arg in argv))
        self.assertTrue(any(arg.startswith("session-") for arg in argv))
        self.assertEqual(argv[argv.index("--") + 1:], ["Fix login bug"])

    def test_two_accepted_launches_use_distinct_branch_and_session(self) -> None:
        status1, body1 = self.post("/api/laps", {"specification": "Task 1", "merge_mode": "approve"})
        self.assertEqual(status1, 202)
        self.assertEqual(body1["id"], FIRST)

        self.execute_stdout = json.dumps({
            "ok": True,
            "action": "run",
            "detached": True,
            "runId": SECOND,
            "workflow": "archon-loop",
            "branch": "archon/lap-second",
            "status": "pending",
        })
        status2, body2 = self.post("/api/laps", {"specification": "Task 2", "merge_mode": "approve"})
        self.assertEqual(status2, 202)
        self.assertEqual(body2["id"], SECOND)

        self.assertEqual(len(self.execute_calls), 2)
        argv1 = self.execute_calls[0][0]
        argv2 = self.execute_calls[1][0]
        branch1 = argv1[argv1.index("--branch") + 1]
        branch2 = argv2[argv2.index("--branch") + 1]
        conv1 = argv1[argv1.index("--conversation-id") + 1]
        conv2 = argv2[argv2.index("--conversation-id") + 1]

        self.assertNotEqual(branch1, branch2)
        self.assertNotEqual(conv1, conv2)
        self.assertTrue(branch1.startswith("archon/lap-"))
        self.assertTrue(branch2.startswith("archon/lap-"))
        self.assertTrue(conv1.startswith("session-"))
        self.assertTrue(conv2.startswith("session-"))

    def test_submission_returns_32_character_hex_run_id(self) -> None:
        self.execute_stdout = json.dumps({
            "ok": True,
            "action": "run",
            "detached": True,
            "runId": HEX32,
            "workflow": "archon-loop",
            "branch": "archon/lap-test-hex32",
            "status": "pending",
        })
        status, body = self.post("/api/laps", {"specification": "Hex32 task", "merge_mode": "approve"})
        self.assertEqual(status, 202)
        self.assertEqual(body, {"id": HEX32, "status": "pending"})

    def test_rejection_of_invalid_and_override_payloads(self) -> None:
        invalid_cases = [
            {"specification": "", "merge_mode": "approve"},
            {"specification": "   \n\t  ", "merge_mode": "approve"},
            {"specification": 123, "merge_mode": "approve"},
            {"merge_mode": "approve"},
            {"specification": "valid", "merge_mode": "auto"},
            {"specification": "valid", "merge_mode": "direct"},
            {"specification": "valid"},
            {"specification": "valid", "merge_mode": "approve", "launch": "override"},
            {"specification": "valid", "merge_mode": "approve", "source": "/evil"},
            {"specification": "valid", "merge_mode": "approve", "identity": "fake"},
            {"specification": "valid", "merge_mode": "approve", "branch": "custom"},
            {"specification": "valid", "merge_mode": "approve", "conversation_id": "custom"},
            {"specification": "valid", "merge_mode": "approve", "workflow": "other"},
            b"{",
            b"",
            b"not json",
            b"[1, 2, 3]",
        ]
        for payload in invalid_cases:
            with self.subTest(payload=payload):
                status, body = self.post("/api/laps", payload)
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "invalid_payload"})
        self.assertEqual(len(self.execute_calls), 0)

    def test_shell_metacharacters_remain_literal_in_specification(self) -> None:
        shell_spec = 'Fix $(whoami) & `rm -rf /` ; echo "test" | cat > /tmp/out; rm $HOME && ${PATH}'
        status, body = self.post("/api/laps", {"specification": shell_spec, "merge_mode": "approve"})
        self.assertEqual(status, 202)
        self.assertEqual(len(self.execute_calls), 1)
        argv = self.execute_calls[0][0]
        self.assertEqual(argv[argv.index("--") + 1:], [shell_spec])

    def test_launch_brake_refusal(self) -> None:
        stop_file = self.temp_root / ".factory/STOP"
        stop_file.parent.mkdir(parents=True, exist_ok=True)
        stop_file.write_text("Operator halted.\n", encoding="utf-8")

        status, body = self.post("/api/laps", {"specification": "Fix bug", "merge_mode": "approve"})
        self.assertEqual(status, 409)
        self.assertEqual(body, {"error": "launch_brake_set"})
        self.assertEqual(len(self.execute_calls), 0)
        self.assertTrue(stop_file.exists())

    def test_nonzero_native_exit_fails_closed(self) -> None:
        self.execute_returncode = 1
        self.execute_stdout = ""
        self.execute_stderr = "Native engine error: failed to initialize"

        status, body = self.post("/api/laps", {"specification": "Fix bug", "merge_mode": "approve"})
        self.assertEqual(status, 502)
        self.assertEqual(body, {"error": "launch_process_failed"})
        self.assertNotIn("id", body)

    def test_malformed_launch_output_fails_closed(self) -> None:
        malformed_outputs = [
            "",
            "Plain text not json",
            json.dumps({"ok": False, "error": "native failure"}),
            json.dumps({"ok": True, "action": "run"}),
            json.dumps({"ok": True, "runId": ""}),
            json.dumps({"ok": True, "runId": 12345}),
        ]
        for stdout in malformed_outputs:
            with self.subTest(stdout=stdout):
                self.execute_calls.clear()
                self.execute_stdout = stdout
                status, body = self.post("/api/laps", {"specification": "Fix bug", "merge_mode": "approve"})
                self.assertEqual(status, 502)
                self.assertEqual(body, {"error": "launch_process_failed"})
                self.assertNotIn("id", body)

    def test_native_state_unavailable_on_settings_error(self) -> None:
        with patch("laps.read_settings", side_effect=ValueError("bad pin")):
            status, body = self.post("/api/laps", {"specification": "Fix bug", "merge_mode": "approve"})
            self.assertEqual(status, 503)
            self.assertEqual(body, {"error": "native_state_unavailable"})

    def test_unknown_post_path_is_404(self) -> None:
        for path in ("/api/laps/123", "/api/unknown", "/api/laps/"):
            with self.subTest(path=path):
                url = f"http://127.0.0.1:{self.server.server_port}{path}"
                request = Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
                with self.assertRaises(HTTPError) as ctx:
                    self.http.open(request, timeout=2)
                self.assertEqual(ctx.exception.code, 404)
                ctx.exception.close()


def evidence_record(run_id: str = FIRST, head: str = HEAD, check_head: str = HEAD,
                    review_sha: str = HEAD, check_overall: str = "PASS", evidence_ok: str = "true",
                    review_outcome: str = "approved", builder_session: str | None = "builder-1",
                    reviewer_session: str | None = "reviewer-2", dispositions: list | None = None,
                    lines: list | None = None) -> dict:
    default_lines = [
        {"id": "C1", "kind": "criterion", "verdict": "PASS", "text": "App check passed"},
        {"id": "P1", "kind": "probe", "verdict": "OK", "text": "Health probe OK"},
        {"id": "H1", "kind": "holdout", "verdict": "PASS", "scenario": "secret private scenario text"},
    ]
    run = {
        "id": run_id, "workflow_name": "archon-loop", "status": "completed",
        "metadata": {"inputs": {"merge": "approve"}},
        "working_path": f"/worktrees/{run_id}", "conversation_id": f"session-{run_id}",
        "checkout_baseline": {"commit": "b" * 40},
        "started_at": "2026-10-26T08:00:00Z", "completed_at": "2026-10-26T08:10:00Z",
        "events": [],
    }
    steps = [
        ("build", {}, builder_session),
        ("subject", {"pr": PR, "head": head}, None),
        ("check-app", {"pr": PR, "head": check_head, "overall": check_overall, "lines": lines if lines is not None else default_lines}, "tester-1"),
        ("evidence", {"ok": evidence_ok}, None),
        ("review", {"pr": PR, "sha": review_sha, "outcome": review_outcome, "dispositions": dispositions if dispositions is not None else []}, reviewer_session),
        ("land", {}, None),
    ]
    for order, (node, output, sess) in enumerate(steps, start=1):
        ev = {
            "id": f"{run_id}-{order}", "workflow_run_id": run_id, "event_order": order,
            "event_type": "node_skipped" if node == "land" else "node_completed",
            "step_name": node, "created_at": f"2026-10-26T08:0{order}:00Z",
            "data": {
                "structured_output": output,
                "attempt": {"checkoutStart": {"kind": "git", "commit": head}},
            },
        }
        if sess:
            ev["data"]["session_id"] = sess
        run["events"].append(ev)
    return run


class EvidenceProjectionTests(unittest.TestCase):
    def test_matching_verified_runtime_report(self) -> None:
        proj = project_evidence(evidence_record())
        self.assertEqual(proj["id"], FIRST)
        self.assertEqual(proj["workflow_name"], "archon-loop")
        self.assertEqual(proj["candidate_head"], HEAD)
        rv = proj["runtime_verification"]
        self.assertEqual(rv["status"], "verified")
        self.assertEqual(rv["verdict"], "PASS")
        self.assertEqual(rv["lines"], [
            {"id": "C1", "kind": "criterion", "verdict": "PASS"},
            {"id": "P1", "kind": "probe", "verdict": "OK"},
        ])
        self.assertEqual(rv["holdout"], {
            "verdict": "PASS",
            "lines": [{"id": "H1", "verdict": "PASS"}],
        })
        self.assertNotIn("secret private scenario text", json.dumps(proj))

    def test_failed_runtime_report(self) -> None:
        for check_overall, ev_ok in (("FAIL", "true"), ("PASS", "false"), ("FAIL", "false")):
            with self.subTest(check_overall=check_overall, ev_ok=ev_ok):
                proj = project_evidence(evidence_record(check_overall=check_overall, evidence_ok=ev_ok))
                self.assertEqual(proj["runtime_verification"]["status"], "failed")
                self.assertEqual(proj["runtime_verification"]["verdict"], "FAIL")
                self.assertEqual(proj["peer_review"]["status"], "not_ready")

    def test_inconclusive_runtime_report_on_head_mismatch(self) -> None:
        other_head = "c" * 40
        proj = project_evidence(evidence_record(check_head=other_head))
        self.assertEqual(proj["runtime_verification"]["status"], "inconclusive")
        self.assertIsNone(proj["runtime_verification"]["verdict"])
        self.assertNotEqual(proj["runtime_verification"]["status"], "verified")
        self.assertEqual(proj["peer_review"]["status"], "not_ready")

    def test_absent_runtime_report(self) -> None:
        run = evidence_record()
        run["events"] = [e for e in run["events"] if e["step_name"] not in ("check-app", "evidence")]
        proj = project_evidence(run)
        self.assertEqual(proj["runtime_verification"]["status"], "absent")
        self.assertIsNone(proj["runtime_verification"]["verdict"])
        self.assertEqual(proj["runtime_verification"]["lines"], [])
        self.assertEqual(proj["runtime_verification"]["holdout"], {"verdict": None, "lines": []})
        self.assertNotEqual(proj["runtime_verification"]["status"], "verified")
        self.assertEqual(proj["peer_review"]["status"], "not_ready")

    def test_holdout_failure_causes_runtime_verification_failed(self) -> None:
        failing_holdout = [
            {"id": "C1", "kind": "criterion", "verdict": "PASS"},
            {"id": "H1", "kind": "holdout", "verdict": "FAIL", "scenario": "sensitive prompt"},
        ]
        proj = project_evidence(evidence_record(lines=failing_holdout))
        self.assertEqual(proj["runtime_verification"]["holdout"]["verdict"], "FAIL")
        self.assertEqual(proj["runtime_verification"]["holdout"]["lines"], [{"id": "H1", "verdict": "FAIL"}])
        self.assertEqual(proj["runtime_verification"]["status"], "failed")
        self.assertEqual(proj["runtime_verification"]["verdict"], "FAIL")
        self.assertNotIn("sensitive prompt", json.dumps(proj))

    def test_review_stale_when_head_mismatched(self) -> None:
        other_sha = "d" * 40
        proj = project_evidence(evidence_record(review_sha=other_sha))
        self.assertEqual(proj["peer_review"]["status"], "stale")
        self.assertEqual(proj["peer_review"]["sha"], other_sha)

    def test_review_ready_when_independently_attributed(self) -> None:
        proj = project_evidence(evidence_record(builder_session="builder-sess", reviewer_session="reviewer-sess"))
        pr = proj["peer_review"]
        self.assertEqual(pr["status"], "ready")
        self.assertEqual(pr["sha"], HEAD)
        self.assertTrue(pr["independent"])
        self.assertEqual(pr["reviewer_session"], "reviewer-sess")
        self.assertEqual(pr["blocking_findings"], 0)

    def test_review_self_attested_not_ready(self) -> None:
        proj = project_evidence(evidence_record(builder_session="same-agent", reviewer_session="same-agent"))
        pr = proj["peer_review"]
        self.assertEqual(pr["status"], "not_ready")
        self.assertFalse(pr["independent"])

    def test_review_ambiguous_attribution_not_ready(self) -> None:
        for b_sess, r_sess in (("builder-1", None), (None, "reviewer-1"), (None, None)):
            with self.subTest(b_sess=b_sess, r_sess=r_sess):
                proj = project_evidence(evidence_record(builder_session=b_sess, reviewer_session=r_sess))
                pr = proj["peer_review"]
                self.assertEqual(pr["status"], "not_ready")
                self.assertFalse(pr["independent"])

    def test_review_blocking_findings_marks_review_failed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            artifacts = Path(td)
            review_dir = artifacts / "review"
            review_dir.mkdir(parents=True)
            findings = [
                {"id": "R1", "severity": "blocking", "status": "open", "claim": "leak"},
                {"id": "R2", "severity": "low", "status": "open", "claim": "nit"},
                {"id": "R3", "severity": "blocking", "status": "resolved", "claim": "fixed"},
            ]
            (review_dir / "findings.json").write_text(json.dumps(findings), encoding="utf-8")
            (review_dir / "report.md").write_text("# Review Report\nApproved with note", encoding="utf-8")

            proj = project_evidence(evidence_record(), artifacts_dir=artifacts)
            pr = proj["peer_review"]
            self.assertEqual(pr["blocking_findings"], 1)
            self.assertEqual(pr["status"], "failed")
            self.assertTrue(pr["report"]["available"])
            self.assertEqual(pr["report"]["path"], "review/report.md")
            self.assertEqual(pr["report"]["url"], f"/api/laps/{FIRST}/evidence/report")

    def test_review_rejected_outcome_failed(self) -> None:
        for outcome in ("sent-back", "needs-owner", "failed", "rejected"):
            with self.subTest(outcome=outcome):
                proj = project_evidence(evidence_record(review_outcome=outcome))
                self.assertEqual(proj["peer_review"]["status"], "failed")

    def test_privacy_and_credential_sentinels_redacted(self) -> None:
        secret = "ghp_supersecretcredential12345"
        token_str = "token=secret_value_123"
        run = evidence_record()
        run["user_message"] = secret
        run["transcript"] = secret
        run["events"][0]["data"]["password"] = secret
        run["events"][2]["data"]["structured_output"]["holdout"] = {
            "verdict": "PASS",
            "private_scenario": secret,
        }
        proj = project_evidence(run)
        dumped = json.dumps(proj)
        self.assertNotIn(secret, dumped)
        self.assertNotIn("secret_value_123", dumped)
        self.assertNotIn("private_scenario", dumped)


class EvidenceHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.temp_root = Path(self.temp_dir.name).resolve()
        self.artifacts_dir = self.temp_root / "artifacts" / "runs" / FIRST
        self.artifacts_dir.mkdir(parents=True, exist_ok=True)
        (self.artifacts_dir / "reviewer").mkdir(parents=True, exist_ok=True)
        (self.artifacts_dir / "reviewer/report.md").write_text("# Code Review\nApproved with token=secret123.", encoding="utf-8")

        rec = evidence_record(FIRST)
        rec["output_root"] = str(self.temp_root)
        self.runs = [rec]
        self.calls = []
        self.failure = None
        self.native = patch("laps.native_json", side_effect=self.query).start()
        self.addCleanup(patch.stopall)
        patch("laps.read_settings", return_value={}).start()
        patch("laps.verify_source", return_value=Path("/pin")).start()
        self.server = HTTPServer(("127.0.0.1", 0), handler("candidate", NativeLaps(self.temp_root)))
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
            return {"runs": self.runs}
        self.assertEqual(args[:2], ["workflow", "get"])
        return deepcopy(next(run for run in self.runs if run["id"] == args[2]))

    def get_json(self, path: str) -> tuple[int, object]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        try:
            response = self.http.open(url, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Content-Type"], "application/json")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, json.loads(response.read().decode("utf-8"))

    def get_raw(self, path: str) -> tuple[int, bytes, str]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        try:
            response = self.http.open(url, timeout=2)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            return response.status, response.read(), response.headers.get("Content-Type", "")

    def test_get_evidence_200(self) -> None:
        status, body = self.get_json(f"/api/laps/{FIRST}/evidence")
        self.assertEqual(status, 200)
        self.assertEqual(body["id"], FIRST)
        self.assertEqual(body["candidate_head"], HEAD)
        self.assertEqual(body["runtime_verification"]["status"], "verified")
        self.assertEqual(body["peer_review"]["status"], "ready")
        self.assertTrue(body["peer_review"]["report"]["available"])
        self.assertEqual(body["peer_review"]["report"]["url"], f"/api/laps/{FIRST}/evidence/report")

    def test_get_evidence_report_200_markdown(self) -> None:
        status, content, content_type = self.get_raw(f"/api/laps/{FIRST}/evidence/report")
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/markdown; charset=utf-8")
        text = content.decode("utf-8")
        self.assertIn("# Code Review\nApproved with token=[redacted]", text)
        self.assertNotIn("secret123", text)

    def test_get_evidence_report_404_when_absent(self) -> None:
        (self.artifacts_dir / "reviewer/report.md").unlink()
        status, body = self.get_json(f"/api/laps/{FIRST}/evidence/report")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "report_not_found"})

    def test_unknown_lap_id_returns_404(self) -> None:
        unknown = "33333333-3333-3333-3333-333333333333"
        for sub in ("/evidence", "/evidence/report"):
            with self.subTest(sub=sub):
                status, body = self.get_json(f"/api/laps/{unknown}{sub}")
                self.assertEqual(status, 404)
                self.assertEqual(body, {"error": "lap_not_found"})

    def test_path_traversal_returns_404(self) -> None:
        for bad_id in ("../../etc/passwd", "..", "foo/bar", "invalid-id-!", "0" * 31):
            with self.subTest(bad_id=bad_id):
                for sub in ("/evidence", "/evidence/report"):
                    status, body = self.get_json(f"/api/laps/{bad_id}{sub}")
                    self.assertEqual(status, 404)

    def test_native_state_unavailable_returns_503(self) -> None:
        self.failure = OSError("disk failure")
        for sub in ("/evidence", "/evidence/report"):
            with self.subTest(sub=sub):
                status, body = self.get_json(f"/api/laps/{FIRST}{sub}")
                self.assertEqual(status, 503)
                self.assertEqual(body, {"error": "native_state_unavailable"})

    def test_evidence_endpoints_are_read_only_and_never_execute(self) -> None:
        calls_before = len(self.calls)
        self.get_json(f"/api/laps/{FIRST}/evidence")
        self.get_raw(f"/api/laps/{FIRST}/evidence/report")
        new_calls = self.calls[calls_before:]
        self.assertTrue(all(call[:2] in (["workflow", "runs"], ["workflow", "get"]) for call in new_calls))
        self.assertFalse(any("run" in call or "execute" in call for call in new_calls))


if __name__ == "__main__":
    unittest.main()

