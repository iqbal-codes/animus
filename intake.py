"""Deterministic intake ledger and admission gating for LabQ Software Factory."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
import json
import logging
import re
import shutil
import subprocess
import threading
from typing import Any, Callable

from factory.jev_client import (
    ChoiceAnswer,
    JevClient,
    JevError,
    NoulAnswer,
    ScoreAnswer,
)

logger = logging.getLogger(__name__)

DEPENDS_ON_PATTERN = re.compile(r"(?i)depends\s+on\s*:\s*([^\n\r]+)")
ISSUE_NUM_PATTERN = re.compile(r"#?(\d+)")
CLAIM_PATTERN = re.compile(r"Loop claim: run ([a-zA-Z0-9_\-]+)")

JEV_TRIAGE_QUESTIONS = {
    "is_actionable": {
        "type": "noul",
        "instructions": "Does the issue have clear and unambiguous acceptance criteria?",
    },
    "triage_category": {
        "type": "choice",
        "instructions": "Categorize the issue",
        "criteria": {
            "ready_for_agent": "Fully specified with unambiguous acceptance criteria",
            "needs_info": "Vague or missing acceptance criteria",
            "ready_for_human": "Requires human decision or high-level architecture",
        },
    },
    "complexity": {
        "type": "score",
        "instructions": "Rate complexity of the task",
        "criteria": [
            "trivial_single_line",
            "small_single_file",
            "medium_multi_file",
            "large_system_wide",
        ],
    },
}


class IntakeError(Exception):
    """Base exception for intake processing errors."""
    pass


class IntakeFetchError(IntakeError):
    """Raised when querying GitHub issues fails."""
    pass


@dataclass
class EvaluatedIssue:
    number: int
    title: str
    state: str
    admission_status: str  # "admitted", "held", "excluded"
    reason: str
    labels: list[str] = field(default_factory=list)
    dependencies: list[int] = field(default_factory=list)
    unsatisfied_dependencies: list[int] = field(default_factory=list)
    recommended_label: str | None = None
    confidence: float | None = None
    complexity: float | None = None
    probabilities: dict[str, float] | None = None
    jev_evaluation: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "number": self.number,
            "title": self.title,
            "state": self.state,
            "admission_status": self.admission_status,
            "reason": self.reason,
            "labels": list(self.labels),
            "dependencies": list(self.dependencies),
            "unsatisfied_dependencies": list(self.unsatisfied_dependencies),
        }
        if self.recommended_label is not None:
            data["recommended_label"] = self.recommended_label
        if self.confidence is not None:
            data["confidence"] = self.confidence
        if self.complexity is not None:
            data["complexity"] = self.complexity
        if self.probabilities is not None:
            data["probabilities"] = dict(self.probabilities)
        if self.jev_evaluation is not None:
            data["jev_evaluation"] = dict(self.jev_evaluation)
        return data


def parse_dependencies(text: str) -> list[int]:
    """Extract list of dependency issue numbers from 'Depends on: #1, #2' lines."""
    if not text:
        return []
    deps: list[int] = []
    for match in DEPENDS_ON_PATTERN.finditer(text):
        clause = match.group(1)
        for num_match in ISSUE_NUM_PATTERN.finditer(clause):
            try:
                num = int(num_match.group(1))
                if num not in deps:
                    deps.append(num)
            except ValueError:
                continue
    return deps


def is_active_claim(comments: list[dict[str, Any]]) -> bool:
    """Check if issue has an unreleased/active loop claim comment."""
    for comment in comments:
        body = comment.get("body", "")
        if CLAIM_PATTERN.search(body):
            return True
    return False


def run_jev_advisory(
    title: str,
    body: str,
    labels: list[str],
    jev_client: JevClient,
) -> tuple[str | None, float | None, float | None, dict[str, float] | None, str, dict[str, Any] | None]:
    """Execute Jev System 1 advisory evaluation on state context."""
    state_text = f"Title: {title}\nBody: {body}\nLabels: {', '.join(labels)}"
    try:
        eval_result = jev_client.evaluate(state_text, JEV_TRIAGE_QUESTIONS)
        noul_ans = eval_result.answers.get("is_actionable")
        choice_ans = eval_result.answers.get("triage_category")
        score_ans = eval_result.answers.get("complexity")

        is_actionable = noul_ans.noul if isinstance(noul_ans, NoulAnswer) else 0.0
        choice = choice_ans.choice if isinstance(choice_ans, ChoiceAnswer) else ""
        confidence = choice_ans.confidence if isinstance(choice_ans, ChoiceAnswer) else 0.0
        probabilities = choice_ans.probabilities if isinstance(choice_ans, ChoiceAnswer) else None
        complexity = score_ans.score if isinstance(score_ans, ScoreAnswer) else None

        if choice == "ready_for_agent" and confidence >= 0.70 and is_actionable >= 0.70:
            rec_label = "ready-for-agent"
            rec_reason = "clear_acceptance_criteria"
        elif choice == "ready_for_human" and confidence >= 0.70:
            rec_label = "ready-for-human"
            rec_reason = "requires_human_architecture"
        else:
            rec_label = "needs-info"
            rec_reason = "unclear_acceptance_criteria"

        jev_meta = {
            "id": eval_result.id,
            "model": eval_result.model,
            "is_actionable": is_actionable,
            "choice": choice,
            "confidence": confidence,
            "complexity": complexity,
            "probabilities": probabilities,
            "recommendation_reason": rec_reason,
        }
        return rec_label, confidence, complexity, probabilities, rec_reason, jev_meta
    except JevError as err:
        logger.warning("Jev advisory evaluation error: %s", err)
        return None, None, None, None, "evaluation_error:jev_unreachable", None


def check_jev_advisory(
    title: str,
    body: str,
    labels: list[str],
    jev_client: JevClient | None,
) -> tuple[str | None, float | None, float | None, dict[str, float] | None, dict[str, Any] | None, str | None]:
    """Execute Jev advisory evaluation if client is configured. Returns (rec_label, conf, comp, probs, jev_meta, err_reason)."""
    if jev_client is None:
        return None, None, None, None, None, None

    if not getattr(jev_client, "is_configured", False):
        logger.warning("JevClient is not configured (missing API key or transport); running in static label mode.")
        return None, None, None, None, None, None

    rec_label, conf, comp, probs, rec_reason, jev_meta = run_jev_advisory(
        title=title, body=body, labels=labels, jev_client=jev_client
    )
    if rec_reason == "evaluation_error:jev_unreachable":
        return None, None, None, None, None, "evaluation_error:jev_unreachable"

    return rec_label, conf, comp, probs, jev_meta, None


def evaluate_issue_admission(
    issue: dict[str, Any],
    all_issues_by_number: dict[int, dict[str, Any]],
    jev_client: JevClient | None = None,
) -> EvaluatedIssue:
    number = int(issue.get("number", 0))
    title = str(issue.get("title", ""))
    state = str(issue.get("state", "OPEN")).upper()

    raw_labels = issue.get("labels", [])
    label_names: list[str] = []
    for lbl in raw_labels:
        if isinstance(lbl, dict):
            name = str(lbl.get("name", "")).strip()
        else:
            name = str(lbl).strip()
        if name:
            label_names.append(name)

    lower_labels = {name.lower() for name in label_names}

    # Extract dependencies from body and comments
    body = str(issue.get("body") or "")
    deps = parse_dependencies(body)
    comments = issue.get("comments") or []
    if isinstance(comments, list):
        for c in comments:
            if isinstance(c, dict):
                c_body = str(c.get("body") or "")
                for d in parse_dependencies(c_body):
                    if d not in deps:
                        deps.append(d)

    # Check unsatisfied dependencies
    unsatisfied: list[int] = []
    for dep_num in deps:
        dep_issue = all_issues_by_number.get(dep_num)
        if dep_issue is None:
            # Referenced issue not in fetched backlog or not closed
            unsatisfied.append(dep_num)
        else:
            dep_state = str(dep_issue.get("state", "OPEN")).upper()
            if dep_state != "CLOSED":
                unsatisfied.append(dep_num)

    # 1. State check: closed issues are not admitted
    if state != "OPEN":
        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason="issue_closed",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
        )

    # 2. Unlabeled check: fail-closed for issues lacking labels
    if not lower_labels:
        rec_label, conf, comp, probs, jev_meta, err_reason = check_jev_advisory(
            title, body, label_names, jev_client
        )
        if err_reason:
            return EvaluatedIssue(
                number=number,
                title=title,
                state=state,
                admission_status="held",
                reason=err_reason,
                labels=label_names,
                dependencies=deps,
                unsatisfied_dependencies=unsatisfied,
            )

        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason="unlabeled_awaiting_triage",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
            recommended_label=rec_label,
            confidence=conf,
            complexity=comp,
            probabilities=probs,
            jev_evaluation=jev_meta,
        )

    # 3. Exclude check: wontfix and legacy factory:exclude override everything
    exclusion_labels = {"wontfix", "factory:exclude"}
    if any(lbl in lower_labels for lbl in exclusion_labels):
        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="excluded",
            reason="excluded_by_label",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
        )

    # 4. Hold check: canonical needs-info/ready-for-human/needs-triage and legacy factory:hold block admission
    blocking_labels = {"needs-info", "ready-for-human", "needs-triage", "factory:hold"}
    if any(lbl in lower_labels for lbl in blocking_labels):
        rec_label, conf, comp, probs, jev_meta, err_reason = None, None, None, None, None, None
        if "needs-triage" in lower_labels:
            rec_label, conf, comp, probs, jev_meta, err_reason = check_jev_advisory(
                title, body, label_names, jev_client
            )
            if err_reason:
                return EvaluatedIssue(
                    number=number,
                    title=title,
                    state=state,
                    admission_status="held",
                    reason=err_reason,
                    labels=label_names,
                    dependencies=deps,
                    unsatisfied_dependencies=unsatisfied,
                )

        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason="held_by_label",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
            recommended_label=rec_label,
            confidence=conf,
            complexity=comp,
            probabilities=probs,
            jev_evaluation=jev_meta,
        )

    # 5. Ready check: canonical ready-for-agent or legacy factory:ready is strictly required
    ready_labels = {"ready-for-agent", "factory:ready"}
    if not any(lbl in lower_labels for lbl in ready_labels):
        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason="missing_ready_label",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
        )

    # 5. Dependency check: all prerequisites must be CLOSED
    if unsatisfied:
        reason_deps = ",".join(f"#{d}" for d in unsatisfied)
        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason=f"waiting_on_dependency:{reason_deps}",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
        )

    # 6. Active claim check
    if isinstance(comments, list) and is_active_claim(comments):
        return EvaluatedIssue(
            number=number,
            title=title,
            state=state,
            admission_status="held",
            reason="actively_claimed",
            labels=label_names,
            dependencies=deps,
            unsatisfied_dependencies=unsatisfied,
        )

    # All invariants satisfied -> Admitted
    return EvaluatedIssue(
        number=number,
        title=title,
        state=state,
        admission_status="admitted",
        reason="admitted_ready",
        labels=label_names,
        dependencies=deps,
        unsatisfied_dependencies=[],
    )


class IntakeService:
    """Manages GitHub issue fetching, evaluation, and in-memory caching."""

    def __init__(
        self,
        repo: str = "labq-software-factory",
        ttl_seconds: float = 60.0,
        runner: Callable[[list[str]], str] | None = None,
        jev_client: JevClient | None = None,
    ) -> None:
        self.repo = repo
        self.ttl_seconds = ttl_seconds
        self._runner = runner or self._default_runner
        self.jev_client = jev_client
        self._lock = threading.Lock()
        self._cached_result: dict[str, Any] | None = None
        self._cached_at: float = 0.0

    @staticmethod
    def _default_runner(cmd: list[str]) -> str:
        exe = shutil.which(cmd[0])
        if not exe:
            raise IntakeFetchError(f"CLI executable '{cmd[0]}' not found on PATH")
        result = subprocess.run(
            [exe, *cmd[1:]],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if result.returncode != 0:
            raise IntakeFetchError(
                f"Command failed ({result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
            )
        return result.stdout

    def fetch_raw_issues(self) -> list[dict[str, Any]]:
        """Fetch raw issue payload from GitHub via gh CLI."""
        repo_arg = self.repo
        if "/" not in repo_arg:
            repo_arg = f"iqbal-codes/{repo_arg}"
        cmd = [
            "gh",
            "issue",
            "list",
            "--repo",
            repo_arg,
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            "number,title,labels,body,state,comments",
        ]
        try:
            output = self._runner(cmd)
            data = json.loads(output)
            if not isinstance(data, list):
                raise IntakeFetchError("Expected JSON array of issues from GitHub CLI")
            return data
        except json.JSONDecodeError as exc:
            raise IntakeFetchError(f"Failed to parse JSON from GitHub CLI: {exc}") from exc
        except Exception as exc:
            if isinstance(exc, IntakeFetchError):
                raise
            raise IntakeFetchError(f"GitHub issues query failed: {exc}") from exc

    def evaluate_backlog(self, force_refresh: bool = False) -> dict[str, Any]:
        """Evaluate admission for all backlog issues with 60-second caching."""
        now = datetime.now(timezone.utc).timestamp()
        with self._lock:
            if (
                not force_refresh
                and self._cached_result is not None
                and (now - self._cached_at) < self.ttl_seconds
            ):
                return {**self._cached_result, "cached": True}

            raw_issues = self.fetch_raw_issues()
            by_number = {int(i["number"]): i for i in raw_issues if "number" in i}

            evaluated: list[EvaluatedIssue] = []
            for issue in raw_issues:
                evaluated.append(evaluate_issue_admission(issue, by_number, jev_client=self.jev_client))

            # Sort by issue number ascending
            evaluated.sort(key=lambda x: x.number)

            admitted_count = sum(1 for x in evaluated if x.admission_status == "admitted")
            held_count = sum(1 for x in evaluated if x.admission_status == "held")
            excluded_count = sum(1 for x in evaluated if x.admission_status == "excluded")

            result = {
                "repo": self.repo,
                "as_of": datetime.now(timezone.utc).isoformat(),
                "cached": False,
                "total_count": len(evaluated),
                "admitted_count": admitted_count,
                "held_count": held_count,
                "excluded_count": excluded_count,
                "issues": [x.to_dict() for x in evaluated],
            }

            self._cached_result = result
            self._cached_at = now
            return result

    def poll(self, force_refresh: bool = False) -> dict[str, Any]:
        """Poll and evaluate the backlog (alias for evaluate_backlog per Spec §2)."""
        return self.evaluate_backlog(force_refresh=force_refresh)

    def get_next_admitted(self) -> int | None:
        """Return the next admitted open issue number, or None if none admitted."""
        backlog = self.evaluate_backlog()
        for issue in backlog.get("issues", []):
            if issue.get("admission_status") == "admitted" and issue.get("state") == "OPEN":
                return int(issue["number"])
        return None

    def get_evaluated_issue(self, number: int, force_refresh: bool = False) -> dict[str, Any] | None:
        """Return the evaluation result for a specific issue number, or None if not found."""
        backlog = self.evaluate_backlog(force_refresh=force_refresh)
        for issue in backlog.get("issues", []):
            if issue.get("number") == number:
                return issue
        return None

    def invalidate_cache(self) -> None:
        with self._lock:
            self._cached_result = None
            self._cached_at = 0.0
