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
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]


class HealthIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))

    def request(self, port: int, path: str) -> tuple[int, bytes, str]:
        url = f"http://127.0.0.1:{port}{path}"
        with self.http.open(url, timeout=0.2) as response:
            self.assertEqual(response.geturl(), url, "Unexpected redirect")
            return response.status, response.read(), response.headers["Content-Type"]

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
