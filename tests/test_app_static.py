"""Unit and security tests for static asset routing and directory traversal prevention."""
from __future__ import annotations

import json
from pathlib import Path
import threading
import unittest
from http.server import HTTPServer
from unittest.mock import MagicMock
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener

from app import handler
from laps import NativeLaps


class StaticAssetSecurityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.http = build_opener(ProxyHandler({}))
        self.mock_laps = MagicMock(spec=NativeLaps)
        self.mock_laps.root = Path(__file__).resolve().parents[1]

        handler_cls = handler("candidate-static-test", self.mock_laps)
        self.server = HTTPServer(("127.0.0.1", 0), handler_cls)
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2.0)

    def get(self, path: str) -> tuple[int, bytes, str]:
        url = f"http://127.0.0.1:{self.port}{path}"
        try:
            with self.http.open(url, timeout=3.0) as res:
                return res.status, res.read(), res.headers.get("Content-Type", "")
        except HTTPError as err:
            return err.status, err.read(), err.headers.get("Content-Type", "")

    def test_serves_index_html(self) -> None:
        status, body, ct = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ct)
        self.assertIn(b"LabQ", body)

    def test_serves_style_css(self) -> None:
        status, body, ct = self.get("/style.css")
        self.assertEqual(status, 200)
        self.assertIn("text/css", ct)
        self.assertIn(b"--xai-accent", body)

    def test_serves_app_js(self) -> None:
        status, body, ct = self.get("/app.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", ct)
        self.assertIn(b"fetchFactoryState", body)

    def test_blocks_directory_traversal(self) -> None:
        traversals = [
            "/static/../../etc/passwd",
            "/static/../app.py",
            "/static/../../app.py",
            "/../app.py",
            "/../../MISSION.md",
        ]
        for path in traversals:
            with self.subTest(path=path):
                status, _, _ = self.get(path)
                self.assertEqual(status, 404, f"Path {path} should return 404 Not Found")

    def test_non_existent_static_asset_returns_404(self) -> None:
        status, _, _ = self.get("/static/missing-file.css")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
