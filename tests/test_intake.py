"""Unit tests for deterministic intake ledger and admission gating (intake.py)."""
from __future__ import annotations

import json
import time
import unittest
from unittest.mock import MagicMock

from intake import (
    IntakeFetchError,
    IntakeService,
    evaluate_issue_admission,
    parse_dependencies,
)


class IntakeParsingTests(unittest.TestCase):
    def test_parse_dependencies_formats(self) -> None:
        self.assertEqual(parse_dependencies("Depends on: #42"), [42])
        self.assertEqual(parse_dependencies("Depends on: 42"), [42])
        self.assertEqual(parse_dependencies("Depends on: #10, #11, #12"), [10, 11, 12])
        self.assertEqual(parse_dependencies("depends on: #5\nDepends on: #6"), [5, 6])
        self.assertEqual(parse_dependencies("No dependencies here"), [])
        self.assertEqual(parse_dependencies(""), [])


class AdmissionRuleTests(unittest.TestCase):
    def test_completely_unlabeled_issue_is_held(self) -> None:
        """AC1: An issue with no labels is held with reason 'unlabeled_awaiting_triage'."""
        issue = {
            "number": 10,
            "title": "Unlabeled work",
            "state": "OPEN",
            "labels": [],
            "body": "Fix bug",
        }
        res = evaluate_issue_admission(issue, {10: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "unlabeled_awaiting_triage")

    def test_labeled_without_ready_is_held_missing_ready(self) -> None:
        issue = {
            "number": 10,
            "title": "Unlabeled work",
            "state": "OPEN",
            "labels": [{"name": "bug"}],
            "body": "Fix bug",
        }
        res = evaluate_issue_admission(issue, {10: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "missing_ready_label")

    def test_canonical_ready_for_agent_is_admitted(self) -> None:
        """AC2: Canonical 'ready-for-agent' is admitted with reason 'admitted_ready'."""
        issue = {
            "number": 11,
            "title": "Ready ticket",
            "state": "OPEN",
            "labels": [{"name": "ready-for-agent"}],
            "body": "Do work",
        }
        res = evaluate_issue_admission(issue, {11: issue})
        self.assertEqual(res.admission_status, "admitted")
        self.assertEqual(res.reason, "admitted_ready")

    def test_canonical_needs_info_blocks_admission(self) -> None:
        """AC3: 'needs-info' blocks admission."""
        issue = {
            "number": 12,
            "title": "Blocked ticket",
            "state": "OPEN",
            "labels": [{"name": "ready-for-agent"}, {"name": "needs-info"}],
            "body": "Held for info",
        }
        res = evaluate_issue_admission(issue, {12: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "held_by_label")

    def test_canonical_ready_for_human_blocks_admission(self) -> None:
        """AC3: 'ready-for-human' blocks admission."""
        issue = {
            "number": 12,
            "title": "Human only ticket",
            "state": "OPEN",
            "labels": [{"name": "ready-for-agent"}, {"name": "ready-for-human"}],
            "body": "Needs human architecture",
        }
        res = evaluate_issue_admission(issue, {12: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "held_by_label")

    def test_canonical_needs_triage_blocks_admission(self) -> None:
        """AC3: 'needs-triage' blocks admission."""
        issue = {
            "number": 12,
            "title": "Un-triaged ticket",
            "state": "OPEN",
            "labels": [{"name": "ready-for-agent"}, {"name": "needs-triage"}],
            "body": "Needs triage",
        }
        res = evaluate_issue_admission(issue, {12: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "held_by_label")

    def test_canonical_wontfix_excludes(self) -> None:
        """AC4: 'wontfix' excludes the issue."""
        issue = {
            "number": 13,
            "title": "Wontfix ticket",
            "state": "OPEN",
            "labels": [{"name": "ready-for-agent"}, {"name": "wontfix"}],
            "body": "Do not process",
        }
        res = evaluate_issue_admission(issue, {13: issue})
        self.assertEqual(res.admission_status, "excluded")
        self.assertEqual(res.reason, "excluded_by_label")

    def test_factory_ready_only_is_admitted(self) -> None:
        """AC5: Legacy 'factory:ready' is admitted for backward compatibility."""
        issue = {
            "number": 11,
            "title": "Ready ticket",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}],
            "body": "Do work",
        }
        res = evaluate_issue_admission(issue, {11: issue})
        self.assertEqual(res.admission_status, "admitted")
        self.assertEqual(res.reason, "admitted_ready")

    def test_factory_hold_blocks_admission(self) -> None:
        """AC5: Legacy 'factory:hold' blocks admission."""
        issue = {
            "number": 12,
            "title": "Blocked ticket",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}, {"name": "factory:hold"}],
            "body": "Held for design",
        }
        res = evaluate_issue_admission(issue, {12: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "held_by_label")

    def test_factory_exclude_overrides_everything(self) -> None:
        """AC5: Legacy 'factory:exclude' overrides everything."""
        issue = {
            "number": 13,
            "title": "Excluded ticket",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}, {"name": "factory:exclude"}],
            "body": "Do not process",
        }
        res = evaluate_issue_admission(issue, {13: issue})
        self.assertEqual(res.admission_status, "excluded")
        self.assertEqual(res.reason, "excluded_by_label")

    def test_closed_issue_is_held(self) -> None:
        issue = {
            "number": 14,
            "title": "Closed ticket",
            "state": "CLOSED",
            "labels": [{"name": "factory:ready"}],
            "body": "Already merged",
        }
        res = evaluate_issue_admission(issue, {14: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "issue_closed")

    def test_unsatisfied_dependency_blocks_admission(self) -> None:
        dep_issue = {
            "number": 20,
            "title": "Base feature",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}],
        }
        child_issue = {
            "number": 21,
            "title": "Child feature",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}],
            "body": "Depends on: #20",
        }
        all_issues = {20: dep_issue, 21: child_issue}
        res = evaluate_issue_admission(child_issue, all_issues)
        self.assertEqual(res.admission_status, "held")
        self.assertIn("waiting_on_dependency:#20", res.reason)
        self.assertEqual(res.unsatisfied_dependencies, [20])

    def test_satisfied_dependency_allows_admission(self) -> None:
        dep_issue = {
            "number": 30,
            "title": "Merged prerequisite",
            "state": "CLOSED",
            "labels": [{"name": "factory:ready"}],
        }
        child_issue = {
            "number": 31,
            "title": "Child feature ready",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}],
            "body": "Depends on: #30",
        }
        all_issues = {30: dep_issue, 31: child_issue}
        res = evaluate_issue_admission(child_issue, all_issues)
        self.assertEqual(res.admission_status, "admitted")
        self.assertEqual(res.reason, "admitted_ready")
        self.assertEqual(res.unsatisfied_dependencies, [])

    def test_active_claim_comment_blocks_admission(self) -> None:
        issue = {
            "number": 40,
            "title": "Active run ticket",
            "state": "OPEN",
            "labels": [{"name": "factory:ready"}],
            "body": "Feature X",
            "comments": [
                {"body": "Loop claim: run 1793010919204 (active)"}
            ],
        }
        res = evaluate_issue_admission(issue, {40: issue})
        self.assertEqual(res.admission_status, "held")
        self.assertEqual(res.reason, "actively_claimed")


class IntakeServiceTests(unittest.TestCase):
    def test_evaluate_backlog_with_mock_runner(self) -> None:
        mock_data = [
            {
                "number": 1,
                "title": "Merged infra",
                "state": "CLOSED",
                "labels": [{"name": "factory:ready"}],
                "body": "",
            },
            {
                "number": 2,
                "title": "Ready child",
                "state": "OPEN",
                "labels": [{"name": "factory:ready"}],
                "body": "Depends on: #1",
            },
            {
                "number": 3,
                "title": "Held child",
                "state": "OPEN",
                "labels": [{"name": "factory:ready"}],
                "body": "Depends on: #2",
            },
            {
                "number": 4,
                "title": "Unlabeled issue",
                "state": "OPEN",
                "labels": [],
                "body": "Needs triage",
            },
            {
                "number": 5,
                "title": "Manual override exclude",
                "state": "OPEN",
                "labels": [{"name": "factory:ready"}, {"name": "factory:exclude"}],
                "body": "",
            },
        ]
        runner = MagicMock(return_value=json.dumps(mock_data))
        service = IntakeService(repo="test-repo", ttl_seconds=10.0, runner=runner)

        res = service.evaluate_backlog()
        self.assertEqual(res["repo"], "test-repo")
        self.assertEqual(res["total_count"], 5)
        self.assertEqual(res["admitted_count"], 1)  # only #2 is admitted!
        self.assertEqual(res["held_count"], 3)      # #1 (closed), #3 (waiting on #2), #4 (unlabeled)
        self.assertEqual(res["excluded_count"], 1)  # #5 (exclude label)
        self.assertFalse(res["cached"])

        # Check get_next_admitted
        self.assertEqual(service.get_next_admitted(), 2)

        # Second call within TTL should return cached
        res2 = service.evaluate_backlog()
        self.assertTrue(res2["cached"])
        self.assertEqual(runner.call_count, 1)

        # Force refresh should invoke runner again
        res3 = service.evaluate_backlog(force_refresh=True)
        self.assertFalse(res3["cached"])
        self.assertEqual(runner.call_count, 2)

    def test_runner_failure_raises_fetch_error(self) -> None:
        runner = MagicMock(side_effect=Exception("gh network error"))
        service = IntakeService(repo="fail-repo", runner=runner)
        with self.assertRaises(IntakeFetchError):
            service.evaluate_backlog()

    def test_malformed_json_raises_fetch_error(self) -> None:
        runner = MagicMock(return_value="not valid json")
        service = IntakeService(repo="fail-repo", runner=runner)
        with self.assertRaises(IntakeFetchError):
            service.evaluate_backlog()


if __name__ == "__main__":
    unittest.main()
