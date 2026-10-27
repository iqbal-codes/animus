"""Exercise the real application process and HTTP boundary."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import HTTPServer
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener

from app import handler
from factory import consumer
from intake import IntakeService
from laps import Controls, NativeLaps


ROOT = Path(__file__).resolve().parents[1]


class HealthIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))

    def request(self, port: int, path: str) -> tuple[int, bytes, str]:
        url = f"http://127.0.0.1:{port}{path}"
        try:
            with self.http.open(url, timeout=1.0) as response:
                self.assertEqual(response.geturl(), url, "Unexpected redirect")
                return response.status, response.read(), response.headers["Content-Type"]
        except HTTPError as error:
            with error:
                return error.status, error.read(), error.headers["Content-Type"]

    def stop(self, process: subprocess.Popen, sig: int = signal.SIGTERM) -> None:
        if process.poll() is None:
            process.send_signal(sig)
        try:
            stdout, stderr = process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=3)
            self.fail("Application failed to stop within 3 seconds")
        self.assertEqual(process.returncode, 0, (stdout, stderr))

    def start(self, candidate: str | None) -> tuple[subprocess.Popen, int, Path]:
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        env = os.environ.copy()
        env["FACTORY_RUNTIME_STATE"] = state.name
        env.pop("FACTORY_RUNTIME_CANDIDATE", None)
        if candidate is not None:
            env["FACTORY_RUNTIME_CANDIDATE"] = candidate
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        started = time.monotonic()
        process = subprocess.Popen(
            ["python3", "app.py", "--port", str(port)],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(self.stop, process)
        while time.monotonic() - started < 5.0:
            if process.poll() is not None:
                stdout, stderr = process.communicate(timeout=1)
                self.fail(f"Application exited during startup: {stdout!r} {stderr!r}")
            try:
                status, body, content_type = self.request(port, "/health")
            except (URLError, TimeoutError):
                time.sleep(0.01)
                continue
            self.assertLess(time.monotonic() - started, 5.0)
            self.assertEqual(status, 200)
            self.assertEqual(content_type, "application/json")
            self.assertEqual(json.loads(body), {"status": "healthy"})
            return process, port, Path(state.name)
        self.fail("Health was not ready within 5 seconds")

    def assert_identity(self, port: int, expected: str) -> None:
        status, body, content_type = self.request(port, "/build-id")
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "text/plain; charset=utf-8")
        self.assertEqual(body.decode("utf-8"), expected)

    def test_candidate_identity(self) -> None:
        for candidate in ("candidate-a", "candidate-b", "", "  candidate-é\n"):
            with self.subTest(candidate=candidate):
                process, port, state = self.start(candidate)
                self.assert_identity(port, candidate)
                self.assertEqual(list(state.iterdir()), [])
                self.stop(process)

    def test_unset_candidate_uses_checkout_commit(self) -> None:
        expected = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip()
        _, port, _ = self.start(None)
        self.assert_identity(port, expected)

    def test_concurrent_processes_are_independent(self) -> None:
        first, first_port, first_state = self.start("candidate-a")
        second, second_port, second_state = self.start("candidate-b")
        self.assertNotEqual(first_port, second_port)
        self.assertNotEqual(first_state, second_state)
        self.assert_identity(first_port, "candidate-a")
        self.assert_identity(second_port, "candidate-b")
        self.stop(first)
        status, body, _ = self.request(second_port, "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "healthy"})
        self.assert_identity(second_port, "candidate-b")
        self.assertIsNone(second.poll())

    def test_unfinished_request_does_not_block_other_connections(self) -> None:
        _, port, _ = self.start("candidate-a")
        with socket.create_connection(("127.0.0.1", port), timeout=1) as pending:
            pending.sendall(b"GET /api/doctor HTTP/1.0\r\n")
            status, body, _ = self.request(port, "/health")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"status": "healthy"})
            self.assert_identity(port, "candidate-a")

    def post(self, port: int, path: str, data: bytes | dict) -> tuple[int, bytes, str]:
        url = f"http://127.0.0.1:{port}{path}"
        payload = json.dumps(data).encode("utf-8") if isinstance(data, dict) else data
        req = Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self.http.open(req, timeout=1.0) as response:
                return response.status, response.read(), response.headers["Content-Type"]
        except HTTPError as error:
            with error:
                return error.status, error.read(), error.headers["Content-Type"]

    def test_lap_submission_validation_against_real_app(self) -> None:
        process, port, _ = self.start("candidate-a")
        invalid_payloads = [
            {"specification": "", "merge_mode": "approve"},
            {"specification": "test", "merge_mode": "auto"},
            {"specification": "test", "merge_mode": "approve", "launch": "override"},
            b"{",
        ]
        for payload in invalid_payloads:
            with self.subTest(payload=payload):
                status, body, content_type = self.post(port, "/api/laps", payload)
                self.assertEqual(status, 400)
                self.assertEqual(content_type, "application/json")
                self.assertEqual(json.loads(body), {"error": "invalid_payload"})

        # Unknown POST target
        status, _, _ = self.post(port, "/api/laps/123", {"specification": "test", "merge_mode": "approve"})
        self.assertEqual(status, 404)
        self.stop(process)

    def test_evidence_and_report_against_real_app(self) -> None:
        process, port, _ = self.start("candidate-evidence")
        # 404 for unknown run
        status, body, ct = self.request(port, "/api/laps/00000000-0000-0000-0000-000000000000/evidence")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "lap_not_found"})

        status, body, ct = self.request(port, "/api/laps/00000000-0000-0000-0000-000000000000/evidence/report")
        self.assertEqual(status, 404)
        self.assertEqual(json.loads(body), {"error": "lap_not_found"})

        # Path traversal rejection
        status, body, ct = self.request(port, "/api/laps/../health/evidence")
        self.assertEqual(status, 404)

        # Real native run retrieval
        real_id = "59ebd42f-442c-49ec-9822-861074ae08b6"
        status, body, ct = self.request(port, f"/api/laps/{real_id}/evidence")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        data = json.loads(body)
        self.assertEqual(data["id"], real_id)
        self.assertEqual(data["runtime_verification"]["status"], "verified")
        self.assertEqual(data["peer_review"]["status"], "ready")
        self.assertTrue(data["peer_review"]["report"]["available"])

        status, body, ct = self.request(port, f"/api/laps/{real_id}/evidence/report")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "text/markdown; charset=utf-8")
        self.assertIn("Independent loop code review", body.decode("utf-8"))
        self.stop(process)

    def test_operator_dashboard_endpoint(self) -> None:
        process, port, _ = self.start("candidate-dash")
        for target in ("/", "/?refresh=true"):
            with self.subTest(target=target):
                status, body, ct = self.request(port, target)
                self.assertEqual(status, 200)
                self.assertEqual(ct, "text/html; charset=utf-8")
                html_text = body.decode("utf-8")
                self.assertIn("Factory Operator Dashboard", html_text)
                self.assertIn('id="refresh-button"', html_text)
                self.assertIn('id="laps-container"', html_text)
                self.assertIn('id="lap-detail-container"', html_text)
        self.stop(process)

    def test_shutdown_releases_listener(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig):
                process, port, _ = self.start("candidate-a")
                self.stop(process, sig)
                with socket.socket() as listener:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind(("127.0.0.1", port))
                    listener.listen()


class ControlsHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.temp_root = Path(self.temp_dir.name).resolve()
        subprocess.run(["git", "init"], cwd=self.temp_root, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "test-user"], cwd=self.temp_root, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.temp_root, check=True)

        self.controls = Controls(self.temp_root)
        self.laps = NativeLaps(self.temp_root)
        self.server = HTTPServer(("127.0.0.1", 0), handler("candidate-controls", self.laps, self.controls))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.http = build_opener(ProxyHandler({}))

    def stop_server(self) -> None:
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()

    def get(self, path: str) -> tuple[int, dict, str]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        try:
            with self.http.open(url, timeout=2.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return resp.status, data, resp.headers.get("Content-Type", "")
        except HTTPError as err:
            with err:
                data = json.loads(err.read().decode("utf-8"))
                return err.status, data, err.headers.get("Content-Type", "")

    def post(self, path: str, payload: bytes | dict | None = None) -> tuple[int, dict, str]:
        url = f"http://127.0.0.1:{self.server.server_port}{path}"
        if payload is None:
            data = b""
            headers = {}
        elif isinstance(payload, dict):
            data = json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"}
        else:
            data = payload
            headers = {"Content-Type": "application/json"}
        req = Request(url, data=data, headers=headers, method="POST")
        try:
            with self.http.open(req, timeout=2.0) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                return resp.status, body, resp.headers.get("Content-Type", "")
        except HTTPError as err:
            with err:
                body = json.loads(err.read().decode("utf-8"))
                return err.status, body, err.headers.get("Content-Type", "")

    def test_get_controls_initial_state(self) -> None:
        status, body, ct = self.get("/api/controls")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        self.assertEqual(body, {"halted": False, "paused": False})

    def test_halt_twice_and_unhalt_twice(self) -> None:
        stop_path = self.temp_root / ".factory/STOP"

        # First halt
        status, body, _ = self.post("/api/controls/halt")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": True, "paused": False})
        self.assertTrue(stop_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": True, "paused": False})

        # Halt twice leaves halted=true
        status, body, _ = self.post("/api/controls/halt")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": True, "paused": False})
        self.assertTrue(stop_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": True, "paused": False})

        # First unhalt
        status, body, _ = self.post("/api/controls/unhalt")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": False})
        self.assertFalse(stop_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

        # Unhalt twice leaves halted=false
        status, body, _ = self.post("/api/controls/unhalt")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": False})
        self.assertFalse(stop_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

    def test_pause_twice_and_unpause_twice(self) -> None:
        pause_path = self.temp_root / ".factory/PAUSE"

        # First pause
        status, body, _ = self.post("/api/controls/pause")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": True})
        self.assertTrue(pause_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": True})

        # Pause twice leaves paused=true
        status, body, _ = self.post("/api/controls/pause")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": True})
        self.assertTrue(pause_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": True})

        # First unpause
        status, body, _ = self.post("/api/controls/unpause")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": False})
        self.assertFalse(pause_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

        # Unpause twice leaves paused=false
        status, body, _ = self.post("/api/controls/unpause")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"halted": False, "paused": False})
        self.assertFalse(pause_path.exists())
        self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

    def test_unknown_action_returns_400_and_invokes_zero_actions(self) -> None:
        targets = [
            "/api/controls",
            "/api/controls/",
            "/api/controls/unknown",
            "/api/controls/schedule",
            "/api/controls/install",
            "/api/controls/remove",
            "/api/controls/cancel",
            "/api/controls/halt/extra",
            "/api/controls/restart",
        ]
        for path in targets:
            with self.subTest(path=path):
                status, body, _ = self.post(path)
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "unknown_action"})
                self.assertFalse((self.temp_root / ".factory/STOP").exists())
                self.assertFalse((self.temp_root / ".factory/PAUSE").exists())

    def test_extra_arguments_returns_400_and_invokes_zero_actions(self) -> None:
        # Extra query arguments
        query_cases = [
            "/api/controls/halt?command=schedule",
            "/api/controls/halt?cwd=/tmp",
            "/api/controls/halt?source=bar",
            "/api/controls/pause?arg=1",
            "/api/controls/unhalt?extra=val",
        ]
        for path in query_cases:
            with self.subTest(query_path=path):
                status, body, _ = self.post(path)
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "invalid_arguments"})
                self.assertFalse((self.temp_root / ".factory/STOP").exists())
                self.assertFalse((self.temp_root / ".factory/PAUSE").exists())

        # Extra body arguments
        body_cases = [
            {"command": "schedule"},
            {"source": "foo"},
            {"cwd": "/tmp"},
            {"extra": "value"},
            {"command": "fire", "source": "local", "cwd": "/tmp"},
        ]
        for payload in body_cases:
            with self.subTest(payload=payload):
                status, body, _ = self.post("/api/controls/halt", payload)
                self.assertEqual(status, 400)
                self.assertEqual(body, {"error": "invalid_arguments"})
                self.assertFalse((self.temp_root / ".factory/STOP").exists())

        # Malformed or non-dict payloads
        status, body, _ = self.post("/api/controls/halt", b"{malformed")
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "invalid_payload"})

        status, body, _ = self.post("/api/controls/halt", b"[1, 2, 3]")
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "invalid_arguments"})
        self.assertFalse((self.temp_root / ".factory/STOP").exists())

    def test_failed_consumer_action_returns_non_2xx(self) -> None:
        with patch("laps.invoke", side_effect=RuntimeError("Subprocess failed")):
            status, body, _ = self.post("/api/controls/halt")
            self.assertEqual(status, 500)
            self.assertEqual(body, {"error": "control_action_failed"})
            self.assertFalse((self.temp_root / ".factory/STOP").exists())
            # State remains false, not false success
            self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

        with patch("laps.invoke", return_value=1):
            status, body, _ = self.post("/api/controls/pause")
            self.assertEqual(status, 500)
            self.assertEqual(body, {"error": "control_action_failed"})
            self.assertFalse((self.temp_root / ".factory/PAUSE").exists())
            self.assertEqual(self.get("/api/controls")[1], {"halted": False, "paused": False})

    def test_brake_semantics_halt_refuses_operations_and_pause_permits_explicit_runs(self) -> None:
        # Halt refuses run, resume, approve, respond
        consumer.invoke(self.temp_root, "halt", [])
        self.assertTrue((self.temp_root / ".factory/STOP").exists())

        for action in ("run", "resume", "approve", "respond"):
            with self.subTest(refused_action=action):
                with self.assertRaises(ValueError) as ctx:
                    consumer.invoke(self.temp_root, action, ["archon-loop"])
                self.assertIn("Local STOP is set", str(ctx.exception))

        # Cancel is NOT refused by halt
        with self.assertRaises(ValueError) as ctx:
            consumer.invoke(self.temp_root, "cancel", ["test-run-id"])
        self.assertNotIn("Local STOP is set", str(ctx.exception))
        self.assertIn("Integration pin required", str(ctx.exception))

        # Unhalt clears the block
        consumer.invoke(self.temp_root, "unhalt", [])
        self.assertFalse((self.temp_root / ".factory/STOP").exists())

        # Pause permits explicit runs and skips scheduled new launches while retaining wake path
        consumer.invoke(self.temp_root, "pause", [])
        self.assertTrue((self.temp_root / ".factory/PAUSE").exists())

        # Explicit run is NOT refused by pause
        with self.assertRaises(ValueError) as ctx:
            consumer.invoke(self.temp_root, "run", ["archon-loop"])
        self.assertNotIn("Local STOP is set", str(ctx.exception))
        self.assertIn("Integration pin required", str(ctx.exception))

        # Schedule fire under pause
        trigger_path = self.temp_root / ".factory/trigger.json"
        trigger_path.parent.mkdir(parents=True, exist_ok=True)
        trigger_path.write_text(json.dumps({"binding": {"launch": {"workflowName": "archon-loop"}}}), encoding="utf-8")
        settings_path = self.temp_root / ".factory/consumer.json"
        settings_path.write_text(json.dumps({"source": str(self.temp_root), "revision": "0" * 40}), encoding="utf-8")

        # Mock execute and verify schedule fire skips launch and executes wake under pause
        executed_cmds = []
        real_execute = consumer.execute

        def mock_execute(argv, cwd, **kwargs):
            if argv[0] == "git" or "git" in argv:
                return real_execute(argv, cwd, **kwargs)
            executed_cmds.append(argv)
            return subprocess.CompletedProcess(argv, 0, "", "")

        with patch("factory.consumer.read_settings", return_value={"source": str(self.temp_root), "revision": "0" * 40}), \
             patch("factory.consumer.verify_source", return_value=self.temp_root), \
             patch("factory.consumer.cli", return_value=["mock-cli"]), \
             patch("factory.consumer.execute", side_effect=mock_execute):
            rc = consumer.schedule(self.temp_root, ["fire"])
            self.assertEqual(rc, 0)
            # Wake was executed
            self.assertTrue(any("wake" in cmd for cmd in executed_cmds), "Wake command was not called")
            # Trigger fire was NOT called
            self.assertFalse(any("fire" in cmd and "trigger" in cmd for cmd in executed_cmds), "Trigger fire was called under pause")

    def test_controls_do_not_cancel_active_runs(self) -> None:
        # Running laps remain active; controls do not invoke cancel or kill runs
        executed_cmds = []
        real_execute = consumer.execute

        def mock_execute(argv, cwd, **kwargs):
            executed_cmds.append(argv)
            return real_execute(argv, cwd, **kwargs)

        with patch("factory.consumer.execute", side_effect=mock_execute):
            self.post("/api/controls/halt")
            self.post("/api/controls/pause")
            self.post("/api/controls/unhalt")
            self.post("/api/controls/unpause")
            # Verify no workflow commands or cancel/abandon commands were called
            mutation_cmds = [cmd for cmd in executed_cmds if any(sub in cmd for sub in ("workflow", "cancel", "abandon", "kill"))]
            self.assertEqual(len(mutation_cmds), 0, f"Controls executed unexpected workflow commands: {mutation_cmds}")

    def test_service_listener_rejects_non_loopback_bind(self) -> None:
        # Non-loopback addresses must be rejected with exit code 2
        for bad_host in ("0.0.0.0", "192.168.1.1", "10.0.0.1", "example.com"):
            with self.subTest(host=bad_host):
                proc = subprocess.run(
                    ["python3", "app.py", "--port", "9999", "--host", bad_host],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(proc.returncode, 0)
                self.assertIn(f"Non-loopback bind address '{bad_host}' rejected", proc.stderr)

    def test_real_app_subprocess_controls(self) -> None:
        with socket.socket() as res:
            res.bind(("127.0.0.1", 0))
            port = res.getsockname()[1]

        env = os.environ.copy()
        env["FACTORY_RUNTIME_STATE"] = str(self.temp_root)
        env["FACTORY_PROJECT_ROOT"] = str(self.temp_root)
        env["FACTORY_RUNTIME_CANDIDATE"] = "candidate-controls-subp"

        # Start real app in isolated test repository
        proc = subprocess.Popen(
            ["python3", str(ROOT / "app.py"), "--port", str(port)],
            cwd=self.temp_root,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            started = time.monotonic()
            while time.monotonic() - started < 5.0:
                try:
                    with self.http.open(f"http://127.0.0.1:{port}/health", timeout=0.5) as r:
                        if r.status == 200:
                            break
                except Exception:
                    time.sleep(0.05)
            else:
                self.fail("Real app failed to start within 5s")

            def probe_get(p):
                with self.http.open(f"http://127.0.0.1:{port}{p}", timeout=1.0) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))

            def probe_post(p, d=None):
                req = Request(f"http://127.0.0.1:{port}{p}", data=json.dumps(d).encode("utf-8") if d else b"",
                              headers={"Content-Type": "application/json"} if d else {}, method="POST")
                with self.http.open(req, timeout=1.0) as r:
                    return r.status, json.loads(r.read().decode("utf-8"))

            self.assertEqual(probe_get("/api/controls"), (200, {"halted": False, "paused": False}))
            self.assertEqual(probe_post("/api/controls/halt"), (200, {"halted": True, "paused": False}))
            self.assertEqual(probe_get("/api/controls"), (200, {"halted": True, "paused": False}))
            self.assertEqual(probe_post("/api/controls/unhalt"), (200, {"halted": False, "paused": False}))
            self.assertEqual(probe_post("/api/controls/pause"), (200, {"halted": False, "paused": True}))
            self.assertEqual(probe_get("/api/controls"), (200, {"halted": False, "paused": True}))
            self.assertEqual(probe_post("/api/controls/unpause"), (200, {"halted": False, "paused": False}))
        finally:
            proc.terminate()
            proc.communicate(timeout=3)


class IntakeHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))
        self.mock_laps = MagicMock(spec=NativeLaps)
        self.mock_laps.root = ROOT
        self.mock_intake = MagicMock(spec=IntakeService)

        handler_cls = handler("candidate-test", self.mock_laps, intake=self.mock_intake)
        self.server = HTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def get(self, path: str) -> tuple[int, dict, str]:
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with self.http.open(url, timeout=2.0) as res:
                content_type = res.headers.get("Content-Type", "")
                data = json.loads(res.read().decode("utf-8"))
                return res.status, data, content_type
        except HTTPError as err:
            content_type = err.headers.get("Content-Type", "")
            data = json.loads(err.read().decode("utf-8"))
            return err.status, data, content_type

    def test_get_intake_success(self) -> None:
        mock_backlog = {
            "repo": "pabriq-app",
            "as_of": "2026-10-27T00:00:00Z",
            "cached": False,
            "total_count": 2,
            "admitted_count": 1,
            "held_count": 1,
            "excluded_count": 0,
            "issues": [
                {
                    "number": 42,
                    "title": "Add webhook verify",
                    "state": "OPEN",
                    "admission_status": "admitted",
                    "reason": "admitted_ready",
                    "labels": ["factory:ready"],
                    "dependencies": [],
                    "unsatisfied_dependencies": [],
                },
                {
                    "number": 43,
                    "title": "Rate limit",
                    "state": "OPEN",
                    "admission_status": "held",
                    "reason": "missing_ready_label",
                    "labels": [],
                    "dependencies": [],
                    "unsatisfied_dependencies": [],
                },
            ],
        }
        self.mock_intake.evaluate_backlog.return_value = mock_backlog

        status, body, content_type = self.get("/api/intake")
        self.assertEqual(status, 200)
        self.assertEqual(content_type, "application/json")
        self.assertEqual(body["admitted_count"], 1)
        self.assertEqual(body["held_count"], 1)
        self.mock_intake.evaluate_backlog.assert_called_with(force_refresh=False)

    def test_get_intake_refresh_query(self) -> None:
        self.mock_intake.evaluate_backlog.return_value = {"cached": False, "issues": []}
        status, _, _ = self.get("/api/intake?refresh=true")
        self.assertEqual(status, 200)
        self.mock_intake.evaluate_backlog.assert_called_with(force_refresh=True)

    def test_get_intake_fetch_error_returns_503(self) -> None:
        from intake import IntakeFetchError
        self.mock_intake.evaluate_backlog.side_effect = IntakeFetchError("gh token expired")

        status, body, _ = self.get("/api/intake")
        self.assertEqual(status, 503)
        self.assertEqual(body["error"], "intake_unavailable")
        self.assertIn("gh token expired", body["detail"])

    def test_get_intake_specific_issue_success(self) -> None:
        mock_issue = {
            "number": 42,
            "title": "Add webhook verify",
            "state": "OPEN",
            "admission_status": "admitted",
            "reason": "admitted_ready",
            "labels": ["ready-for-agent"],
            "dependencies": [],
            "unsatisfied_dependencies": [],
            "recommended_label": "ready-for-agent",
            "confidence": 0.95,
            "complexity": 1.5,
        }
        self.mock_intake.get_evaluated_issue.return_value = mock_issue

        status, body, ct = self.get("/api/intake/42")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        self.assertEqual(body["number"], 42)
        self.assertEqual(body["recommended_label"], "ready-for-agent")
        self.assertEqual(body["confidence"], 0.95)
        self.assertEqual(body["complexity"], 1.5)
        self.mock_intake.get_evaluated_issue.assert_called_with(42, force_refresh=False)

    def test_get_intake_specific_issue_not_found(self) -> None:
        self.mock_intake.get_evaluated_issue.return_value = None

        status, body, _ = self.get("/api/intake/999")
        self.assertEqual(status, 404)
        self.assertEqual(body, {"error": "issue_not_found", "number": 999})

    def test_get_intake_specific_issue_invalid_number(self) -> None:
        status, body, _ = self.get("/api/intake/not-a-number")
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "invalid_issue_number"})


class HarnessHTTPTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp_dir.name)
        factory_dir = self.temp_root / ".factory"
        factory_dir.mkdir(parents=True, exist_ok=True)

        # Baseline guidance and lesson
        (factory_dir / "tool-guidance.json").write_text(
            json.dumps({"test": "pytest -v", "lint": "ruff check ."}),
            encoding="utf-8",
        )
        lesson_data = {
            "id": "lsn-20261027-01",
            "topic": "test-execution",
            "trigger_patterns": ["tests/*"],
            "rule": "Run pytest with offline fixtures.",
            "evidence": "Lap test runs require offline mock transport.",
            "vetoed": False,
            "created_at": "2026-10-27T08:00:00Z",
        }
        (factory_dir / "lessons.jsonl").write_text(
            json.dumps(lesson_data) + "\n",
            encoding="utf-8",
        )

        from factory.harness_evolution import HarnessEvolutionService
        self.harness_service = HarnessEvolutionService(self.temp_root)
        self.mock_laps = MagicMock(spec=NativeLaps)
        self.mock_laps.root = self.temp_root

        handler_cls = handler("candidate-test", self.mock_laps, harness=self.harness_service)
        self.server = HTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)
        self.temp_dir.cleanup()

    def get(self, path: str) -> tuple[int, dict, str]:
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with self.http.open(url, timeout=2.0) as res:
                content_type = res.headers.get("Content-Type", "")
                data = json.loads(res.read().decode("utf-8"))
                return res.status, data, content_type
        except HTTPError as err:
            content_type = err.headers.get("Content-Type", "")
            data = json.loads(err.read().decode("utf-8"))
            return err.status, data, content_type

    def post(self, path: str, payload: dict | bytes | None = None) -> tuple[int, dict, str]:
        url = f"http://127.0.0.1:{self.port}{path}"
        if payload is None:
            data = b""
            headers = {}
        elif isinstance(payload, dict):
            data = json.dumps(payload).encode("utf-8")
            headers = {"Content-Type": "application/json"}
        else:
            data = payload
            headers = {"Content-Type": "application/json"}
        req = Request(url, data=data, headers=headers, method="POST")
        try:
            with self.http.open(req, timeout=2.0) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                return resp.status, body, resp.headers.get("Content-Type", "")
        except HTTPError as err:
            with err:
                body = json.loads(err.read().decode("utf-8"))
                return err.status, body, err.headers.get("Content-Type", "")

    def test_get_harness_lessons(self) -> None:
        status, body, ct = self.get("/api/harness/lessons")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["active_count"], 1)
        self.assertEqual(body["vetoed_count"], 0)
        self.assertFalse(body["safe_mode"])
        self.assertEqual(len(body["lessons"]), 1)
        self.assertEqual(body["lessons"][0]["id"], "lsn-20261027-01")

    def test_get_harness_tools(self) -> None:
        status, body, ct = self.get("/api/harness/tools")
        self.assertEqual(status, 200)
        self.assertEqual(ct, "application/json")
        self.assertEqual(body["tools"]["test"], "pytest -v")
        self.assertFalse(body["safe_mode"])

    def test_post_veto_lesson(self) -> None:
        # Veto valid lesson
        status, body, _ = self.post("/api/harness/veto", {"id": "lsn-20261027-01"})
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "vetoed")
        self.assertEqual(body["id"], "lsn-20261027-01")

        # Verify state updated
        status, body, _ = self.get("/api/harness/lessons")
        self.assertEqual(body["active_count"], 0)
        self.assertEqual(body["vetoed_count"], 1)

        # Veto non-existent lesson -> 404
        status, body, _ = self.post("/api/harness/veto", {"id": "lsn-unknown"})
        self.assertEqual(status, 404)
        self.assertEqual(body["error"], "lesson_not_found")

        # Missing id -> 400
        status, body, _ = self.post("/api/harness/veto", {})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "invalid_payload")

    def test_post_safe_mode_toggle(self) -> None:
        # Enable safe mode
        status, body, _ = self.post("/api/controls/safe-mode", {"enabled": True})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "safe_mode": True})
        self.assertTrue((self.temp_root / ".factory" / "NO_HARNESS_MEMORY").exists())

        # Verify lessons endpoint reflects safe_mode
        _, lessons_body, _ = self.get("/api/harness/lessons")
        self.assertTrue(lessons_body["safe_mode"])

        # Disable safe mode
        status, body, _ = self.post("/api/controls/safe-mode", {"enabled": False})
        self.assertEqual(status, 200)
        self.assertEqual(body, {"status": "ok", "safe_mode": False})
        self.assertFalse((self.temp_root / ".factory" / "NO_HARNESS_MEMORY").exists())

        # Invalid payload -> 400
        status, body, _ = self.post("/api/controls/safe-mode", {"enabled": "yes"})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "invalid_payload")


if __name__ == "__main__":
    unittest.main()
