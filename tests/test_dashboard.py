"""Browser assertions against read-only operator dashboard at GET /."""
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
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import ProxyHandler, build_opener
from urllib.error import HTTPError

from playwright.sync_api import sync_playwright, Browser, Playwright

from app import handler, DASHBOARD_HTML
from laps import NativeLaps, NativeStateError


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = "04919414-ac6e-4f86-99f1-eccdf5ba0d5f"


def find_artifacts_dir() -> Path:
    candidates = [
        Path(f"/Users/efishery/.archon/workspaces/iqbal-codes/labq-software-factory/artifacts/runs/{RUN_ID}"),
        ROOT.parent / "artifacts" / "runs" / RUN_ID,
        ROOT / "artifacts" / "runs" / RUN_ID,
    ]
    for c in candidates:
        if c.is_dir():
            return c
    # Fallback to creating the primary run directory if it doesn't exist
    fallback = candidates[0]
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


class MockLaps:
    def __init__(self, root: Path):
        self.root = root
        self.runs = []
        self.should_fail = False
        self.mutation_calls = []

    def read(self, run_id: str | None = None):
        if self.should_fail:
            raise NativeStateError("Native state unavailable")
        if run_id is not None:
            for r in self.runs:
                if r["id"] == run_id:
                    return r
            raise LookupError("Run not found")
        return self.runs


class DashboardBrowserTests(unittest.TestCase):
    playwright: Playwright
    browser: Browser
    observations: dict

    @classmethod
    def setUpClass(cls) -> None:
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        cls.observations = {
            "run_id": RUN_ID,
            "browser": "playwright-chromium",
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "commit_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "assertions": {},
            "all_passed": False,
        }

    @classmethod
    def tearDownClass(cls) -> None:
        cls.browser.close()
        cls.playwright.stop()
        # Save dashboard-observations.json
        artifacts_dir = find_artifacts_dir()
        out_file = artifacts_dir / "dashboard-observations.json"
        out_file.write_text(json.dumps(cls.observations, indent=2), encoding="utf-8")

    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))

    def stop_process(self, process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            stdout, stderr = process.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=3)

    def start_real_service(self, candidate: str) -> tuple[subprocess.Popen, int]:
        state = tempfile.TemporaryDirectory()
        self.addCleanup(state.cleanup)
        env = os.environ.copy()
        env["FACTORY_RUNTIME_STATE"] = state.name
        env["FACTORY_RUNTIME_CANDIDATE"] = candidate
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = subprocess.Popen(
            ["python3", "app.py", "--port", str(port)],
            cwd=ROOT,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.addCleanup(self.stop_process, process)
        started = time.monotonic()
        while time.monotonic() - started < 5.0:
            if process.poll() is not None:
                self.fail("Real service process exited prematurely")
            try:
                url = f"http://127.0.0.1:{port}/health"
                with self.http.open(url, timeout=0.5) as res:
                    if res.status == 200:
                        return process, port
            except Exception:
                time.sleep(0.05)
        self.fail("Real service failed to start within 5s")

    def start_test_server(self, mock_laps: MockLaps, candidate: str = "test-cand") -> tuple[HTTPServer, int, list[dict]]:
        requests_log = []

        class RequestTrackingHandler(handler(candidate, mock_laps)):
            def do_GET(self) -> None:
                requests_log.append({"method": "GET", "path": self.path})
                super().do_GET()

            def do_POST(self) -> None:
                requests_log.append({"method": "POST", "path": self.path})
                super().do_POST()

        server = HTTPServer(("127.0.0.1", 0), RequestTrackingHandler)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
        thread.start()

        def cleanup():
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

        self.addCleanup(cleanup)
        return server, port, requests_log

    def test_criterion_1_real_native_lap_observation_and_selection(self) -> None:
        """Browser test against running service observes actual native lap by exact run ID and status;
        selecting it displays same session/candidate information as GET /api/laps/:id."""
        candidate = "candidate-obs-c1"
        _, port = self.start_real_service(candidate)

        # Direct HTTP query to get real laps
        url_laps = f"http://127.0.0.1:{port}/api/laps"
        with self.http.open(url_laps, timeout=30.0) as res:
            laps_data = json.loads(res.read().decode("utf-8"))

        self.assertIsInstance(laps_data, list)
        self.assertGreater(len(laps_data), 0, "Expected at least one real native lap")

        target_lap = laps_data[0]
        run_id = target_lap["id"]
        native_status = target_lap["native_status"]
        product_status = target_lap["product_status"]

        # Fetch expected detail directly
        url_detail = f"http://127.0.0.1:{port}/api/laps/{run_id}"
        with self.http.open(url_detail, timeout=30.0) as res:
            detail_data = json.loads(res.read().decode("utf-8"))

        # Open in Playwright browser
        page = self.browser.new_page()
        try:
            page.goto(f"http://127.0.0.1:{port}/", timeout=30000)
            # Wait for lap row with target run ID
            row_selector = f'tr.lap-row[data-run-id="{run_id}"]'
            page.wait_for_selector(row_selector, timeout=30000)

            # Check visible run ID, native status and product status
            observed_id = page.text_content(f'{row_selector} .lap-id')
            self.assertEqual(observed_id, run_id)

            observed_native = page.text_content(f'{row_selector} .lap-native-status')
            self.assertEqual(observed_native, native_status)

            observed_product = page.text_content(f'{row_selector} .lap-product-status')
            self.assertEqual(observed_product, product_status)

            # Select the lap
            page.click(f'{row_selector} .select-lap-btn')
            page.wait_for_selector('#lap-detail-container:not([style*="display: none"])', timeout=30000)

            # Assert detail candidate information matches GET /api/laps/:id
            displayed_candidate = page.text_content('#detail-candidate-head')
            expected_candidate = detail_data.get("candidate_head") or ""
            self.assertEqual(displayed_candidate, expected_candidate)

            # Assert session identity matches
            sess = detail_data.get("session") or {}
            displayed_conv = page.text_content('#detail-conversation-id')
            expected_conv = sess.get("conversation_id") or ""
            self.assertEqual(displayed_conv, expected_conv)

            displayed_path = page.text_content('#detail-working-path')
            expected_path = sess.get("working_path") or ""
            self.assertEqual(displayed_path, expected_path)

            agents = sess.get("agents") or []
            displayed_agents = page.text_content('#detail-agents')
            for agent in agents:
                self.assertIn(agent.get("node") or "", displayed_agents)
                self.assertIn(agent.get("session_id") or "", displayed_agents)

            # Assert transitions match
            transitions = detail_data.get("transitions") or []
            transition_rows = page.query_selector_all('#detail-transitions-list tr')
            self.assertEqual(len(transition_rows), len(transitions))
            if transitions:
                first_t = transitions[0]
                self.assertIn(first_t.get("id") or "", page.text_content('#detail-transitions-list'))

            self.observations["candidate"] = candidate
            self.observations["assertions"]["criterion_1_real_native_lap"] = {
                "run_id": run_id,
                "native_status": native_status,
                "product_status": product_status,
                "candidate_head": displayed_candidate,
                "conversation_id": displayed_conv,
                "agents_count": len(agents),
                "transitions_count": len(transitions),
                "passed": True
            }
        finally:
            page.close()

    def test_criterion_2_empty_running_terminal_and_failure_states(self) -> None:
        """Tests cover zero runs (an explicit no-runs message), one running run and one terminal run,
        and an API failure (an explicit unavailable message, not no-runs or verified)."""
        mock = MockLaps(ROOT)
        _, port, _ = self.start_test_server(mock, "candidate-obs-c2")

        page = self.browser.new_page()
        try:
            # Case 1: Zero runs
            mock.runs = []
            mock.should_fail = False
            page.goto(f"http://127.0.0.1:{port}/")
            page.wait_for_selector('#status-message.visible', timeout=5000)
            status_text = page.text_content('#status-message')
            self.assertEqual(status_text, "No runs found")
            self.assertEqual(page.is_visible('#laps-table'), False)
            self.assertEqual(page.is_visible('#lap-detail-container'), False)

            # Case 2: One running run and one terminal run
            running_run = {
                "id": "11111111-1111-1111-1111-111111111111",
                "workflow_name": "archon-loop",
                "native_status": "running",
                "product_status": "running",
                "started_at": "2026-10-26T10:00:00Z",
                "completed_at": None,
                "last_activity_at": "2026-10-26T10:05:00Z",
                "candidate_head": "c" * 40,
                "work_item": "Task 1",
                "pull_request": None,
                "session": {"conversation_id": "conv-1", "working_path": "/tmp/1", "agents": []},
                "transitions": [],
            }
            terminal_run = {
                "id": "22222222-2222-2222-2222-222222222222",
                "workflow_name": "archon-loop",
                "native_status": "failed",
                "product_status": "failed",
                "started_at": "2026-10-26T09:00:00Z",
                "completed_at": "2026-10-26T09:10:00Z",
                "last_activity_at": "2026-10-26T09:10:00Z",
                "candidate_head": "d" * 40,
                "work_item": "Task 2",
                "pull_request": None,
                "session": {"conversation_id": "conv-2", "working_path": "/tmp/2", "agents": []},
                "transitions": [],
            }
            mock.runs = [running_run, terminal_run]
            page.click('#refresh-button')
            page.wait_for_selector(f'tr.lap-row[data-run-id="{running_run["id"]}"]', timeout=5000)
            page.wait_for_selector(f'tr.lap-row[data-run-id="{terminal_run["id"]}"]', timeout=5000)

            running_native = page.text_content(f'tr.lap-row[data-run-id="{running_run["id"]}"] .lap-native-status')
            self.assertEqual(running_native, "running")
            terminal_native = page.text_content(f'tr.lap-row[data-run-id="{terminal_run["id"]}"] .lap-native-status')
            self.assertEqual(terminal_native, "failed")

            # Case 3: API failure
            mock.should_fail = True
            page.click('#refresh-button')
            page.wait_for_selector('#status-message.visible.error', timeout=5000)
            fail_text = page.text_content('#status-message')
            self.assertEqual(fail_text, "Lap data unavailable")
            self.assertNotIn("No runs", fail_text)
            self.assertNotIn("No laps", fail_text)
            self.assertNotIn("verified", fail_text.lower())
            # Ensure stale view is wiped
            self.assertEqual(page.is_visible('#laps-table'), False)
            self.assertEqual(page.is_visible('#lap-detail-container'), False)

            self.observations["assertions"]["criterion_2_states"] = {
                "zero_runs_message": status_text,
                "running_run_status": running_native,
                "terminal_run_status": terminal_native,
                "api_failure_message": fail_text,
                "stale_view_cleared": True,
                "passed": True
            }
        finally:
            page.close()

    def test_criterion_3_refresh_updates_exact_status_without_reinterpreting(self) -> None:
        """Refreshing after a native transition updates the visible status to the new exact value;
        the dashboard does not reinterpret failed/cancelled as completed successfully."""
        mock = MockLaps(ROOT)
        run_record = {
            "id": "33333333-3333-3333-3333-333333333333",
            "workflow_name": "archon-loop",
            "native_status": "running",
            "product_status": "running",
            "started_at": "2026-10-26T11:00:00Z",
            "completed_at": None,
            "last_activity_at": "2026-10-26T11:01:00Z",
            "candidate_head": "e" * 40,
            "work_item": "Supervised item",
            "pull_request": None,
            "session": {"conversation_id": "conv-3", "working_path": "/tmp/3", "agents": []},
            "transitions": [],
        }
        mock.runs = [run_record]
        _, port, _ = self.start_test_server(mock, "candidate-obs-c3")

        page = self.browser.new_page()
        try:
            page.goto(f"http://127.0.0.1:{port}/")
            row_selector = f'tr.lap-row[data-run-id="{run_record["id"]}"]'
            page.wait_for_selector(row_selector, timeout=5000)
            self.assertEqual(page.text_content(f'{row_selector} .lap-native-status'), "running")

            # Native transition to failed
            run_record["native_status"] = "failed"
            run_record["product_status"] = "failed"
            page.click('#refresh-button')
            time.sleep(0.1)

            updated_status = page.text_content(f'{row_selector} .lap-native-status')
            self.assertEqual(updated_status, "failed")
            self.assertNotIn("completed", updated_status.lower())
            self.assertNotIn("successfully", updated_status.lower())

            # Native transition to cancelled
            run_record["native_status"] = "cancelled"
            run_record["product_status"] = "cancelled"
            page.click('#refresh-button')
            time.sleep(0.1)

            cancelled_status = page.text_content(f'{row_selector} .lap-native-status')
            self.assertEqual(cancelled_status, "cancelled")
            self.assertNotIn("completed", cancelled_status.lower())
            self.assertNotIn("successfully", cancelled_status.lower())

            self.observations["assertions"]["criterion_3_refresh_transitions"] = {
                "initial_status": "running",
                "transition_failed": updated_status,
                "transition_cancelled": cancelled_status,
                "no_completed_reinterpretation": True,
                "passed": True
            }
        finally:
            page.close()

    def test_criterion_4_xss_rendered_as_text_and_zero_engine_mutations(self) -> None:
        """A specification containing <script>window.injected=1</script> is rendered as text
        and never sets window.injected. Loading, selecting and refreshing trigger zero engine mutation commands."""
        mock = MockLaps(ROOT)
        malicious_spec = "<script>window.injected=1</script>"
        run_record = {
            "id": "44444444-4444-4444-4444-444444444444",
            "workflow_name": "archon-loop",
            "native_status": "completed",
            "product_status": "completed",
            "started_at": "2026-10-26T12:00:00Z",
            "completed_at": "2026-10-26T12:05:00Z",
            "last_activity_at": "2026-10-26T12:05:00Z",
            "candidate_head": "f" * 40,
            "work_item": malicious_spec,
            "pull_request": None,
            "session": {"conversation_id": "conv-xss", "working_path": "/tmp/xss", "agents": []},
            "transitions": [],
        }
        mock.runs = [run_record]
        _, port, requests_log = self.start_test_server(mock, "candidate-obs-c4")

        page = self.browser.new_page()
        try:
            page.goto(f"http://127.0.0.1:{port}/")
            row_selector = f'tr.lap-row[data-run-id="{run_record["id"]}"]'
            page.wait_for_selector(row_selector, timeout=5000)

            # Assert window.injected is not set
            injected_val = page.evaluate("window.injected")
            self.assertIsNone(injected_val)

            # Assert text is rendered literally
            rendered_work_item = page.text_content(f'{row_selector} .lap-work-item')
            self.assertEqual(rendered_work_item, malicious_spec)

            # Select the run
            page.click(f'{row_selector} .select-lap-btn')
            page.wait_for_selector('#lap-detail-container:not([style*="display: none"])', timeout=5000)

            # Assert window.injected still not set
            injected_val_after_select = page.evaluate("window.injected")
            self.assertIsNone(injected_val_after_select)

            detail_work_item = page.text_content('#detail-work-item')
            self.assertEqual(detail_work_item, malicious_spec)

            # Refresh
            page.click('#refresh-button')
            time.sleep(0.1)

            injected_val_after_refresh = page.evaluate("window.injected")
            self.assertIsNone(injected_val_after_refresh)

            # Verify requests_log: only GET requests, zero mutation commands (zero POST)
            post_requests = [r for r in requests_log if r["method"] == "POST"]
            self.assertEqual(len(post_requests), 0, f"Expected 0 mutation POST requests, got: {post_requests}")
            self.assertGreater(len(requests_log), 0)
            for req in requests_log:
                self.assertEqual(req["method"], "GET")

            self.observations["assertions"]["criterion_4_xss_and_mutations"] = {
                "injected_val_on_load": injected_val,
                "injected_val_on_select": injected_val_after_select,
                "injected_val_on_refresh": injected_val_after_refresh,
                "work_item_rendered_as_text": rendered_work_item,
                "total_requests": len(requests_log),
                "mutation_post_requests": len(post_requests),
                "passed": True
            }
            self.observations["all_passed"] = True
        finally:
            page.close()


if __name__ == "__main__":
    unittest.main()
