#!/usr/bin/env python3
"""Loopback health, identity, pinned engine diagnostics and lap inspection."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from engine_diagnostics import EngineDiagnostics
from laps import (
    InvalidLapPayload,
    LapNotFound,
    LaunchBrakeError,
    NativeLaps,
    NativeLaunchError,
    NativeStateError,
    ReportNotFound,
)


def handler(build_id: str, laps: NativeLaps) -> type[BaseHTTPRequestHandler]:
    diagnostics = EngineDiagnostics(laps.root)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/doctor":
                status, result = diagnostics.inspect(doctor=True)
                self.respond(status, json.dumps(result).encode("utf-8"), "application/json")
            elif path == "/api/laps":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    if content_length < 0:
                        content_length = 0
                except (ValueError, TypeError):
                    content_length = 0
                body = self.rfile.read(content_length) if content_length > 0 else b""
                if len(body) != content_length:
                    self.respond(400, json.dumps({"error": "invalid_payload"}).encode("utf-8"), "application/json")
                    return
                try:
                    result = laps.submit(body)
                    status = 202
                except InvalidLapPayload:
                    status, result = 400, {"error": "invalid_payload"}
                except LaunchBrakeError:
                    status, result = 409, {"error": "launch_brake_set"}
                except NativeLaunchError:
                    status, result = 502, {"error": "launch_process_failed"}
                except NativeStateError:
                    status, result = 503, {"error": "native_state_unavailable"}
                self.respond(status, json.dumps(result).encode("utf-8"), "application/json")
            else:
                self.send_error(404)

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
                subpath = path[len("/api/laps"):]
                if not subpath:
                    try:
                        result = laps.read(None)
                    except LapNotFound:
                        status, result = 404, {"error": "lap_not_found"}
                    except NativeStateError:
                        status, result = 503, {"error": "native_state_unavailable"}
                    body = json.dumps(result).encode("utf-8")
                    content_type = "application/json"
                elif subpath.startswith("/"):
                    rest = subpath[1:]
                    if rest.endswith("/evidence/report"):
                        run_id = rest[:-len("/evidence/report")]
                        try:
                            content, content_type = laps.read_report(run_id)
                            body = content.encode("utf-8")
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                        except ReportNotFound:
                            status, result = 404, {"error": "report_not_found"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                    elif rest.endswith("/evidence"):
                        run_id = rest[:-len("/evidence")]
                        try:
                            result = laps.read_evidence(run_id)
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                        body = json.dumps(result).encode("utf-8")
                        content_type = "application/json"
                    else:
                        run_id = rest
                        try:
                            result = laps.read(run_id)
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                        body = json.dumps(result).encode("utf-8")
                        content_type = "application/json"
                else:
                    self.send_error(404)
                    return
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
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler(build_id, laps)) as server:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()


if __name__ == "__main__":
    main()
