#!/usr/bin/env python3
"""Loopback health, identity, pinned engine diagnostics and lap inspection."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit

from engine_diagnostics import EngineDiagnostics
from laps import LapNotFound, NativeLaps, NativeStateError


def handler(build_id: str, laps: NativeLaps) -> type[BaseHTTPRequestHandler]:
    diagnostics = EngineDiagnostics(laps.root)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            if urlsplit(self.path).path != "/api/doctor":
                self.send_error(404)
                return
            status, result = diagnostics.inspect(doctor=True)
            self.respond(status, json.dumps(result).encode("utf-8"), "application/json")

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            status = 200
            if path == "/health":
                body = json.dumps({"status": "healthy"}).encode("utf-8")
                content_type = "application/json"
            elif path == "/build-id":
                body = build_id.encode("utf-8")
                content_type = "text/plain; charset=utf-8"
            elif path == "/api/workflows":
                status, result = diagnostics.inspect()
                body = json.dumps(result).encode("utf-8")
                content_type = "application/json"
            elif path == "/api/laps" or path.startswith("/api/laps/"):
                try:
                    result = laps.read(None if path == "/api/laps" else path[len("/api/laps/"):])
                except LapNotFound:
                    status, result = 404, {"error": "lap_not_found"}
                except NativeStateError:
                    status, result = 503, {"error": "native_state_unavailable"}
                body = json.dumps(result).encode("utf-8")
                content_type = "application/json"
            else:
                self.send_error(404)
                return
            self.respond(status, body, content_type)

        def respond(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # Request targets can contain secrets; do not emit access logs.
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    build_id = os.environ.get("FACTORY_RUNTIME_CANDIDATE")
    if build_id is None:
        build_id = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            text=True,
        ).strip()

    def stop(signum: int, frame: object) -> None:
        raise SystemExit(0)

    laps = NativeLaps(Path(__file__).resolve().parent)
    with HTTPServer(("127.0.0.1", args.port), handler(build_id, laps)) as server:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()


if __name__ == "__main__":
    main()
