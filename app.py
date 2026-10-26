#!/usr/bin/env python3
"""Loopback health and running-candidate identity service."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
from http.server import BaseHTTPRequestHandler, HTTPServer


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

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            if self.path == "/health":
                body = json.dumps({"status": "healthy"}).encode("utf-8")
                content_type = "application/json"
            elif self.path == "/build-id":
                body = build_id.encode("utf-8")
                content_type = "text/plain; charset=utf-8"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # Request targets can contain secrets; do not emit access logs.
            return

    def stop(signum: int, frame: object) -> None:
        raise SystemExit(0)

    with HTTPServer(("127.0.0.1", args.port), Handler) as server:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()


if __name__ == "__main__":
    main()
