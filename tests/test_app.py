"""Exercise the real application process and HTTP boundary."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


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

    def test_shutdown_releases_listener(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=sig):
                process, port, _ = self.start("candidate-a")
                self.stop(process, sig)
                with socket.socket() as listener:
                    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    listener.bind(("127.0.0.1", port))
                    listener.listen()


if __name__ == "__main__":
    unittest.main()
