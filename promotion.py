"""Promotion engine and configuration inspectors for LabQ Software Factory."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import logging
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Callable

logger = logging.getLogger(__name__)

TICKET_PATTERN = re.compile(r"#(\d+)")


class PromotionError(Exception):
    """Base exception for promotion errors."""
    pass


class NoUnpromotedCommitsError(PromotionError):
    """Raised when develop has no unpromoted commits relative to main."""
    pass


class PromotionPROverlapError(PromotionError):
    """Raised when a promotion PR is already open."""
    pass


class PromotionExecutionError(PromotionError):
    """Raised when git or gh commands fail during promotion."""
    pass


def read_schedule_config(root: Path) -> dict[str, Any]:
    """Read .factory/schedule.json safely."""
    path = root / ".factory/schedule.json"
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def read_models_config(root: Path) -> dict[str, Any]:
    """Read model tiers and aliases from .archon/config.yaml."""
    path = root / ".archon/config.yaml"
    if not path.is_file():
        return {}
    try:
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.warning("Failed to parse .archon/config.yaml: %s", exc)
        return {}


class PromotionService:
    """Manages diff calculation between develop and main, and promotion PR creation."""

    def __init__(
        self,
        root: Path,
        main_branch: str = "main",
        develop_branch: str = "develop",
        runner: Callable[[list[str], Path], str] | None = None,
    ) -> None:
        self.root = root
        self.main_branch = main_branch
        self.develop_branch = develop_branch
        self._runner = runner or self._default_runner

    @staticmethod
    def _default_runner(cmd: list[str], cwd: Path) -> str:
        exe = shutil.which(cmd[0])
        if not exe:
            raise PromotionExecutionError(f"CLI executable '{cmd[0]}' not found on PATH")
        result = subprocess.run(
            [exe, *cmd[1:]],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        if result.returncode != 0:
            err = result.stderr.strip() or result.stdout.strip()
            raise PromotionExecutionError(f"Command {' '.join(cmd[:3])} failed ({result.returncode}): {err}")
        return result.stdout

    def _resolve_rev_range(self) -> str | None:
        """Resolve compare range: prefer origin/main..origin/develop, fall back to main..develop."""
        try:
            self._runner(["git", "rev-parse", "--verify", f"origin/{self.develop_branch}"], self.root)
            return f"origin/{self.main_branch}..origin/{self.develop_branch}"
        except Exception:
            pass

        try:
            self._runner(["git", "rev-parse", "--verify", self.develop_branch], self.root)
            return f"{self.main_branch}..{self.develop_branch}"
        except Exception:
            return None

    def get_existing_promotion_pr(self) -> dict[str, Any] | None:
        """Check if an open promotion PR already exists from develop to main."""
        cmd = [
            "gh",
            "pr",
            "list",
            "--base",
            self.main_branch,
            "--head",
            self.develop_branch,
            "--state",
            "open",
            "--json",
            "number,url,title",
        ]
        try:
            output = self._runner(cmd, self.root)
            data = json.loads(output)
            if isinstance(data, list) and len(data) > 0:
                item = data[0]
                return {
                    "number": int(item.get("number", 0)),
                    "url": str(item.get("url", "")),
                    "title": str(item.get("title", "")),
                }
        except Exception as exc:
            logger.debug("Failed to query existing promotion PR via gh: %s", exc)
        return None

    def get_status(self) -> dict[str, Any]:
        """Compute unpromoted commit count, delivered ticket numbers, and candidate freeze state."""
        rev_range = self._resolve_rev_range()
        commits: list[dict[str, str]] = []
        ticket_numbers: list[int] = []

        if rev_range:
            try:
                # Format: hash|subject|author|iso_date
                log_output = self._runner(
                    ["git", "log", rev_range, "--pretty=format:%H|%s|%an|%cI"],
                    self.root,
                )
                for line in log_output.strip().splitlines():
                    if not line.strip():
                        continue
                    parts = line.split("|", 3)
                    if len(parts) >= 2:
                        h, subj = parts[0], parts[1]
                        author = parts[2] if len(parts) > 2 else ""
                        date = parts[3] if len(parts) > 3 else ""
                        commits.append({
                            "hash": h,
                            "subject": subj,
                            "author": author,
                            "date": date,
                        })
                        for match in TICKET_PATTERN.finditer(subj):
                            num = int(match.group(1))
                            if num not in ticket_numbers:
                                ticket_numbers.append(num)
            except Exception as exc:
                logger.warning("Failed to run git log for promotion diff (%s): %s", rev_range, exc)

        ticket_numbers.sort()
        pause_file = self.root / ".factory/PAUSE"
        candidate_freeze = pause_file.is_file()
        existing_pr = self.get_existing_promotion_pr()

        return {
            "main_branch": self.main_branch,
            "develop_branch": self.develop_branch,
            "rev_range": rev_range,
            "unpromoted_count": len(commits),
            "commits": commits,
            "delivered_tickets": ticket_numbers,
            "candidate_freeze": candidate_freeze,
            "existing_pr": existing_pr,
            "ready_to_promote": len(commits) > 0 and existing_pr is None,
        }

    def prepare_promotion(
        self,
        title: str | None = None,
        summary: str | None = None,
    ) -> dict[str, Any]:
        """Prepare batch promotion PR from develop to main and activate Candidate Freeze."""
        status = self.get_status()

        if status["unpromoted_count"] == 0:
            raise NoUnpromotedCommitsError(
                f"No unpromoted commits found between {self.main_branch} and {self.develop_branch}"
            )

        if status["existing_pr"] is not None:
            existing = status["existing_pr"]
            raise PromotionPROverlapError(
                f"Promotion PR #{existing['number']} is already open: {existing['url']}"
            )

        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        pr_title = title or f"chore(release): promote develop to main [batch {date_str}]"

        # Build comprehensive PR description
        lines = [
            f"## Release Promotion: {self.develop_branch} → {self.main_branch}",
            "",
            f"Automated candidate promotion containing **{status['unpromoted_count']}** verified commits.",
            "",
        ]

        if status["delivered_tickets"]:
            lines.append("### Delivered Work Items")
            for t in status["delivered_tickets"]:
                lines.append(f"- Closes #{t}")
            lines.append("")

        lines.append("### Included Commits")
        for c in status["commits"][:30]:  # Cap listing
            short_h = c["hash"][:7] if len(c["hash"]) >= 7 else c["hash"]
            lines.append(f"- `{short_h}` {c['subject']} ({c['author']})")
        if len(status["commits"]) > 30:
            lines.append(f"- *...and {len(status['commits']) - 30} more commits*")

        lines.append("")
        lines.append("### Candidate Verification Summary")
        lines.append("- All intermediate pull requests verified through Archon SDLC stages before landing into develop.")
        lines.append("- Staging candidate frozen via `.factory/PAUSE` during operator review.")
        lines.append("")
        lines.append("---")
        lines.append("🤖 Generated with [Claude Code](https://claude.com/claude-code)")

        body_text = "\n".join(lines)

        # Execute gh pr create
        cmd = [
            "gh",
            "pr",
            "create",
            "--base",
            self.main_branch,
            "--head",
            self.develop_branch,
            "--title",
            pr_title,
            "--body",
            body_text,
        ]
        output = self._runner(cmd, self.root)

        # Extract PR URL from output
        pr_url = ""
        pr_num = 0
        for line in output.strip().splitlines():
            if "github.com" in line and "/pull/" in line:
                pr_url = line.strip()
                match = re.search(r"/pull/(\d+)", pr_url)
                if match:
                    pr_num = int(match.group(1))
                break

        # Activate candidate freeze: write .factory/PAUSE
        pause_file = self.root / ".factory/PAUSE"
        pause_file.parent.mkdir(parents=True, exist_ok=True)
        pause_file.write_text(
            f"Candidate freeze active: promotion PR #{pr_num} ({pr_url}) awaiting operator sign-off\n",
            encoding="utf-8",
        )

        return {
            "pr_number": pr_num,
            "pr_url": pr_url or output.strip(),
            "title": pr_title,
            "unpromoted_count": status["unpromoted_count"],
            "candidate_freeze": True,
        }
