"""Read-only HTTP projection of pinned discovery and local engine readiness."""
from __future__ import annotations

from pathlib import Path
import subprocess
import sys

from factory import consumer


# No native error text is public: command output/configuration can contain secrets.
FAILURES = (ValueError, OSError, KeyError, TypeError, AttributeError,
            subprocess.SubprocessError)
REQUIRED_WORKFLOWS = {"archon-loop", "archon-ship-block", "archon-backlog", "archon-holdouts"}


class EngineDiagnostics:
    def __init__(self, root: Path):
        self.root = root

    def inspect(self, *, doctor: bool = False) -> tuple[int, dict]:
        checks = {}

        def check(name, action):
            try:
                result = action()
            except FAILURES:
                checks[name] = {"ok": False, "status": "failed"}
                return None
            checks[name] = {"ok": True, "status": "passed"}
            return result

        def python_version():
            if sys.version_info < (3, 10):
                raise ValueError("Python 3.10 or newer required")

        check("python", python_version)
        check("git", lambda: consumer.checked(["git", "--version"], self.root))
        check("uv", lambda: consumer.checked(["uv", "--version"], self.root))
        settings = check("consumer_settings", lambda: consumer.read_settings(self.root))
        catalog = None
        if checks["consumer_settings"]["ok"]:
            check("bun", lambda: consumer.checked([settings.get("bun", "bun"), "--version"], self.root))

            def pinned_catalog():
                # doctor verifies the immutable source, CLI capabilities, discovery,
                # pack completeness and every workflow through native validation.
                result = consumer.doctor(settings)
                names = result["workflows"]
                if (result["revision"] != settings["revision"]
                        or not isinstance(names, list)
                        or not all(isinstance(name, str) for name in names)
                        or not REQUIRED_WORKFLOWS.issubset(names)):
                    raise ValueError("Incomplete validated catalog")
                return result

            catalog = check("pin_and_workflows", pinned_catalog)
        else:
            checks["bun"] = {"ok": False, "status": "blocked"}
            checks["pin_and_workflows"] = {"ok": False, "status": "blocked"}

        if doctor:
            if catalog is not None:
                check("provider_model_bindings", lambda: self.bindings(settings, catalog))
            else:
                checks["provider_model_bindings"] = {"ok": False, "status": "blocked"}
            checks["provider_authentication"] = {"status": "not_live_tested", "required": False}

        ok = all(row["ok"] for row in checks.values() if row.get("required", True))
        result = {"ok": ok, "checks": checks}
        if ok:
            result.update({key: catalog[key] for key in ("source", "revision", "workflows")})
        else:
            result["error"] = "engine_prerequisites_unavailable"
        return (200 if ok else 503), result

    def bindings(self, settings: dict, catalog: dict) -> None:
        source = Path(catalog["source"])
        # These native reads resolve install/user bindings without invoking a model.
        tiers = consumer.native_json(settings, source, ["ai", "tier", "list"], self.root)
        aliases = consumer.native_json(settings, source, ["ai", "alias", "list"], self.root)
        rows = tiers["tiers"]
        if (not isinstance(rows, list) or len(rows) != 3
                or {row["tier"] for row in rows} != {"small", "medium", "large"}
                or not isinstance(aliases["aliases"], list)):
            raise ValueError("Native model bindings unavailable")
        for row in [*rows, *aliases["aliases"]]:
            binding = row["effective"]
            if not isinstance(binding, dict) or any(
                    not isinstance(binding.get(key), str) or not binding[key].strip()
                    for key in ("provider", "model")):
                raise ValueError("Unresolved native provider/model binding")
        # Resolve workflow model references in the application's native config,
        # while retaining the pinned workflow source rather than ambient discovery.
        for name in catalog["workflows"]:
            data = consumer.native_json(settings, source,
                                        ["validate", "workflows", name,
                                         "--workflow-source", str(source)], self.root)
            results = data.get("results")
            if (not isinstance(results, list) or not results
                    or any(row.get("valid") is not True for row in results)
                    or data.get("summary", {}).get("errors", 0)):
                raise ValueError("Native workflow binding validation failed")