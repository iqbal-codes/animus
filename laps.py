"""Public projection and supervised submission of the pinned engine's native lap records."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import time
import uuid

from factory.consumer import (
    PAUSE,
    cli,
    execute,
    invoke,
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


class ReportNotFound(LookupError):
    pass


class InvalidLapPayload(ValueError):
    pass


class LaunchBrakeError(RuntimeError):
    pass


class ControlActionError(RuntimeError):
    pass


class UnknownControlAction(ValueError):
    pass


class InvalidControlPayload(ValueError):
    pass


ALLOWED_CONTROL_ACTIONS: frozenset[str] = frozenset({"halt", "unhalt", "pause", "unpause"})


class Controls:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()

    def _resolve_paths(self) -> tuple[Path, Path]:
        try:
            shared = shared_root(self.root)
        except Exception:
            shared = self.root
        return shared / ".factory/STOP", shared / PAUSE

    def get_state(self) -> dict[str, bool]:
        try:
            stop_path, pause_path = self._resolve_paths()
            halted = stop_path.exists() or (self.root / ".factory/STOP").exists()
            paused = pause_path.exists() or (self.root / PAUSE).exists()
            return {"halted": bool(halted), "paused": bool(paused)}
        except Exception as error:
            raise NativeStateError("Failed to determine launch-brake state") from error

    def execute_action(self, action: str) -> dict[str, bool]:
        if action not in ALLOWED_CONTROL_ACTIONS:
            raise UnknownControlAction(f"Unknown control action: {action}")
        try:
            rc = invoke(self.root, action, [])
            if rc != 0:
                raise ControlActionError(f"Consumer action '{action}' returned non-zero code {rc}")
            if action == "unhalt":
                (self.root / ".factory/STOP").unlink(missing_ok=True)
            elif action == "unpause":
                (self.root / PAUSE).unlink(missing_ok=True)
        except Exception as error:
            if isinstance(error, UnknownControlAction):
                raise
            raise ControlActionError(f"Consumer action '{action}' failed: {error}") from error
        return self.get_state()


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
    meta = run.get("metadata") or {}
    tokens_in = run.get("total_tokens_in") or meta.get("total_tokens_in") or 0
    tokens_out = run.get("total_tokens_out") or meta.get("total_tokens_out") or 0
    cache_read = run.get("total_cache_read_tokens") or meta.get("total_cache_read_tokens") or 0
    cost_usd = run.get("total_cost_usd") if run.get("total_cost_usd") is not None else meta.get("total_cost_usd")

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
        "tokens": {
            "in": int(tokens_in) if isinstance(tokens_in, (int, float)) else 0,
            "out": int(tokens_out) if isinstance(tokens_out, (int, float)) else 0,
            "cache_read": int(cache_read) if isinstance(cache_read, (int, float)) else 0,
            "cost_usd": float(cost_usd) if isinstance(cost_usd, (int, float)) else 0.0,
        },
    }


REPORT_REL_PATHS: tuple[str, ...] = ("reviewer/report.md", "review/report.md")


def project_evidence(run: dict, artifacts_dir: Path | str | None = None) -> dict:
    if isinstance(artifacts_dir, str):
        artifacts_dir = Path(artifacts_dir)
    events = run.get("events")
    if not isinstance(events, list):
        raise NativeStateError("Native detail has no events array")
    latest = {}
    builder_sessions = set()
    candidate = None
    for event in sorted(events, key=lambda row: row.get("event_order", 0)):
        if event.get("workflow_run_id") != run["id"]:
            raise NativeStateError("Native event belongs to another run")
        kind, node = event.get("event_type"), event.get("step_name")
        if kind == "provider_event":
            continue
        data = event.get("data") or {}
        for scope in ("invocation", "attempt"):
            checkout = data.get(scope, {}).get("checkoutStart", {})
            if checkout.get("kind") == "git" and checkout.get("commit"):
                candidate = checkout["commit"]
        if node:
            node_lower = node.lower()
            if not any(ex in node_lower for ex in ("review", "check", "evidence", "subject", "pick", "claim", "land", "briefs", "doctor", "health")):
                if any(pat in node_lower for pat in ("build", "implement", "deliver", "ship")):
                    sid = data.get("session_id")
                    if sid:
                        builder_sessions.add(str(sid))
        if kind in ("node_started", "node_completed", "node_failed", "node_skipped"):
            latest[node] = event

    def output(node_name: str) -> dict:
        ev = latest.get(node_name, {})
        if ev.get("event_type") != "node_completed":
            return {}
        res = ev.get("data", {}).get("structured_output")
        return res if isinstance(res, dict) else {}

    subject_out = output("subject")
    raw_head = candidate or subject_out.get("head")
    candidate_head = public_text(raw_head) if (isinstance(raw_head, str) and raw_head.strip()) else None

    # Runtime verification projection
    check_event = latest.get("check-app")
    evidence_event = latest.get("evidence")
    if (not check_event or not evidence_event
            or check_event.get("event_type") != "node_completed"
            or evidence_event.get("event_type") != "node_completed"):
        runtime_status = "absent"
        runtime_verdict = None
        public_lines = []
        holdout_dict = {"verdict": None, "lines": []}
    else:
        check_out = output("check-app")
        evidence_out = output("evidence")
        raw_check_head = check_out.get("head")
        check_head = public_text(raw_check_head) if (isinstance(raw_check_head, str) and raw_check_head.strip()) else None
        check_overall = check_out.get("overall")
        evidence_ok = str(evidence_out.get("ok", "")).lower() == "true"

        raw_lines = check_out.get("lines") or []
        public_lines = []
        holdout_lines = []
        if isinstance(raw_lines, list):
            for l in raw_lines:
                if not isinstance(l, dict):
                    continue
                lid = public_text(str(l.get("id", "")))
                lverdict = public_text(str(l.get("verdict", "")))
                lkind = public_text(str(l.get("kind", "")))
                if lkind == "holdout":
                    holdout_lines.append({"id": lid, "verdict": lverdict})
                else:
                    public_lines.append({"id": lid, "kind": lkind, "verdict": lverdict})

        if holdout_lines:
            if any(l.get("verdict") in ("FAIL", "FAILED", "ERROR") for l in holdout_lines):
                holdout_verdict = "FAIL"
            elif all(l.get("verdict") == "PASS" for l in holdout_lines):
                holdout_verdict = "PASS"
            else:
                holdout_verdict = "INCOMPLETE"
        else:
            raw_holdout = check_out.get("holdout")
            if isinstance(raw_holdout, dict):
                raw_hv = raw_holdout.get("verdict") or raw_holdout.get("overall")
                holdout_verdict = public_text(str(raw_hv)) if raw_hv is not None else None
            else:
                holdout_verdict = None

        holdout_dict = {"verdict": holdout_verdict, "lines": holdout_lines}

        if not candidate_head or check_head != candidate_head:
            runtime_status = "inconclusive"
            runtime_verdict = None
        elif check_overall in ("FAIL", "FAILED", "ERROR") or not evidence_ok or holdout_verdict in ("FAIL", "FAILED", "ERROR"):
            runtime_status = "failed"
            runtime_verdict = "FAIL"
        elif check_overall == "PASS" and evidence_ok and holdout_verdict in ("PASS", None):
            runtime_status = "verified"
            runtime_verdict = "PASS"
        else:
            runtime_status = "inconclusive"
            runtime_verdict = None

    # Peer review projection
    review_event = latest.get("review")
    if not review_event or review_event.get("event_type") != "node_completed":
        review_status = "absent"
        review_sha = None
        review_outcome = None
        independent = False
        reviewer_session = None
        blocking_findings = 0
        report_info = {"available": False, "path": None, "url": None}
    else:
        review_out = output("review")
        raw_review_sha = review_out.get("sha")
        review_sha = public_text(raw_review_sha) if (isinstance(raw_review_sha, str) and raw_review_sha.strip()) else None
        raw_outcome = review_out.get("outcome")
        review_outcome = public_text(raw_outcome) if (isinstance(raw_outcome, str) and raw_outcome.strip()) else None
        raw_session = review_event.get("data", {}).get("session_id")
        raw_session_str = str(raw_session) if raw_session else None
        reviewer_session = public_text(raw_session_str) if raw_session_str else None

        if not raw_session_str or not builder_sessions:
            independent = False
        elif raw_session_str in builder_sessions:
            independent = False
        else:
            independent = True

        blocking_findings = 0
        seen_finding_ids = set()
        dispositions = review_out.get("dispositions")
        if isinstance(dispositions, list):
            for d in dispositions:
                if isinstance(d, dict):
                    if (d.get("action") in ("blocks", "block")
                            or d.get("disposition") == "blocking"
                            or d.get("severity") == "blocking"):
                        fid = d.get("id")
                        if fid:
                            seen_finding_ids.add(fid)
                        blocking_findings += 1
                elif isinstance(d, str) and "block" in d.lower():
                    blocking_findings += 1

        findings_ambiguous = False
        if artifacts_dir:
            for sub in ("review", "reviewer"):
                findings_path = (artifacts_dir / sub / "findings.json").resolve()
                if findings_path.is_file() and findings_path.is_relative_to(artifacts_dir.resolve()):
                    try:
                        f_data = json.loads(findings_path.read_text(encoding="utf-8"))
                        if isinstance(f_data, list):
                            for f in f_data:
                                if isinstance(f, dict) and f.get("severity") == "blocking" and f.get("status") == "open":
                                    fid = f.get("id")
                                    if fid:
                                        if fid not in seen_finding_ids:
                                            seen_finding_ids.add(fid)
                                            blocking_findings += 1
                                    else:
                                        blocking_findings += 1
                        else:
                            findings_ambiguous = True
                    except Exception:
                        findings_ambiguous = True

        report_available = False
        report_rel_path = None
        if artifacts_dir:
            for rel in REPORT_REL_PATHS:
                target = (artifacts_dir / rel).resolve()
                if target.is_file() and target.is_relative_to(artifacts_dir.resolve()):
                    report_available = True
                    report_rel_path = rel
                    break

        report_info = {
            "available": report_available,
            "path": report_rel_path,
            "url": f"/api/laps/{run['id']}/evidence/report" if report_available else None,
        }

        if not candidate_head or review_sha != candidate_head:
            review_status = "stale"
        elif not independent or findings_ambiguous:
            review_status = "not_ready"
        elif blocking_findings > 0 or review_outcome in ("sent-back", "needs-owner", "failed", "rejected"):
            review_status = "failed"
        elif runtime_status != "verified":
            review_status = "not_ready"
        elif review_outcome in ("approved", "merge"):
            review_status = "ready"
        else:
            review_status = "not_ready"

    return {
        "id": run["id"],
        "workflow_name": run.get("workflow_name"),
        "candidate_head": candidate_head,
        "runtime_verification": {
            "status": runtime_status,
            "verdict": runtime_verdict,
            "lines": public_lines,
            "holdout": holdout_dict,
        },
        "peer_review": {
            "status": review_status,
            "sha": review_sha,
            "outcome": review_outcome,
            "independent": independent,
            "reviewer_session": reviewer_session,
            "blocking_findings": blocking_findings,
            "report": report_info,
        },
    }


class NativeLaps:
    def __init__(self, root: Path):
        self.root = root
        self._run_cache: dict[tuple, dict] = {}
        self._list_cache: list[dict] | None = None
        self._list_cache_time: float = 0.0

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

    def _get_run_detail(self, run_id: str) -> dict:
        if re.fullmatch(r"[0-9a-f-]{32,36}", run_id) is None:
            raise LapNotFound()
        try:
            settings = read_settings(self.root)
            source = verify_source(settings)
            listing = native_json(settings, source,
                                  ["workflow", "runs", "--limit", "2147483647"], self.root)
            if (not isinstance(listing.get("runs"), list)
                    or (listing.get("scopeFallback") is True and listing["runs"])):
                raise NativeStateError("Native run scope unavailable")
            runs = [row for row in listing["runs"] if row.get("workflow_name") == "archon-loop" and row.get("id") == run_id]
            if not runs:
                raise LapNotFound()
            row = runs[0]
            cache_key = (run_id, row.get("status"), row.get("last_activity_at"))
            if cache_key in self._run_cache:
                return self._run_cache[cache_key]
            detail = native_json(settings, source,
                                 ["workflow", "get", run_id, "--verbose", "--events"], self.root)
            if detail.get("id") != run_id or detail.get("workflow_name") != "archon-loop":
                raise NativeStateError("Native detail identity mismatch")
            self._run_cache[cache_key] = detail
            return detail
        except LapNotFound:
            raise
        except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
            raise NativeStateError("Native lap state unavailable") from error

    def _find_artifacts_dir(self, run_id: str, output_root: str | None = None) -> Path | None:
        candidates = []
        if output_root:
            candidates.append(Path(output_root) / "artifacts" / "runs" / run_id)
        candidates.append(self.root / "artifacts" / "runs" / run_id)
        try:
            candidates.append(shared_root(self.root) / "artifacts" / "runs" / run_id)
        except Exception:
            pass
        for path in candidates:
            try:
                resolved = path.resolve()
                if resolved.is_dir():
                    return resolved
            except OSError:
                continue
        return None

    def read_evidence(self, run_id: str) -> dict:
        detail = self._get_run_detail(run_id)
        artifacts_dir = self._find_artifacts_dir(run_id, detail.get("output_root"))
        return project_evidence(detail, artifacts_dir)

    def read_report(self, run_id: str) -> tuple[str, str]:
        detail = self._get_run_detail(run_id)
        artifacts_dir = self._find_artifacts_dir(run_id, detail.get("output_root"))
        if not artifacts_dir:
            raise ReportNotFound()
        report_file = None
        for rel in REPORT_REL_PATHS:
            target = (artifacts_dir / rel).resolve()
            if target.is_file() and target.is_relative_to(artifacts_dir.resolve()):
                report_file = target
                break
        if not report_file:
            raise ReportNotFound()
        try:
            content = report_file.read_text(encoding="utf-8")
        except OSError as error:
            raise NativeStateError("Report read failed") from error
        return public_text(content), "text/markdown; charset=utf-8"

    def read(self, run_id: str | None = None) -> list[dict] | dict:
        if run_id is not None:
            return project_lap(self._get_run_detail(run_id))
        try:
            settings = read_settings(self.root)
            source = verify_source(settings)
            listing = native_json(settings, source,
                                  ["workflow", "runs", "--limit", "2147483647"], self.root)
            if (not isinstance(listing.get("runs"), list)
                    or (listing.get("scopeFallback") is True and listing["runs"])):
                raise NativeStateError("Native run scope unavailable")
            runs = [row for row in listing["runs"] if row["workflow_name"] == "archon-loop"]
            result = []
            for row in runs:
                rid = row["id"]
                cache_key = (rid, row.get("status"), row.get("last_activity_at"))
                if cache_key in self._run_cache:
                    detail = self._run_cache[cache_key]
                else:
                    detail = native_json(settings, source,
                                         ["workflow", "get", rid, "--verbose", "--events"], self.root)
                    if detail.get("id") != rid or detail.get("workflow_name") != "archon-loop":
                        raise NativeStateError("Native detail identity mismatch")
                    self._run_cache[cache_key] = detail
                result.append(project_lap(detail))
            return result
        except LapNotFound:
            raise
        except (ValueError, OSError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as error:
            raise NativeStateError("Native lap state unavailable") from error
