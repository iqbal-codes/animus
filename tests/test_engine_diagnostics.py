"""Exercise HTTP through the real consumer with a temporary pinned CLI installation."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

from app import handler
from factory import consumer
from laps import NativeLaps


class EngineHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.project = self.root / "project"
        self.project.mkdir()
        self.git("init", "-q", cwd=self.project)
        self.source = self.root / "source"
        self.source.mkdir()
        self.git("init", "-q", cwd=self.source)
        for name in (consumer.ENTRY, "package.json", "bun.lock"):
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
        workflows = self.source / consumer.MANIFEST["source_directory"]
        workflows.mkdir(parents=True)
        for name in consumer.MANIFEST["entries"]:
            (workflows / (name + ".yaml")).write_text(f"name: {name}\n")
        (self.source / ".gitignore").write_text("node_modules/\n")
        (self.source / "node_modules").mkdir()
        self.git("add", ".", cwd=self.source)
        self.git("-c", "user.name=Test", "-c", "user.email=test@example.com",
                 "commit", "-qm", "Test source", cwd=self.source)
        self.revision = self.git("rev-parse", "HEAD", cwd=self.source).strip()
        self.source = self.source.rename(self.root / self.revision)
        self.settings = {"source": str(self.source), "revision": self.revision}
        (self.project / ".factory").mkdir()
        self.save_settings()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        (self.bin / "git").symlink_to(shutil.which("git"))
        self.mode = self.root / "mode"
        self.mode.write_text("success")
        self.calls = self.root / "calls"
        script = f'''#!{sys.executable}
import json, pathlib, sys
args = sys.argv[1:]
with open({str(self.calls)!r}, "a") as log:
    log.write(json.dumps(args) + "\\n")
mode = pathlib.Path({str(self.mode)!r}).read_text()
if args == ["--version"]:
    print("1.0")
    sys.exit(0)
if mode == "subprocess_failure":
    print("token=never-public", file=sys.stderr)
    sys.exit(1)
if "--help" in args:
    print({(' '.join('workflow ' + name for name in consumer.MANIFEST['capabilities']) + ' ' + ' '.join(flag for flags in consumer.MANIFEST['capabilities'].values() for flag in flags))!r})
    sys.exit(0)
if mode == "malformed":
    print("not JSON token=never-public")
    sys.exit(0)
command = args[1:4]
if command[:2] == ["workflow", "list"]:
    rows = {list(consumer.MANIFEST['entries'])!r}
    if mode == "missing_workflow": rows.remove("archon-loop")
    data = {{"workflows": [{{"name": name}} for name in rows]}}
elif command[:2] == ["validate", "workflows"]:
    valid = not (mode == "bad_binding" and "--workflow-source" in args)
    data = {{"results": [{{"valid": valid}}], "summary": {{"errors": 0 if valid else 1}}}}
elif command == ["ai", "tier", "list"]:
    binding = {{"provider": "pi", "model": "router/test"}}
    if mode == "unresolved_binding": binding = None
    data = {{"tiers": [{{"tier": tier, "effective": binding}} for tier in ("small", "medium", "large")]}}
elif command == ["ai", "alias", "list"]:
    data = {{"aliases": []}}
else:
    sys.exit(9)
print(json.dumps(data))
'''
        for tool in ("bun", "uv"):
            path = self.bin / tool
            path.write_text(script)
            path.chmod(0o755)
        self.addCleanup(patch.stopall)
        patch.dict(os.environ, {"PATH": str(self.bin)}).start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler("candidate", NativeLaps(self.project)))
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01})
        self.thread.start()
        self.addCleanup(self.stop)
        self.http = build_opener(ProxyHandler({}))

    def git(self, *args, cwd):
        return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.PIPE, timeout=5)

    def save_settings(self):
        (self.project / consumer.SETTINGS).write_text(json.dumps(self.settings))

    def stop(self):
        self.server.shutdown()
        self.thread.join(timeout=3)
        self.server.server_close()
        self.assertFalse(self.thread.is_alive())

    def request(self, doctor=False):
        request = Request(f"http://127.0.0.1:{self.server.server_port}/api/" +
                          ("doctor" if doctor else "workflows"), method="POST" if doctor else "GET")
        try:
            response = self.http.open(request, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.headers["Content-Type"], "application/json")
            return response.status, json.loads(response.read())

    def assert_unavailable(self, doctor=False, failed=None):
        status, body = self.request(doctor)
        self.assertEqual(status, 503)
        self.assertIs(body["ok"], False)
        self.assertNotIn("workflows", body)
        self.assertNotIn("never-public", json.dumps(body))
        if failed:
            self.assertIs(body["checks"][failed]["ok"], False)

    def test_existing_endpoints_respond_while_each_diagnostic_route_is_in_flight(self):
        for doctor in (False, True):
            with self.subTest(doctor=doctor):
                entered = threading.Event()
                release = threading.Event()

                def inspect(*, doctor=False):
                    entered.set()
                    if not release.wait(timeout=5):
                        raise TimeoutError("Test did not release diagnostics")
                    return 503, {"ok": False, "checks": {}}

                lap_id = "11111111-1111-1111-1111-111111111111"
                lap = {"id": lap_id, "product_status": "running"}
                with patch("app.EngineDiagnostics.inspect", side_effect=inspect) as diagnostic, \
                        patch("app.NativeLaps.read", side_effect=lambda run_id: lap if run_id else [lap]) as read, \
                        ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(self.request, doctor)
                    try:
                        self.assertTrue(entered.wait(timeout=2), "Diagnostics never started")
                        for path, expected in (("/health", {"status": "healthy"}),
                                               ("/build-id", "candidate"),
                                               ("/api/laps", [lap]),
                                               (f"/api/laps/{lap_id}", lap)):
                            with self.http.open(f"http://127.0.0.1:{self.server.server_port}{path}",
                                                timeout=1) as response:
                                self.assertEqual(response.status, 200)
                                body = response.read().decode("utf-8")
                                self.assertEqual(body if path == "/build-id" else json.loads(body), expected)
                            self.assertFalse(release.is_set())
                            self.assertFalse(pending.done(), "Diagnostics finished before lightweight read")
                        self.assertEqual(read.call_args_list[0].args, (None,))
                        self.assertEqual(read.call_args_list[1].args, (lap_id,))
                        diagnostic.assert_called_once_with(**({"doctor": True} if doctor else {}))
                    finally:
                        release.set()
                    self.assertEqual(pending.result(timeout=2), (503, {"ok": False, "checks": {}}))

    def test_validated_catalog_and_doctor_are_read_only(self):
        for doctor in (False, True):
            status, body = self.request(doctor)
            self.assertEqual(status, 200)
            self.assertIs(body["ok"], True)
            self.assertEqual(body["revision"], self.git("rev-parse", "HEAD", cwd=self.source).strip())
            self.assertEqual(body["source"], str(self.source))
            self.assertTrue({"archon-loop", "archon-ship-block", "archon-backlog", "archon-holdouts"}
                            .issubset(body["workflows"]))
            self.assertTrue(all(row["ok"] for row in body["checks"].values() if "ok" in row))
        self.assertEqual(body["checks"]["provider_authentication"],
                         {"status": "not_live_tested", "required": False})
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertTrue(all(call == ["--version"] or call[1] in ("workflow", "validate", "ai")
                            for call in calls))
        self.assertFalse(any(word in call for call in calls if "--help" not in call
                             for word in ("run", "auth", "trigger", "chat")))
        binding_checks = [call for call in calls if "--workflow-source" in call]
        self.assertTrue(binding_checks)
        self.assertTrue(all(str(self.source) in call and str(self.project) in call for call in binding_checks))

    def test_missing_and_malformed_consumer_settings(self):
        path = self.project / consumer.SETTINGS
        path.unlink()
        for doctor in (False, True):
            self.assert_unavailable(doctor, "consumer_settings")
        path.write_text("[")
        self.assert_unavailable(True, "consumer_settings")

    def test_mismatched_pin(self):
        self.settings["revision"] = "a" * 40
        self.save_settings()
        for doctor in (False, True):
            self.assert_unavailable(doctor, "pin_and_workflows")

    def test_missing_bun_uv_git_and_old_python(self):
        for tool in ("bun", "uv", "git"):
            with self.subTest(tool=tool):
                path = self.bin / tool
                hidden = path.rename(self.bin / (tool + "-hidden"))
                try:
                    for doctor in (False, True):
                        self.assert_unavailable(doctor, tool)
                finally:
                    hidden.rename(path)
        with patch("engine_diagnostics.sys.version_info", (3, 9)):
            self.assert_unavailable(True, "python")

    def test_malformed_native_json_failed_subprocess_and_incomplete_discovery(self):
        for mode in ("malformed", "subprocess_failure", "missing_workflow"):
            self.mode.write_text(mode)
            for doctor in (False, True):
                with self.subTest(mode=mode, doctor=doctor):
                    self.assert_unavailable(doctor, "pin_and_workflows")

    def test_unresolved_bindings_and_failed_native_binding_validation(self):
        for mode in ("unresolved_binding", "bad_binding"):
            self.mode.write_text(mode)
            self.assert_unavailable(True, "provider_model_bindings")

    def test_configured_bun_is_used(self):
        (self.bin / "bun").rename(self.bin / "pinned-bun")
        self.settings["bun"] = str(self.bin / "pinned-bun")
        self.save_settings()
        self.assertEqual(self.request(True)[0], 200)


if __name__ == "__main__":
    unittest.main()
