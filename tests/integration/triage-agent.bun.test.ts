import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SyntheticForgeAdapter,
  SystemForgeAdapter,
  type ForgeIssue,
} from "../../apps/backend/src/registry/forge";
import {
  acquireIssueLock,
  evaluateTriageEligibility,
  isIssueEligibleForTriage,
  promoteEpicSchema,
  runTriagePass,
  TRIAGE_AGENT_MARKER,
  validateCanonicalIssueBody,
} from "../../scripts/loop/triage";
import type { AgentTransport } from "../../scripts/loop/types";

describe("Triage Agent & Turn-Taking Subsystem", () => {
  const tempDirs: string[] = [];
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FACTORY_LOOP_MODEL;
    delete process.env.FACTORY_LOOP_PROVIDER;
    delete process.env.FACTORY_LOOP_EFFORT;
    delete process.env.FACTORY_LOOP_ROLE;
  });

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    process.env = { ...origEnv };
  });

  function makeGitRepo(): { root: string; acceptedRef: string } {
    const root = mkdtempSync(join(tmpdir(), "triage-agent-repo-"));
    tempDirs.push(root);

    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Triage Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "triage@test.local"], { cwd: root });

    mkdirSync(join(root, ".factory/hooks"), { recursive: true });
    writeFileSync(
      join(root, ".factory/hooks/loop-guard.ts"),
      "export default function registerLoopGuard() {}",
      "utf-8",
    );
    mkdirSync(join(root, ".agents/skills/animus-brainstorm"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/animus-brainstorm/SKILL.md"),
      "# animus-brainstorm\nBrainstorm skill",
      "utf-8",
    );
    mkdirSync(join(root, ".agents/skills/animus-grill"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/animus-grill/SKILL.md"),
      "# animus-grill\nGrill skill",
      "utf-8",
    );
    mkdirSync(join(root, ".agents/skills/animus-architecture"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/animus-architecture/SKILL.md"),
      "# animus-architecture\nArchitecture skill",
      "utf-8",
    );
    mkdirSync(join(root, ".agents/skills/animus-spec"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/animus-spec/SKILL.md"),
      "# animus-spec\nSpec skill",
      "utf-8",
    );
    mkdirSync(join(root, ".agents/skills/animus-tickets"), { recursive: true });
    writeFileSync(
      join(root, ".agents/skills/animus-tickets/SKILL.md"),
      "# animus-tickets\nTickets skill",
      "utf-8",
    );

    writeFileSync(join(root, "README.md"), "# Test Repo\n", "utf-8");

    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "initial baseline"], { cwd: root });
    const acceptedRef = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf-8",
    }).trim();

    return { root, acceptedRef };
  }

  function makeStateRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), "triage-state-"));
    tempDirs.push(dir);
    return dir;
  }

  function mockTransport(outputObject: any, exitCode = 0): AgentTransport {
    return async () => {
      return {
        exitCode,
        stdout: JSON.stringify(outputObject),
        stderr: "",
      };
    };
  }

  const canonicalSingleBody = [
    "## Source and problem",
    "Current intake does not handle edge cases.",
    "",
    "## Outcome",
    "Intake admission handles edge cases deterministically.",
    "",
    "## Invariants",
    "- Fail closed on invalid data.",
    "",
    "## Acceptance criteria",
    "- [ ] AC1: Deterministic validation implemented.",
    "",
    "## Boundary",
    "Only affects intake validation module.",
    "",
    "Depends on: None",
  ].join("\n");

  describe("Deterministic Triage Eligibility & Turn-Taking Detection", () => {
    test("open issue without triage labels is eligible (unlabeled_awaiting_triage)", () => {
      const issue: ForgeIssue = {
        number: 1,
        title: "Vague bug report",
        state: "OPEN",
        body: "Something is broken",
        labels: [],
        comments: [],
      };
      const res = evaluateTriageEligibility(issue);
      expect(res.eligible).toBe(true);
      expect(isIssueEligibleForTriage(issue)).toBe(true);
    });

    test("open issue with needs-triage and no comments is eligible", () => {
      const issue: ForgeIssue = {
        number: 2,
        title: "Feature idea",
        state: "OPEN",
        body: "Please add this feature",
        labels: [{ name: "needs-triage" }],
        comments: [],
      };
      expect(evaluateTriageEligibility(issue).eligible).toBe(true);
    });

    test("open issue with needs-triage where last comment is human is eligible", () => {
      const issue: ForgeIssue = {
        number: 3,
        title: "Feature idea",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [{ id: "c1", author: "alice", body: "Here is extra context" }],
      };
      expect(evaluateTriageEligibility(issue).eligible).toBe(true);
    });

    test("open issue with needs-triage is skipped when latest comment is unanswered agent marker", () => {
      const issue: ForgeIssue = {
        number: 4,
        title: "Vague issue",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [
          {
            id: "c1",
            author: "animus-agent",
            body: `Can you clarify your requirement?\n\n${TRIAGE_AGENT_MARKER}`,
          },
        ],
      };
      const res = evaluateTriageEligibility(issue);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain("unanswered triage prompt");
    });

    test("open issue with needs-info without comments is skipped", () => {
      const issue: ForgeIssue = {
        number: 5,
        title: "Needs more info",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-info" }],
        comments: [],
      };
      const res = evaluateTriageEligibility(issue);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain("no comments");
    });

    test("open issue with needs-info where latest comment is agent marker is skipped", () => {
      const issue: ForgeIssue = {
        number: 6,
        title: "Waiting on user",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-info" }],
        comments: [
          { id: "c1", author: "alice", body: "Original issue details" },
          {
            id: "c2",
            author: "animus-agent",
            body: `Please provide logs.\n\n${TRIAGE_AGENT_MARKER}`,
          },
        ],
      };
      const res = evaluateTriageEligibility(issue);
      expect(res.eligible).toBe(false);
      expect(res.reason).toContain("awaiting a human reply");
    });

    test("open issue with needs-info is eligible when human replies after agent marker", () => {
      const issue: ForgeIssue = {
        number: 7,
        title: "Waiting on user",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-info" }],
        comments: [
          {
            id: "c1",
            author: "animus-agent",
            body: `Please provide logs.\n\n${TRIAGE_AGENT_MARKER}`,
          },
          { id: "c2", author: "alice", body: "Here are the logs from staging" },
        ],
      };
      const res = evaluateTriageEligibility(issue);
      expect(res.eligible).toBe(true);
      expect(res.reason).toContain("human reply");
    });

    test("closed issues are never eligible", () => {
      const issue: ForgeIssue = {
        number: 8,
        title: "Closed item",
        state: "CLOSED",
        body: "Body",
        labels: [],
        comments: [],
      };
      expect(evaluateTriageEligibility(issue).eligible).toBe(false);
    });

    test.each(["wontfix", "ready-for-agent", "ready-for-human", "needs-owner"])(
      "issues labeled with %s are strictly excluded",
      (label) => {
        const issue: ForgeIssue = {
          number: 9,
          title: "Excluded ticket",
          state: "OPEN",
          body: "Body",
          labels: [{ name: label }],
          comments: [{ id: "c1", author: "alice", body: "Human comment" }],
        };
        const res = evaluateTriageEligibility(issue);
        expect(res.eligible).toBe(false);
        expect(res.reason).toContain(`exclusion label '${label}'`);
      },
    );

    test("wontfix overrides other triage labels with absolute precedence", () => {
      const issue: ForgeIssue = {
        number: 10,
        title: "Wontfix item",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }, { name: "wontfix" }],
        comments: [],
      };
      expect(evaluateTriageEligibility(issue).eligible).toBe(false);
    });
  });

  describe("Per-Issue Lock Management & Concurrency", () => {
    test("acquires exclusive lock under <stateRoot>/triage-locks/issue-<number>.lock and releases cleanly", async () => {
      const stateRoot = makeStateRoot();
      const lock1 = await acquireIssueLock(stateRoot, 42);
      expect(lock1).not.toBeNull();

      const lockFile = join(stateRoot, "triage-locks/issue-42.lock");
      expect(existsSync(lockFile)).toBe(true);

      const payload = JSON.parse(readFileSync(lockFile, "utf-8"));
      expect(payload.issueNumber).toBe(42);
      expect(payload.pid).toBe(process.pid);

      // Concurrent acquisition while process is alive must fail
      const lock2 = await acquireIssueLock(stateRoot, 42);
      expect(lock2).toBeNull();

      await lock1!.release();
      expect(existsSync(lockFile)).toBe(false);

      // Can acquire again after release
      const lock3 = await acquireIssueLock(stateRoot, 42);
      expect(lock3).not.toBeNull();
      await lock3!.release();
    });

    test("recovers stale lock when holding PID is dead", async () => {
      const stateRoot = makeStateRoot();
      const locksDir = join(stateRoot, "triage-locks");
      mkdirSync(locksDir, { recursive: true });
      const lockFile = join(locksDir, "issue-99.lock");

      // Write dead PID (PID 99999999 is typically non-existent)
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: 99999999, createdAt: Date.now() - 5000, issueNumber: 99 }),
      );

      const lock = await acquireIssueLock(stateRoot, 99);
      expect(lock).not.toBeNull();

      const newContent = JSON.parse(readFileSync(lockFile, "utf-8"));
      expect(newContent.pid).toBe(process.pid);
      await lock!.release();
    });

    test("live-expired lock is never stolen by another acquire attempt (age never proves dead)", async () => {
      const stateRoot = makeStateRoot();
      const locksDir = join(stateRoot, "triage-locks");
      mkdirSync(locksDir, { recursive: true });
      const lockFile = join(locksDir, "issue-100.lock");

      // Write lock with current live PID, but timestamp far in the past (expired age)
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now() - 100000000,
          issueNumber: 100,
          ownerToken: "live-token-1",
        }),
      );

      // Attempt to acquire with small timeoutMs; must NOT steal since PID is still alive!
      const lock = await acquireIssueLock(stateRoot, 100, 1000);
      expect(lock).toBeNull();

      // Original lock file must remain untouched
      expect(existsSync(lockFile)).toBe(true);
      const content = JSON.parse(readFileSync(lockFile, "utf-8"));
      expect(content.ownerToken).toBe("live-token-1");
    });

    test("stale concurrent attempts serialize atomically and exactly one wins", async () => {
      const stateRoot = makeStateRoot();
      const locksDir = join(stateRoot, "triage-locks");
      mkdirSync(locksDir, { recursive: true });
      const lockFile = join(locksDir, "issue-101.lock");

      // Dead PID
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: 99999999,
          createdAt: Date.now() - 5000,
          issueNumber: 101,
          ownerToken: "dead-token",
        }),
      );

      const [res1, res2] = await Promise.all([
        acquireIssueLock(stateRoot, 101),
        acquireIssueLock(stateRoot, 101),
      ]);

      const wins = [res1, res2].filter((l) => l !== null);
      expect(wins).toHaveLength(1);

      await wins[0]!.release();
      expect(existsSync(lockFile)).toBe(false);
    });

    test("release cannot delete a replacement lock (ABA prevention)", async () => {
      const stateRoot = makeStateRoot();
      const locksDir = join(stateRoot, "triage-locks");
      mkdirSync(locksDir, { recursive: true });
      const lockFile = join(locksDir, "issue-102.lock");

      const lockA = await acquireIssueLock(stateRoot, 102);
      expect(lockA).not.toBeNull();

      // Simulate external replacement: overwrite lockFile with new ownerToken
      writeFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          issueNumber: 102,
          ownerToken: "replacement-token",
        }),
      );

      // lockA releases; must NOT delete the replacement lock!
      await lockA!.release();
      expect(existsSync(lockFile)).toBe(true);
      const afterContent = JSON.parse(readFileSync(lockFile, "utf-8"));
      expect(afterContent.ownerToken).toBe("replacement-token");
    });

    test("invalid or partial lock fails closed and is never stolen or deleted", async () => {
      const stateRoot = makeStateRoot();
      const locksDir = join(stateRoot, "triage-locks");
      mkdirSync(locksDir, { recursive: true });
      const lockFile = join(locksDir, "issue-103.lock");

      // Corrupt / partial JSON
      writeFileSync(lockFile, '{"pid": 1234, "createdAt":');

      const lock = await acquireIssueLock(stateRoot, 103);
      expect(lock).toBeNull();
      // Corrupt file must still be present (fail closed)
      expect(existsSync(lockFile)).toBe(true);
    });

    test("triage execution never touches <stateRoot>/runs/ or creates builder lap state", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 101,
        title: "Test issue",
        state: "OPEN",
        body: "Please clarify",
        labels: [{ name: "needs-triage" }],
      });

      const transport = mockTransport({
        action: "ask_clarification",
        question: "Can you clarify requirements?",
        reason: "Inspected codebase, requirements unclear.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
      });

      expect(result.processed).toHaveLength(1);
      expect(existsSync(join(stateRoot, "runs"))).toBe(false);
      expect(existsSync(join(root, ".factory/runs"))).toBe(false);
    });
  });

  describe("Workspace Snapshot & Read-Only Tool Enforcement", () => {
    test("fails closed when working tree is mutated during triage execution", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 102,
        title: "Test issue",
        state: "OPEN",
        body: "Vague report",
        labels: [{ name: "needs-triage" }],
      });

      // Hostile mock transport that modifies working tree
      const dirtyTransport: AgentTransport = async () => {
        writeFileSync(join(root, "dirty-file.txt"), "hostile write!");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport: dirtyTransport,
        acceptedRef,
      });

      expect(result.failureCount).toBe(1);
      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("TRIAGE SAFETY VIOLATION");

      // Verify forge was NOT mutated
      const issue = await forge.getIssue("owner/repo", 102);
      expect(issue?.comments).toHaveLength(0);
      expect(issue?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "needs-triage",
      ]);
    });

    test("fails closed when an already dirty tracked file is modified during triage", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 104,
        title: "Test dirty tracked modification",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      // Dirty README.md before triage
      writeFileSync(join(root, "README.md"), "# Modified Before Triage\n", "utf-8");

      // Transport further modifies the already dirty file
      const dirtyTransport: AgentTransport = async () => {
        writeFileSync(join(root, "README.md"), "# Modified During Triage!\n", "utf-8");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport: dirtyTransport,
        acceptedRef,
        env: { FACTORY_LOOP_PROVIDER: "claude" },
      });

      expect(result.failureCount).toBe(1);
      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("TRIAGE SAFETY VIOLATION");
    });

    test("fails closed when an existing untracked file is modified during triage", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 105,
        title: "Test untracked modification",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      // Create untracked file before triage
      writeFileSync(join(root, "untracked.txt"), "Initial untracked content\n", "utf-8");

      // Transport modifies untracked file
      const dirtyTransport: AgentTransport = async () => {
        writeFileSync(join(root, "untracked.txt"), "Modified untracked content!\n", "utf-8");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport: dirtyTransport,
        acceptedRef,
        env: { FACTORY_LOOP_PROVIDER: "claude" },
      });

      expect(result.failureCount).toBe(1);
      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("TRIAGE SAFETY VIOLATION");
    });

    test("rejects stateRoot inside checkout root via canonical containment check", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRootInside = join(root, ".scratch/state");
      mkdirSync(stateRootInside, { recursive: true });

      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 106,
        title: "Test containment",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      expect(
        runTriagePass({
          root,
          repo: "owner/repo",
          stateRoot: stateRootInside,
          forge,
          transport: mockTransport({ action: "ask_clarification", question: "?", reason: "r" }),
          acceptedRef,
        }),
      ).rejects.toThrow("must be outside checkout root");
    });

    test("rejects invalid repo identity, issueNumber, and limit inputs", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();

      // Invalid repo
      expect(
        runTriagePass({
          root,
          repo: "invalid-repo-without-slash",
          stateRoot,
          forge,
          acceptedRef,
        }),
      ).rejects.toThrow("Invalid repository identity");

      // Invalid negative issueNumber
      expect(
        runTriagePass({
          root,
          repo: "owner/repo",
          stateRoot,
          forge,
          issueNumber: -5,
          acceptedRef,
        }),
      ).rejects.toThrow("Invalid issueNumber");

      // Invalid 0 limit
      expect(
        runTriagePass({
          root,
          repo: "owner/repo",
          stateRoot,
          forge,
          limit: 0,
          acceptedRef,
        }),
      ).rejects.toThrow("Invalid limit");
    });

    test("holds when safety guard extension hook is missing for pi provider", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 103,
        title: "Test issue",
        state: "OPEN",
        body: "Vague report",
        labels: [{ name: "needs-triage" }],
      });

      // Delete loop-guard.ts while keeping the 5 accepted planning skills intact
      rmSync(join(root, ".factory/hooks/loop-guard.ts"), { force: true });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport: mockTransport({ action: "ask_clarification", question: "?", reason: "r" }),
        acceptedRef,
      });

      expect(result.processed[0]?.status).toBe("held");
      expect(result.processed[0]?.reason).toContain("Safety guard extension hook");
    });
  });

  describe("Canonical Issue Validation", () => {
    test("validates complete canonical issue body with all 5 sections and Depends on line", () => {
      const valid = validateCanonicalIssueBody(canonicalSingleBody);
      expect(valid.valid).toBe(true);
      expect(valid.errors).toEqual([]);
    });

    test("rejects body missing canonical sections", () => {
      const incomplete = [
        "## Source and problem",
        "Problem",
        "## Outcome",
        "Outcome",
        "Depends on: None",
      ].join("\n");

      const check = validateCanonicalIssueBody(incomplete);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes("## Invariants"))).toBe(true);
      expect(check.errors.some((e) => e.includes("## Acceptance criteria"))).toBe(true);
      expect(check.errors.some((e) => e.includes("## Boundary"))).toBe(true);
    });

    test("rejects body missing or malformed Depends on line", () => {
      const noDependsOn = [
        "## Source and problem",
        "Problem",
        "## Outcome",
        "Outcome",
        "## Invariants",
        "Invariants",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Boundary",
      ].join("\n");

      const check = validateCanonicalIssueBody(noDependsOn);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes("Depends on"))).toBe(true);
    });

    test("rejects heading inside code fence as satisfying canonical section", () => {
      const codeFenceBody = [
        "```markdown",
        "## Source and problem",
        "## Outcome",
        "## Invariants",
        "## Acceptance criteria",
        "## Boundary",
        "```",
        "",
        "Depends on: None",
      ].join("\n");

      const check = validateCanonicalIssueBody(codeFenceBody);
      expect(check.valid).toBe(false);
      expect(check.errors.length).toBeGreaterThanOrEqual(5);
    });

    test("rejects heading with fake suffix like '## Source and problem details'", () => {
      const suffixBody = [
        "## Source and problem details",
        "Problem text",
        "## Outcome",
        "Outcome text",
        "## Invariants",
        "Invariants text",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Boundary text",
        "",
        "Depends on: None",
      ].join("\n");

      const check = validateCanonicalIssueBody(suffixBody);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes("## Source and problem"))).toBe(true);
    });

    test("rejects canonical section with empty content", () => {
      const emptySectionBody = [
        "## Source and problem",
        "## Outcome",
        "Outcome text",
        "## Invariants",
        "Invariants text",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Boundary text",
        "",
        "Depends on: None",
      ].join("\n");

      const check = validateCanonicalIssueBody(emptySectionBody);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes("empty content"))).toBe(true);
    });

    test("rejects multiple Depends on lines", () => {
      const multipleDependsOn = [
        "## Source and problem",
        "Problem",
        "## Outcome",
        "Outcome",
        "## Invariants",
        "Invariants",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Boundary",
        "",
        "Depends on: #10",
        "Depends on: #20",
      ].join("\n");

      const check = validateCanonicalIssueBody(multipleDependsOn);
      expect(check.valid).toBe(false);
      expect(check.errors.some((e) => e.includes("Multiple 'Depends on:' lines"))).toBe(true);
    });
  });

  describe("Epic Schema & Dependency Index Validation", () => {
    test("rejects out-of-range dependency index", () => {
      const parsed = promoteEpicSchema.safeParse({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          { title: "C1", body: canonicalSingleBody, dependsOnIndices: [3] }, // index 3 out of range (only 1 child)
        ],
        reason: "Decompose",
      });
      expect(parsed.success).toBe(false);
    });

    test("rejects self-dependency index", () => {
      const parsed = promoteEpicSchema.safeParse({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          { title: "C1", body: canonicalSingleBody, dependsOnIndices: [0] }, // depends on self
        ],
        reason: "Decompose",
      });
      expect(parsed.success).toBe(false);
    });

    test("rejects forward dependency index (dependencies must precede child in topological order)", () => {
      const parsed = promoteEpicSchema.safeParse({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          { title: "C1", body: canonicalSingleBody, dependsOnIndices: [1] }, // forward dependency to C2
          { title: "C2", body: canonicalSingleBody, dependsOnIndices: [] },
        ],
        reason: "Decompose",
      });
      expect(parsed.success).toBe(false);
    });

    test("rejects dependency cycles", () => {
      const parsed = promoteEpicSchema.safeParse({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          { title: "C1", body: canonicalSingleBody, dependsOnIndices: [1] },
          { title: "C2", body: canonicalSingleBody, dependsOnIndices: [0] },
        ],
        reason: "Decompose",
      });
      expect(parsed.success).toBe(false);
    });

    test("accepts valid topological dependency order", () => {
      const parsed = promoteEpicSchema.safeParse({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          { title: "C1", body: canonicalSingleBody, dependsOnIndices: [] },
          { title: "C2", body: canonicalSingleBody, dependsOnIndices: [0] },
        ],
        reason: "Decompose",
      });
      expect(parsed.success).toBe(true);
    });
  });

  describe("Triage Actions Execution (SyntheticForgeAdapter)", () => {
    test("Action: ask_clarification posts comment with marker and transitions to needs-info", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 201,
        title: "Vague bug",
        state: "OPEN",
        body: "Something fails in auth",
        labels: [{ name: "needs-triage" }, { name: "bug" }],
        comments: [],
      });

      const transport = mockTransport({
        action: "ask_clarification",
        question: "Does this happen on OAuth redirect or password login?",
        reason: "Inspected apps/backend/src/auth, found two distinct paths.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 201,
      });

      expect(result.processed[0]?.status).toBe("clarification_requested");
      expect(result.processed[0]?.action).toBe("ask_clarification");

      const updated = await forge.getIssue("owner/repo", 201);
      expect(updated?.comments).toHaveLength(1);
      expect(updated?.comments![0]?.body).toContain("Does this happen on OAuth redirect");
      expect(updated?.comments![0]?.body).toContain(TRIAGE_AGENT_MARKER);

      const labelNames = (updated?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
      expect(labelNames).toContain("needs-info");
      expect(labelNames).toContain("bug"); // preserved other label
      expect(labelNames).not.toContain("needs-triage"); // removed needs-triage

      // Subsequent pass skips because last comment is agent marker
      const secondPass = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 201,
      });
      expect(secondPass.processed[0]?.status).toBe("skipped");
    });

    test("Action: promote_single_ticket rewrites title/body and promotes to ready-for-agent", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 202,
        title: "rough idea",
        state: "OPEN",
        body: "rough description",
        labels: [{ name: "needs-triage" }, { name: "enhancement" }],
        comments: [],
      });

      const transport = mockTransport({
        action: "promote_single_ticket",
        title: "Canonical: Implement Deterministic Admission",
        body: canonicalSingleBody,
        reason: "Scope is clear and single-slice.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 202,
      });

      expect(result.processed[0]?.status).toBe("promoted_single");
      const updated = await forge.getIssue("owner/repo", 202);
      expect(updated?.title).toBe("Canonical: Implement Deterministic Admission");
      expect(updated?.body).toBe(canonicalSingleBody);

      const labelNames = (updated?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
      expect(labelNames).toContain("ready-for-agent");
      expect(labelNames).toContain("enhancement"); // preserved
      expect(labelNames).not.toContain("needs-triage");
    });

    test("Action: promote_epic_spec_and_tickets validates human agreement and decomposes initiative", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 300,
        title: "Multi-tier caching system",
        state: "OPEN",
        body: "We need Redis caching and memory caching.",
        labels: [{ name: "needs-triage" }],
        comments: [
          {
            id: "agree-1",
            author: "maintainer",
            body: "Agreed, let's break this down into separate spec and tickets.",
          },
        ],
      });

      const child1Body = [
        "## Source and problem",
        "Memory cache layer is missing.",
        "## Outcome",
        "In-memory LRU cache implemented.",
        "## Invariants",
        "- Thread safe.",
        "## Acceptance criteria",
        "- [ ] AC1: LRU cache works.",
        "## Boundary",
        "packages/cache only.",
        "",
        "Depends on: None",
      ].join("\n");

      const child2Body = [
        "## Source and problem",
        "Redis backing store required.",
        "## Outcome",
        "Redis cluster client integrated.",
        "## Invariants",
        "- Fail closed on connection drop.",
        "## Acceptance criteria",
        "- [ ] AC1: Redis client wired.",
        "## Boundary",
        "packages/redis only.",
        "",
        "Depends on: None",
      ].join("\n");

      const transport = mockTransport({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-1",
        parentTitle: "Spec: Multi-Tier Caching System",
        parentBody: canonicalSingleBody,
        childTickets: [
          {
            title: "Implement In-Memory LRU Cache",
            body: child1Body,
            dependsOnIndices: [],
          },
          {
            title: "Implement Redis Backing Store",
            body: child2Body,
            dependsOnIndices: [0], // depends on child 1
          },
        ],
        reason: "Agreed architecture decomposed into 2 sequential slices.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 300,
      });

      expect(result.processed[0]?.status).toBe("promoted_epic");
      expect(result.processed[0]?.createdChildIssues).toHaveLength(2);
      const childIssues = result.processed[0]?.createdChildIssues ?? [];
      const [child1Num, child2Num] = childIssues;

      // Check parent issue
      const parent = await forge.getIssue("owner/repo", 300);
      expect(parent?.title).toBe("Spec: Multi-Tier Caching System");
      const parentLabels = (parent?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
      expect(parentLabels).toContain("spec");
      expect(parentLabels).toContain("ready-for-human");
      expect(parentLabels).not.toContain("needs-triage");

      // Check summary comment on parent
      const summaryComment = parent?.comments?.find((c) => c.body?.includes(TRIAGE_AGENT_MARKER));
      expect(summaryComment).toBeDefined();
      expect(summaryComment?.body).toContain(`#${child1Num}`);
      expect(summaryComment?.body).toContain(`#${child2Num}`);

      // Check child 1
      const child1 = await forge.getIssue("owner/repo", child1Num);
      expect(child1?.title).toBe("Implement In-Memory LRU Cache");
      expect(child1?.body).toContain("Part of #300");
      expect(child1?.body).toContain("Depends on: None");
      expect(child1?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "ready-for-agent",
      ]);

      // Check child 2
      const child2 = await forge.getIssue("owner/repo", child2Num);
      expect(child2?.title).toBe("Implement Redis Backing Store");
      expect(child2?.body).toContain("Part of #300");
      expect(child2?.body).toContain(`Depends on: #${child1Num}`);
      expect(child2?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "ready-for-agent",
      ]);

      // Verify synthetic forge tracked sub-issues and dependencies
      expect(await forge.getSubIssues("owner/repo", 300)).toEqual([child1Num, child2Num]);
      expect(await forge.getIssueDependencies("owner/repo", child2Num)).toEqual([child1Num]);
    });

    test("Action: promote_epic fails closed when human agreement comment is missing or agent-authored", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 301,
        title: "Multi-tier caching",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [
          {
            id: "user-1",
            author: "alice",
            body: "I am not sure we should do this yet.",
          },
          {
            id: "agent-1",
            author: "animus-agent",
            body: `Agent says we should do epic.\n\n${TRIAGE_AGENT_MARKER}`,
          },
          {
            id: "user-2",
            author: "alice",
            body: "Still discussing with the team.",
          },
        ],
      });

      const transport = mockTransport({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agent-1", // references agent comment!
        parentTitle: "Spec: Cache",
        parentBody: "Body",
        childTickets: [
          {
            title: "Slice 1",
            body: canonicalSingleBody,
            dependsOnIndices: [],
          },
        ],
        reason: "Decompose",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 301,
      });

      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("valid human agreement comment");
    });

    test("Action: hold_for_human transitions to ready-for-human and posts optional advisory comment", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 203,
        title: "Architectural change",
        state: "OPEN",
        body: "Replace Postgres with DynamoDB",
        labels: [{ name: "needs-triage" }],
        comments: [],
      });

      const transport = mockTransport({
        action: "hold_for_human",
        reason: "Core database migration requires human architectural authority.",
        comment: "Held for maintainer architectural review.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 203,
      });

      expect(result.processed[0]?.status).toBe("held");
      const updated = await forge.getIssue("owner/repo", 203);
      const labelNames = (updated?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
      expect(labelNames).toContain("ready-for-human");
      expect(labelNames).not.toContain("needs-triage");
      expect(updated?.comments![0]?.body).toContain("Held for maintainer");
      expect(updated?.comments![0]?.body).toContain(TRIAGE_AGENT_MARKER);
    });
  });

  describe("SystemForgeAdapter Boundary & Command Formulation", () => {
    test("wires exact gh commands for SystemForgeAdapter comment, linking, and edit operations", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();

      const executedCommands: string[][] = [];
      const runner = async (cmd: string[]) => {
        executedCommands.push(cmd);
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "comment") {
          return JSON.stringify({ id: "comment-123", author: { login: "animus-agent" } });
        }
        if (cmd[0] === "gh" && cmd[1] === "issue" && cmd[2] === "edit") {
          return "";
        }
        if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "graphql") {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  number: 400,
                  title: "Vague issue",
                  state: "OPEN",
                  body: "Need help",
                  labels: {
                    nodes: [{ name: "needs-triage" }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                  comments: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          });
        }
        return "";
      };

      const systemForge = new SystemForgeAdapter(runner);
      const transport = mockTransport({
        action: "ask_clarification",
        question: "Could you specify target version?",
        reason: "Version not specified in body.",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge: systemForge,
        transport,
        acceptedRef,
        issueNumber: 400,
      });

      expect(result.processed[0]?.status).toBe("clarification_requested");

      // Verify gh issue comment was invoked
      const commentCall = executedCommands.find(
        (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "comment",
      );
      expect(commentCall).toBeDefined();
      expect(commentCall).toContain("400");
      expect(commentCall).toContain("--body");
      const bodyArg = commentCall![commentCall!.indexOf("--body") + 1]!;
      expect(bodyArg).toContain("Could you specify target version?");
      expect(bodyArg).toContain(TRIAGE_AGENT_MARKER);

      // Verify gh issue edit was invoked
      const editCall = executedCommands.find(
        (c) => c[0] === "gh" && c[1] === "issue" && c[2] === "edit",
      );
      expect(editCall).toBeDefined();
      expect(editCall).toContain("400");
      expect(editCall).toContain("--add-label");
      expect(editCall).toContain("needs-info");
    });
  });

  describe("Provider Safety Enforcement & Planning Skills Argv", () => {
    test("wires -e loop-guard.ts, FACTORY_LOOP_ROLE=triage, and all 5 planning skills for pi provider", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 701,
        title: "Test pi provider",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let capturedRequest: any;
      const transport: AgentTransport = async (req) => {
        capturedRequest = req;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 701,
        env: { FACTORY_LOOP_PROVIDER: "pi" },
      });

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.role).toBe("triage");
      expect(capturedRequest.env.FACTORY_LOOP_ROLE).toBe("triage");

      const argv = capturedRequest.argv as string[];
      expect(argv[0]).toBe("pi");
      expect(argv).toContain("-e");
      const extIdx = argv.indexOf("-e");
      expect(argv[extIdx + 1]).toContain("loop-guard.ts");
      expect(argv).toContain("--tools");
      const toolsIdx = argv.indexOf("--tools");
      expect(argv[toolsIdx + 1]).toBe("read,grep,find");
      expect(argv).toContain("--no-mcp");

      // Verify all 5 planning skills
      const skillIndices = argv
        .map((arg, idx) => (arg === "--skill" ? idx : -1))
        .filter((idx) => idx !== -1);
      const passedSkills = skillIndices.map((idx) => argv[idx + 1]!);

      expect(passedSkills.some((s) => s.includes("animus-brainstorm"))).toBe(true);
      expect(passedSkills.some((s) => s.includes("animus-grill"))).toBe(true);
      expect(passedSkills.some((s) => s.includes("animus-architecture"))).toBe(true);
      expect(passedSkills.some((s) => s.includes("animus-spec"))).toBe(true);
      expect(passedSkills.some((s) => s.includes("animus-tickets"))).toBe(true);
    });

    test("wires -e loop-guard.ts and FACTORY_LOOP_ROLE=triage for omp provider", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 702,
        title: "Test omp provider",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let capturedRequest: any;
      const transport: AgentTransport = async (req) => {
        capturedRequest = req;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 702,
        env: { FACTORY_LOOP_PROVIDER: "omp" },
      });

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.env.FACTORY_LOOP_ROLE).toBe("triage");
      const argv = capturedRequest.argv as string[];
      expect(argv[0]).toBe("omp");
      expect(argv).toContain("-e");
      const extIdx = argv.indexOf("-e");
      expect(argv[extIdx + 1]).toContain("loop-guard.ts");
      expect(argv).toContain("--tools");
      const toolsIdx = argv.indexOf("--tools");
      expect(argv[toolsIdx + 1]).toBe("read,grep,find");
    });

    test("holds when any of the 5 planning skills is missing before spawn for all providers", async () => {
      const { root } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 705,
        title: "Test missing skill",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      // Remove one of the planning skills
      rmSync(join(root, ".agents/skills/animus-tickets"), { recursive: true, force: true });
      execFileSync("git", ["add", "-A"], { cwd: root });
      execFileSync("git", ["commit", "-m", "remove animus-tickets"], { cwd: root });
      const newRef = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf-8",
      }).trim();

      let transportLaunched = false;
      const transport: AgentTransport = async () => {
        transportLaunched = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef: newRef,
        issueNumber: 705,
        env: { FACTORY_LOOP_PROVIDER: "claude" },
      });

      expect(transportLaunched).toBe(false);
      expect(result.processed[0]?.status).toBe("held");
      expect(result.processed[0]?.reason).toContain("5 accepted planning skills");
    });

    test("options.env FACTORY_LOOP_ROLE cannot override enforced triage role", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 706,
        title: "Test hostile role override",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let capturedRequest: any;
      const transport: AgentTransport = async (req) => {
        capturedRequest = req;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 706,
        env: { FACTORY_LOOP_ROLE: "builder" }, // hostile override attempt!
      });

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.role).toBe("triage");
      expect(capturedRequest.env.FACTORY_LOOP_ROLE).toBe("triage");
    });

    test("ambient or options PI_OFFLINE holds triage execution without transport invocation", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 707,
        title: "Test offline mode",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let transportLaunched = false;
      const transport: AgentTransport = async () => {
        transportLaunched = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 707,
        env: { PI_OFFLINE: "1" },
      });

      expect(transportLaunched).toBe(false);
      expect(result.processed[0]?.status).toBe("held");
      expect(result.processed[0]?.reason).toContain("PI_OFFLINE is active");
    });

    test("wires native tool restrictions for claude provider without launching unguarded", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 703,
        title: "Test claude provider",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let capturedRequest: any;
      const transport: AgentTransport = async (req) => {
        capturedRequest = req;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "ask_clarification",
            question: "Question?",
            reason: "Reason",
          }),
          stderr: "",
        };
      };

      await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 703,
        env: { FACTORY_LOOP_PROVIDER: "claude" },
      });

      expect(capturedRequest).toBeDefined();
      const argv = capturedRequest.argv as string[];
      expect(argv[0]).toBe("claude");
      expect(argv).toContain("--tools");
      const toolsIdx = argv.indexOf("--tools");
      expect(argv[toolsIdx + 1]).toBe("Read,Glob,Grep");
      expect(argv).toContain("--allowed-tools");
      const allowedIdx = argv.indexOf("--allowed-tools");
      expect(argv[allowedIdx + 1]).toBe("Read,Glob,Grep");
      expect(argv).toContain("--disallowed-tools");
      const disallowedIdx = argv.indexOf("--disallowed-tools");
      expect(argv[disallowedIdx + 1]).toBe("Write,Edit");
      expect(argv).toContain("--strict-mcp-config");
      expect(argv).toContain("--setting-sources");
      const settingSourcesIdx = argv.indexOf("--setting-sources");
      expect(argv[settingSourcesIdx + 1]).toBe("");
    });

    test("unsupported safety provider holds and does not launch unguarded", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 704,
        title: "Test codex provider",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      let transportLaunched = false;
      const transport: AgentTransport = async () => {
        transportLaunched = true;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 704,
        env: { FACTORY_LOOP_PROVIDER: "codex" },
      });

      expect(transportLaunched).toBe(false);
      expect(result.processed[0]?.status).toBe("held");
      expect(result.processed[0]?.reason).toContain("Unsupported safety configuration");
    });
  });

  describe("Epic Partial Failure & Progress Recovery", () => {
    test("partial epic failure leaves child tickets in held state and retry avoids duplicate creation", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 800,
        title: "Epic with transient failure",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [
          {
            id: "agree-epic",
            author: "maintainer",
            body: "Agreed to decompose this into two tickets.",
          },
        ],
      });

      const child1Body = [
        "## Source and problem",
        "Prob 1",
        "## Outcome",
        "Out 1",
        "## Invariants",
        "- Inv 1",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Bound 1",
        "",
        "Depends on: None",
      ].join("\n");

      const child2Body = [
        "## Source and problem",
        "Prob 2",
        "## Outcome",
        "Out 2",
        "## Invariants",
        "- Inv 2",
        "## Acceptance criteria",
        "- [ ] AC1",
        "## Boundary",
        "Bound 2",
        "",
        "Depends on: None",
      ].join("\n");

      const transport = mockTransport({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-epic",
        parentTitle: "Spec: Epic Recovered",
        parentBody: canonicalSingleBody,
        childTickets: [
          { title: "Child 1", body: child1Body, dependsOnIndices: [] },
          { title: "Child 2", body: child2Body, dependsOnIndices: [0] },
        ],
        reason: "Decomposition into 2 slices",
      });

      // Inject transient failure on second issue creation
      const origCreateIssue = forge.createIssue.bind(forge);
      let createCallCount = 0;
      forge.createIssue = async (repo, input) => {
        createCallCount++;
        if (createCallCount === 2) {
          throw new Error("Simulated transient network drop during child 2 creation");
        }
        return origCreateIssue(repo, input);
      };

      const failResult = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 800,
      });

      expect(failResult.processed[0]?.status).toBe("failed");
      expect(failResult.processed[0]?.error).toContain("Simulated transient network drop");

      // Verify child 1 was created on forge, but is in HELD state (needs-owner), NOT ready-for-agent
      const issuesAfterFail = await forge.listIssues("owner/repo", "ALL");
      const createdChild1 = issuesAfterFail.find((i) => i.title === "Child 1");
      expect(createdChild1).toBeDefined();
      const child1Labels = createdChild1!.labels?.map((l) => (typeof l === "string" ? l : l.name));
      expect(child1Labels).toEqual(["needs-owner"]);
      expect(child1Labels).not.toContain("ready-for-agent");

      // Verify parent issue 800 was NOT modified to spec/ready-for-human yet
      const parentAfterFail = await forge.getIssue("owner/repo", 800);
      expect(parentAfterFail?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "needs-triage",
      ]);

      // Verify staging file exists outside repo
      const stagingFile = join(stateRoot, "triage-staging/epic-800.json");
      expect(existsSync(stagingFile)).toBe(true);

      // Now restore forge createIssue and retry triage pass
      forge.createIssue = origCreateIssue;
      const retryResult = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 800,
      });

      expect(retryResult.processed[0]?.status).toBe("promoted_epic");
      const finalIssues = retryResult.processed[0]?.createdChildIssues ?? [];
      const [finalChild1Num, finalChild2Num] = finalIssues;

      // Verify child 1 was REUSED (same issue number), NOT duplicated!
      expect(finalChild1Num).toBe(createdChild1!.number);

      const allIssuesAfterRetry = await forge.listIssues("owner/repo", "ALL");
      const child1Issues = allIssuesAfterRetry.filter((i) => i.title === "Child 1");
      expect(child1Issues).toHaveLength(1); // exactly 1, no duplicate

      // Both children are now promoted to ready-for-agent
      const finalChild1 = await forge.getIssue("owner/repo", finalChild1Num);
      const finalChild2 = await forge.getIssue("owner/repo", finalChild2Num);
      expect(finalChild1?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "ready-for-agent",
      ]);
      expect(finalChild2?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "ready-for-agent",
      ]);

      // Parent is promoted to spec + ready-for-human
      const finalParent = await forge.getIssue("owner/repo", 800);
      const finalParentLabels = finalParent?.labels?.map((l) =>
        typeof l === "string" ? l : l.name,
      );
      expect(finalParentLabels).toContain("spec");
      expect(finalParentLabels).toContain("ready-for-human");

      // Staging file cleaned up
      expect(existsSync(stagingFile)).toBe(false);
    });

    test("plan mismatch on retry holds and creates no duplicate tickets", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 801,
        title: "Epic with plan mismatch",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [
          {
            id: "agree-plan",
            author: "maintainer",
            body: "Agreed",
          },
        ],
      });

      // Write a pre-existing staging file with a different plan hash
      const stagingDir = join(stateRoot, "triage-staging");
      mkdirSync(stagingDir, { recursive: true });
      const stagingFile = join(stagingDir, "epic-801.json");
      writeFileSync(
        stagingFile,
        JSON.stringify({
          repo: "owner/repo",
          parentNumber: 801,
          planHash: "completely-different-plan-hash",
          childNumbers: [9001],
        }),
      );

      const transport = mockTransport({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-plan",
        parentTitle: "Spec: Plan Changed",
        parentBody: canonicalSingleBody,
        childTickets: [{ title: "New Child", body: canonicalSingleBody, dependsOnIndices: [] }],
        reason: "Decomposition",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 801,
      });

      expect(result.processed[0]?.status).toBe("held");
      expect(result.processed[0]?.reason).toContain("plan mismatch");

      // No new issues created
      const allIssues = await forge.listIssues("owner/repo", "ALL");
      expect(allIssues.filter((i) => i.title === "New Child")).toHaveLength(0);
    });

    test("linking error fails closed and leaves all child tickets in held state without promoting any to ready-for-agent", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 802,
        title: "Epic linking failure",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
        comments: [{ id: "agree-link", author: "maintainer", body: "Agreed" }],
      });

      // Inject error on addSubIssue
      forge.addSubIssue = async () => {
        throw new Error("GitHub GraphQL API failed to add sub-issue");
      };

      const transport = mockTransport({
        action: "promote_epic_spec_and_tickets",
        agreementCommentId: "agree-link",
        parentTitle: "Spec: Linking Error",
        parentBody: canonicalSingleBody,
        childTickets: [
          { title: "Child 1", body: canonicalSingleBody, dependsOnIndices: [] },
          { title: "Child 2", body: canonicalSingleBody, dependsOnIndices: [0] },
        ],
        reason: "Decomposition",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 802,
      });

      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("failed to add sub-issue");

      // Verify all created child tickets remain in needs-owner state and NONE are ready-for-agent
      const allIssues = await forge.listIssues("owner/repo", "ALL");
      const children = allIssues.filter((i) => i.title.startsWith("Child "));
      expect(children).toHaveLength(2);
      for (const child of children) {
        const labels = child.labels?.map((l) => (typeof l === "string" ? l : l.name));
        expect(labels).toContain("needs-owner");
        expect(labels).not.toContain("ready-for-agent");
      }
    });

    test("staging resume completes summary comment when parent was already promoted", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 803,
        title: "Spec: Already Promoted",
        state: "OPEN",
        body: canonicalSingleBody,
        labels: [{ name: "spec" }, { name: "ready-for-human" }],
        comments: [{ id: "agree-resume", author: "maintainer", body: "Agreed" }],
      });

      // Child already created and promoted
      const child = await forge.createIssue("owner/repo", {
        title: "Child Already Promoted",
        body: canonicalSingleBody,
        labels: ["ready-for-agent"],
      });

      const stagingDir = join(stateRoot, "triage-staging");
      mkdirSync(stagingDir, { recursive: true });
      const stagingFile = join(stagingDir, "epic-803.json");

      const action = {
        action: "promote_epic_spec_and_tickets" as const,
        agreementCommentId: "agree-resume",
        parentTitle: "Spec: Already Promoted",
        parentBody: canonicalSingleBody,
        childTickets: [
          { title: "Child Already Promoted", body: canonicalSingleBody, dependsOnIndices: [] },
        ],
        reason: "Resume",
      };

      // Compute plan hash matching the action
      const planHash = require("crypto")
        .createHash("sha256")
        .update(
          JSON.stringify({
            parentTitle: action.parentTitle.trim(),
            parentBody: action.parentBody.trim(),
            childTickets: action.childTickets.map((c: any) => ({
              title: c.title.trim(),
              body: c.body.trim(),
              dependsOnIndices: [...c.dependsOnIndices].sort((a: number, b: number) => a - b),
              labels: (c.labels ?? []).slice().sort((a: string, b: string) => a.localeCompare(b)),
            })),
          }),
        )
        .digest("hex");

      writeFileSync(
        stagingFile,
        JSON.stringify({
          repo: "owner/repo",
          parentNumber: 803,
          planHash,
          childNumbers: [child.number],
        }),
      );

      const transport = mockTransport(action);

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 803,
      });

      expect(result.processed[0]?.status).toBe("promoted_epic");
      const parent = await forge.getIssue("owner/repo", 803);
      expect(parent?.comments?.some((c) => c.body?.includes(TRIAGE_AGENT_MARKER))).toBe(true);
      expect(existsSync(stagingFile)).toBe(false);
    });
  });

  describe("Stale Recheck & Concurrent Action Abort", () => {
    test("aborts mutation when issue comments change during agent transport run", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 901,
        title: "Issue with concurrent comment",
        state: "OPEN",
        body: "Original body",
        labels: [{ name: "needs-triage" }],
        comments: [],
      });

      // Transport adds a comment to the forge while agent is running
      const transport: AgentTransport = async () => {
        await forge.createIssueComment("owner/repo", 901, "Human commented mid-turn!");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "promote_single_ticket",
            title: "Stale Canonical Title",
            body: canonicalSingleBody,
            reason: "Computed from initial state",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 901,
      });

      expect(result.processed[0]?.status).toBe("skipped");
      expect(result.processed[0]?.reason).toContain(
        "was modified while triage agent was executing",
      );

      // Verify forge issue was NOT overwritten with stale promotion
      const issue = await forge.getIssue("owner/repo", 901);
      expect(issue?.title).toBe("Issue with concurrent comment");
      expect(issue?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "needs-triage",
      ]);
    });

    test("aborts mutation when issue body is modified during agent transport run", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 902,
        title: "Issue with concurrent body edit",
        state: "OPEN",
        body: "Original body",
        labels: [{ name: "needs-triage" }],
        comments: [],
      });

      // Transport simulates author editing body concurrently
      const transport: AgentTransport = async () => {
        await forge.updateIssue("owner/repo", 902, { body: "Author edited body mid-turn!" });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "promote_single_ticket",
            title: "Canonical Title",
            body: canonicalSingleBody,
            reason: "Promote",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 902,
      });

      expect(result.processed[0]?.status).toBe("skipped");
      expect(result.processed[0]?.reason).toContain("Issue content");

      const issue = await forge.getIssue("owner/repo", 902);
      expect(issue?.body).toBe("Author edited body mid-turn!");
      expect(issue?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "needs-triage",
      ]);
    });

    test("aborts mutation when comment content is modified even if comment count is unchanged", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 903,
        title: "Issue with edited comment",
        state: "OPEN",
        body: "Original body",
        labels: [{ name: "needs-triage" }],
        comments: [{ id: "c1", author: "alice", body: "Original human comment" }],
      });

      // Transport mutates the comment body in place (count remains 1)
      const transport: AgentTransport = async () => {
        forge.editIssueComment("owner/repo", 903, "c1", "Alice edited her comment mid-turn!");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            action: "promote_single_ticket",
            title: "Canonical Title",
            body: canonicalSingleBody,
            reason: "Promote",
          }),
          stderr: "",
        };
      };

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 903,
      });

      expect(result.processed[0]?.status).toBe("skipped");
      expect(result.processed[0]?.reason).toContain("Issue content");
    });
  });

  describe("Dry Run and Batch Execution", () => {
    test("dryRun: true validates output and returns planned status without mutating forge", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 501,
        title: "Dry run test",
        state: "OPEN",
        body: "Please triage",
        labels: [{ name: "needs-triage" }],
      });

      const transport = mockTransport({
        action: "promote_single_ticket",
        title: "Canonical Title",
        body: canonicalSingleBody,
        reason: "Clear scope",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 501,
        dryRun: true,
      });

      expect(result.processed[0]?.status).toBe("planned");
      const issue = await forge.getIssue("owner/repo", 501);
      // Forge was NOT updated
      expect(issue?.title).toBe("Dry run test");
      expect(issue?.labels?.map((l) => (typeof l === "string" ? l : l.name))).toEqual([
        "needs-triage",
      ]);
    });

    test("dryRun: true fails closed when canonical markdown or agreement is invalid", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");
      forge.addIssue("owner/repo", {
        number: 502,
        title: "Dry run invalid markdown test",
        state: "OPEN",
        body: "Please triage",
        labels: [{ name: "needs-triage" }],
      });

      // Transport returns invalid markdown (missing sections)
      const transport = mockTransport({
        action: "promote_single_ticket",
        title: "Canonical Title",
        body: "Invalid incomplete body",
        reason: "Clear scope",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        issueNumber: 502,
        dryRun: true,
      });

      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("Canonical markdown validation failed");
      expect(result.failureCount).toBe(1);
    });

    test("accurate counters track held items without falsely inflating success", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");

      forge.addIssue("owner/repo", {
        number: 503,
        title: "Unsupported provider test",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport: mockTransport({ action: "ask_clarification", question: "?", reason: "r" }),
        acceptedRef,
        issueNumber: 503,
        env: { FACTORY_LOOP_PROVIDER: "unsupported-provider" },
      });

      expect(result.processed[0]?.status).toBe("held");
      expect(result.heldCount).toBe(1);
      expect(result.successCount).toBe(0);
      expect(result.failureCount).toBe(0);
    });

    test("processes multiple eligible open issues respecting limit", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");

      forge.addIssue("owner/repo", {
        number: 601,
        title: "Eligible 1",
        state: "OPEN",
        body: "Body 1",
        labels: [{ name: "needs-triage" }],
      });
      forge.addIssue("owner/repo", {
        number: 602,
        title: "Eligible 2",
        state: "OPEN",
        body: "Body 2",
        labels: [{ name: "needs-triage" }],
      });
      forge.addIssue("owner/repo", {
        number: 603,
        title: "Ineligible (ready-for-agent)",
        state: "OPEN",
        body: "Body 3",
        labels: [{ name: "ready-for-agent" }],
      });

      const transport = mockTransport({
        action: "ask_clarification",
        question: "Question?",
        reason: "Reason",
      });

      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        transport,
        acceptedRef,
        limit: 1, // only process first eligible
      });

      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]?.issueNumber).toBe(601);
      expect(result.successCount).toBe(1);
    });

    test("default AgentTransport executes processRun with real argv and fails closed on non-zero exit", async () => {
      const { root, acceptedRef } = makeGitRepo();
      const stateRoot = makeStateRoot();
      const forge = new SyntheticForgeAdapter();
      forge.addRepository("owner/repo");

      forge.addIssue("owner/repo", {
        number: 604,
        title: "Default transport test",
        state: "OPEN",
        body: "Body",
        labels: [{ name: "needs-triage" }],
      });

      // Do NOT pass transport; exercises default transport ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env))
      // With claude provider, claude without credentials exits non-zero, proving processRun was invoked
      const result = await runTriagePass({
        root,
        repo: "owner/repo",
        stateRoot,
        forge,
        acceptedRef,
        issueNumber: 604,
        env: {
          FACTORY_LOOP_PROVIDER: "claude",
          ANTHROPIC_API_KEY: "invalid-key-to-force-exit",
        },
      });

      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]?.status).toBe("failed");
      expect(result.processed[0]?.error).toContain("Triage agent transport exited with code");
    });
  });
});
