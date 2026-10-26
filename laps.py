"""Public projection and supervised submission of the pinned engine's native lap records."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import time
import uuid

from factory.consumer import (
    cli,
    execute,
    native_json,
    read_settings,
    shared_root,
    verify_source,
    with_default_inputs,
)


class NativeStateError(ValueError):
    pass


class LapNotFound(LookupError):
    pass


class InvalidLapPayload(ValueError):
    pass


class LaunchBrakeError(RuntimeError):
    pass


class NativeLaunchError(RuntimeError):
    pass


def parse_launch_ack(raw: str) -> dict:
    if not isinstance(raw, str) or not raw.strip():
        raise NativeLaunchError("Empty native launch output")
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except json.JSONDecodeError:
        pass
    for start in reversed([m.start() for m in re.finditer(r"^\{", raw, re.M)]):
        try:
            data = json.loads(raw[start:])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            continue
    raise NativeLaunchError("Native launch output does not contain valid JSON")


def public_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    value = re.sub(r"(https?://)[^/\s]+@", r"\1[redacted]@", value)
    value = re.sub(r"(https?://[^\s?#]+)[?#][^\s]*", r"\1", value)
    value = re.sub(r"(?i)(bearer\s+|(?:token|password|secret|api[_-]?key)=)[^\s&]+",
                   r"\1[redacted]", value)
    return re.sub(r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b",
                  "[redacted]", value)


def fields(record: dict, names: tuple[str, ...]) -> dict:
    return {name: public_text(record.get(name)) for name in names}


def project_lap(run: dict) -> dict:
    events = run.get("events")
    if not isinstance(events, list):
        raise NativeStateError("Native detail has no events array")
    latest = {}
    transitions = []
    sessions = []
    candidate = None
    landed = False
    for event in sorted(events, key=lambda row: row["event_order"]):
        if event.get("workflow_run_id") != run["id"]:
            raise NativeStateError("Native event belongs to another run")
        kind, node = event.get("event_type"), event.get("step_name")
        if kind == "provider_event":
            continue
        data = event.get("data") or {}
        if node == "land" and kind == "node_completed":
            landed = True
        transitions.append({**fields(event, ("id", "event_type", "step_name", "created_at")),
                            "event_order": event["event_order"]})
        for scope in ("invocation", "attempt"):
            checkout = data.get(scope, {}).get("checkoutStart", {})
            if checkout.get("kind") == "git" and checkout.get("commit"):
                candidate = checkout["commit"]
        if data.get("session_id"):
            session = {"node": public_text(node),
                       "session_id": public_text(data["session_id"])}
            if session not in sessions:
                sessions.append(session)
        if kind in ("node_started", "node_completed", "node_failed", "node_skipped"):
            latest[node] = event

    def output(node: str) -> dict:
        event = latest.get(node, {})
        if event.get("event_type") != "node_completed":
            return {}
        result = event.get("data", {}).get("structured_output")
        return result if isinstance(result, dict) else {}

    subject, check, evidence, review = (output(node) for node in
                                         ("subject", "check-app", "evidence", "review"))
    head = subject.get("head")
    land = latest.get("land", {})
    approved = (
        not landed and run["status"] in ("running", "completed")
        and run.get("metadata", {}).get("inputs", {}).get("merge") == "approve"
        and isinstance(head, str) and re.fullmatch(r"[0-9a-f]{40}", head) is not None
        and candidate == head == check.get("head") == review.get("sha")
        and subject.get("pr") and subject["pr"] == check.get("pr") == review.get("pr")
        and check.get("overall") == "PASS" and evidence.get("ok") == "true"
        and review.get("outcome") == "approved"
        and land.get("event_type") == "node_skipped"
        and all(latest[a]["event_order"] < latest[b]["event_order"] for a, b in
                zip(("subject", "check-app", "evidence", "review"),
                    ("check-app", "evidence", "review", "land")))
    )
    approval = None
    if approved:
        approval = {"head": head, "pull_request": public_text(subject["pr"]),
                    "events": {name: fields(latest[name], ("id", "created_at")) for name in
                               ("subject", "check-app", "evidence", "review", "land")},
                    "verification": check["overall"], "evidence_ok": evidence["ok"],
                    "review_outcome": review["outcome"], "land": "node_skipped"}
    baseline = run.get("checkout_baseline") or {}
    source = run.get("metadata", {}).get("workflow_source", {})
    return {
        **fields(run, ("id", "workflow_name", "started_at", "completed_at", "last_activity_at")),
        "native_status": run["status"],
        "product_status": "waiting_approval" if approved else run["status"],
        "source": fields(source, ("origin", "digest", "captured_at")),
        "source_commit": public_text(baseline.get("commit")),
        "candidate_head": public_text(candidate or head),
        "work_item": public_text(output("pick").get("target")),
        "pull_request": public_text(subject.get("pr")),
        "session": {**fields(run, ("conversation_id", "working_path")),
                    "agents": sessions},
        "transitions": transitions,
        "approval_evidence": approval,
    }


class NativeLaps:
    def __init__(self, root: Path):
        self.root = root

    def submit(self, payload: bytes | str | dict) -> dict:
        if isinstance(payload, (bytes, bytearray)):
            try:
                payload = payload.decode("utf-8")
            except UnicodeDecodeError as error:
                raise InvalidLapPayload("Request body must be valid UTF-8 JSON") from error
        if isinstance(payload, str):
            try:
                data = json.loads(payload)
            except json.JSONDecodeError as error:
                raise InvalidLapPayload("Malformed JSON payload") from error
        elif isinstance(payload, dict):
            data = payload
        else:
            raise InvalidLapPayload("Payload must be a JSON object")

        if not isinstance(data, dict):
            raise InvalidLapPayload("Payload must be a JSON object")

        if set(data.keys()) != {"specification", "merge_mode"}:
            raise InvalidLapPayload("Payload must contain only 'specification' and 'merge_mode'")

        specification = data.get("specification")
        if not isinstance(specification, str) or not specification.strip():
            raise InvalidLapPayload("Specification must be a non-empty string")

        merge_mode = data.get("merge_mode")
        if merge_mode != "approve":
            raise InvalidLapPayload("Only merge_mode='approve' is supported")

        stop_path = shared_root(self.root) / ".factory/STOP"
        if stop_path.exists() or (self.root / ".factory/STOP").exists():
            raise LaunchBrakeError("Local launch brake is set")

        try:
            settings = read_settings(self.root)
            source = verify_source(settings)
        except (ValueError, OSError) as error:
            raise NativeStateError("Native engine configuration unavailable") from error

        unique_id = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}"
        branch = f"archon/lap-{unique_id}"
        conversation_id = f"session-{uuid.uuid4()}"

        args = [
            "archon-loop",
            "--detach",
            "--json",
            "--branch", branch,
            "--conversation-id", conversation_id,
            "--input", "merge=approve",
        ]
        args = with_default_inputs("archon-loop", args, args, self.root)
        argv = [
            *cli(settings, source),
            "workflow", "run",
            "--cwd", str(self.root),
            "--workflow-source", str(source),
            *args,
            "--",
            specification,
        ]

        try:
            result = execute(argv, self.root, capture=True)
        except (subprocess.SubprocessError, OSError) as error:
            raise NativeLaunchError("Failed to execute native launch process") from error

        if result.returncode != 0:
            raise NativeLaunchError(f"Native launch process exited with code {result.returncode}")

        ack = parse_launch_ack(result.stdout)
        if ack.get("ok") is False:
            raise NativeLaunchError("Native launch ack reported failure")

        run_id = ack.get("runId") or ack.get("id")
        if not run_id or not isinstance(run_id, str):
            raise NativeLaunchError("Native launch ack missing valid runId")

        status = ack.get("status") if isinstance(ack.get("status"), str) else "pending"
        return {"id": run_id, "status": status}

    def read(self, run_id: str | None = None) -> list[dict] | dict:
        if run_id is not None and re.fullmatch(r"[0-9a-f-]{32,36}", run_id) is None:
            raise LapNotFound()
        try:
            settings = read_settings(self.root)
            source = verify_source(settings)
            listing = native_json(settings, source,
                                  ["workflow", "runs", "--limit", "2147483647"], self.root)
            if (not isinstance(listing.get("runs"), list)
                    or (listing.get("scopeFallback") is True and listing["runs"])):
                raise NativeStateError("Native run scope unavailable")
            runs = [row for row in listing["runs"] if row["workflow_name"] == "archon-loop"]
            if run_id is not None:
                runs = [row for row in runs if row["id"] == run_id]
                if not runs:
                    raise LapNotFound()
            result = []
            for row in runs:
                detail = native_json(settings, source,
                                     ["workflow", "get", row["id"], "--verbose", "--events"], self.root)
                if detail.get("id") != row["id"] or detail.get("workflow_name") != "archon-loop":
                    raise NativeStateError("Native detail identity mismatch")
                result.append(project_lap(detail))
            return result[0] if run_id is not None else result
        except LapNotFound:
            raise
        except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
            raise NativeStateError("Native lap state unavailable") from error
