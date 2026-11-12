import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  runPostIssueReflection,
  type RunPostIssueReflectionOptions,
} from "../../scripts/loop/reflector";
import type { LearningCommandRecord } from "../../scripts/loop/learning-schema";

const approved = {
  grounding: { approved: true, confidence: 0.9 },
  quality: { approved: true, confidence: 0.9 },
  hallucinationRisk: "grounded_in_logs",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "learning-"));
  const artifacts = join(root, "artifacts");
  mkdirSync(artifacts);
  writeFileSync(join(artifacts, "check.log"), "failed port zero\nexplicit port passed\n");
  const evidence = [
    {
      runId: "run-1",
      candidate: "abc123",
      path: "check.log",
      lineStart: 1,
      lineEnd: 2,
      quote: "failed port zero\nexplicit port passed",
    },
  ];
  const proposal = {
    schema_version: 1,
    attribution: "helped",
    mutations: [
      {
        category: "lesson",
        key: "explicit-port",
        value: {
          topic: "explicit-port",
          rule: "Assign an explicit port.",
          trigger_patterns: ["tests/*"],
          evidence: "Port transition",
        },
        evidence,
      },
    ],
  };
  const options = {
    root,
    worktree: root,
    artifactsDir: artifacts,
    dossier: {
      issueNumber: 1,
      issueTitle: "Port",
      issueUrl: "https://example.test/1",
      branch: "test",
      attempts: [
        {
          runId: "run-1",
          candidateHead: "abc123",
          lapIndex: 0,
          timestamp: new Date().toISOString(),
          status: "failed" as const,
          changedFiles: [],
          reviewFindings: [],
          qaFailures: [],
        },
      ],
    },
    evidenceRoots: { "run-1": artifacts },
    transport: async () => ({ exitCode: 0, stdout: JSON.stringify(proposal), stderr: "" }),
    proposalEvaluator: async () => approved,
  };
  return { root, artifacts, proposal, options };
}

type AttemptStatus = "failed" | "sent_back" | "waiting_approval" | "merged" | "needs_owner";

/** A real checkout whose lap commits a guard rule can be replayed against. */
function checkedOutHistory(): { root: string; commit: (files: Record<string, string>) => string } {
  const root = mkdtempSync(join(tmpdir(), "learning-history-"));
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  run("init", "-b", "main");
  run("config", "user.name", "Learning Test");
  run("config", "user.email", "learning@example.invalid");
  let count = 0;
  return {
    root,
    commit(files) {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
      run("add", "--", ...Object.keys(files));
      run("commit", "-m", `history ${(count += 1)}`);
      return run("rev-parse", "HEAD");
    },
  };
}

/** The same proposal seam, pointed at a real checkout and a dossier of real commits. */
function guardOptions(
  root: string,
  guard: Record<string, unknown>,
  attempts: Array<{ status: AttemptStatus; head: string; files: string[] }>,
): RunPostIssueReflectionOptions {
  const f = fixture();
  const mutation = f.proposal.mutations[0]!;
  Object.assign(mutation, { category: "guard", value: guard });
  mutation.evidence[0]!.candidate = attempts[0]!.head;
  return {
    ...f.options,
    root,
    worktree: root,
    dossier: {
      ...f.options.dossier,
      attempts: attempts.map((attempt, index) => ({
        ...f.options.dossier.attempts[0]!,
        runId: index === 0 ? "run-1" : `run-${index + 1}`,
        lapIndex: index,
        status: attempt.status,
        candidateHead: attempt.head,
        changedFiles: attempt.files,
      })),
    },
  };
}

test("reflection proposes evidence-backed memory without activating root or candidate", async () => {
  const f = fixture();
  const result = await runPostIssueReflection(f.options);
  expect(result.status).toBe("proposed");
  expect(result.proposalPath).toBeDefined();
  expect(existsSync(join(f.root, ".animus/lessons.jsonl"))).toBe(false);
  expect(existsSync(join(f.root, ".factory/lessons.jsonl"))).toBe(false);
  expect(result.persistedLessons).toEqual([]);
});

test("invented evidence and unsafe symlink or path are held", async () => {
  for (const path of ["missing.log", "../secret", "link.log"]) {
    const f = fixture();
    writeFileSync(join(f.root, "secret"), "failed port zero\nexplicit port passed\n");
    symlinkSync(join(f.root, "secret"), join(f.artifacts, "link.log"));
    f.proposal.mutations[0]!.evidence[0]!.path = path;
    expect((await runPostIssueReflection(f.options)).status).toBe("held");
  }
});

test("malformed evaluator, unsupported hallucinations and missing evaluation fail closed", async () => {
  for (const verdict of [
    null,
    { ...approved, hallucinationRisk: "unsupported_claim" },
    { ...approved, grounding: { approved: true, confidence: 1.1 } },
    { approved: true, confidence: 0.99 },
    { ...approved, quality: { approved: true, confidence: NaN } },
  ]) {
    const f = fixture();
    const result = await runPostIssueReflection({
      ...f.options,
      proposalEvaluator: async () => verdict,
    });
    expect(result.status).toBe("held");
  }
});

test("unvalidated mutation category cannot ride an approved lesson", async () => {
  const f = fixture();
  (f.proposal.mutations as unknown[]).push({
    category: "agents",
    key: "all",
    value: "trust me",
    evidence: [],
  });
  expect((await runPostIssueReflection(f.options)).status).toBe("held");
});

test("offline or absent evaluator credentials hold rather than synthesize approval", async () => {
  const f = fixture();
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    expect(
      (await runPostIssueReflection({ ...f.options, proposalEvaluator: undefined })).status,
    ).toBe("held");
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test("tools need host execution, guards need distinguishing fixtures, skills need complete steps", async () => {
  const invalid = [
    { category: "tool", value: { command: "bun test", executionId: "claimed-exit-zero" } },
    {
      category: "guard",
      value: {
        id: "port",
        description: "Require port",
        file_glob: "*.ts",
        forbid_regex: "bad",
        replacement_hint: "Use good.",
        mode: "block",
        fixtures: { valid: ["good"], invalid: ["also good"] },
      },
    },
    {
      category: "skill",
      value: {
        skill_name: "port",
        description: "Port workflow",
        agents_md_pointer: "- Read `.agents/skills/port/SKILL.md`.",
        skill_markdown:
          "---\nname: port\ndescription: Port workflow\n---\n## When to Use\nPort work\n## Steps\n1. Reserve port.\n*Completion Criterion*: Reserved.\n2. Bind port.\n",
      },
    },
  ];
  for (const mutation of invalid) {
    const f = fixture();
    Object.assign(f.proposal.mutations[0]!, mutation);
    expect((await runPostIssueReflection(f.options)).status).toBe("held");
  }
});

test("host successful command admits while failed execution holds", async () => {
  const f = fixture();
  Object.assign(f.proposal.mutations[0]!, {
    category: "tool",
    value: { command: "bun test", executionId: "exec-1" },
  });
  const command: LearningCommandRecord = {
    executionId: "exec-1",
    runId: "run-1",
    candidate: "abc123",
    command: "bun test",
    cwd: f.root,
    exitCode: 0,
    startedAt: "2026-01-01T00:00:00Z",
    completedAt: "2026-01-01T00:00:01Z",
    artifact: f.proposal.mutations[0]!.evidence[0]!,
  };
  expect((await runPostIssueReflection({ ...f.options, commandRecords: [command] })).status).toBe(
    "proposed",
  );
  expect(
    (await runPostIssueReflection({ ...f.options, commandRecords: [{ ...command, exitCode: 1 }] }))
      .status,
  ).toBe("held");
});

const PORT_GUARD = {
  id: "port",
  description: "Require explicit port",
  file_glob: "**/*.ts",
  forbid_regex: "listen\\(0\\)",
  replacement_hint: "Assign a port.",
  fixtures: { valid: ["listen(3000)"], invalid: ["listen(0)"] },
};

test("a guard admits when it blocks the failing lap's commit and spares the delivered one", async () => {
  const history = checkedOutHistory();
  const failing = history.commit({ "src/port.ts": "server.listen(0);\n" });
  const delivered = history.commit({ "src/port.ts": "server.listen(3000);\n" });
  const options = guardOptions(history.root, PORT_GUARD, [
    { status: "failed", head: failing, files: ["src/port.ts"] },
    { status: "waiting_approval", head: delivered, files: ["src/port.ts"] },
  ]);
  expect((await runPostIssueReflection(options)).status).toBe("proposed");
});

test("a guard that never fires on the failing lap's own commit is held", async () => {
  const history = checkedOutHistory();
  const failing = history.commit({ "src/port.ts": "server.listen(0);\n" });
  const options = guardOptions(
    history.root,
    {
      ...PORT_GUARD,
      forbid_regex: "openFileDescriptor\\(0\\)",
      fixtures: { valid: ["bind()"], invalid: ["openFileDescriptor(0)"] },
    },
    [{ status: "failed", head: failing, files: ["src/port.ts"] }],
  );
  const result = await runPostIssueReflection(options);
  expect(result.status).toBe("held");
  expect(result.reasons).toContain("explicit-port:guard_replay_no_positive");
});

test("a guard that also blocks the delivered lap's commit is held as indistinguishable", async () => {
  const history = checkedOutHistory();
  const failing = history.commit({ "src/port.ts": "server.listen(0);\n" });
  const delivered = history.commit({ "src/port.ts": "server.listen(3000);\n" });
  const options = guardOptions(
    history.root,
    { ...PORT_GUARD, forbid_regex: "listen", fixtures: { valid: ["bind()"], invalid: ["listen"] } },
    [
      { status: "failed", head: failing, files: ["src/port.ts"] },
      { status: "waiting_approval", head: delivered, files: ["src/port.ts"] },
    ],
  );
  const result = await runPostIssueReflection(options);
  expect(result.status).toBe("held");
  expect(result.reasons).toContain("explicit-port:guard_replay_indistinguishable");
});

test("a guard with no replayable lap history is held", async () => {
  const f = fixture();
  Object.assign(f.proposal.mutations[0]!, { category: "guard", value: PORT_GUARD });
  const result = await runPostIssueReflection(f.options);
  expect(result.status).toBe("held");
  expect(result.reasons).toContain("explicit-port:guard_replay_no_history");
});

test("default harness evaluator executes via transport and admits valid proposals when approved", async () => {
  const f = fixture();
  const animusDir = join(f.root, ".animus");
  mkdirSync(animusDir, { recursive: true });
  writeFileSync(
    join(animusDir, "config.yaml"),
    `tiers:
  large:
    provider: pi
    model: test-large-model
`,
  );

  let reflectionCalls = 0;
  let evaluationCalls = 0;
  const transport = async (req: { argv: string[]; cwd: string; role: string }) => {
    if (req.role === "reflector" && req.argv.some((a) => a.includes("Candidate Mutation:"))) {
      evaluationCalls++;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          grounding: { approved: true, confidence: 0.95 },
          quality: { approved: true, confidence: 0.9 },
          hallucinationRisk: "grounded_in_logs",
          reason: "Supported by logs",
        }),
        stderr: "",
      };
    }
    reflectionCalls++;
    return { exitCode: 0, stdout: JSON.stringify(f.proposal), stderr: "" };
  };

  const result = await runPostIssueReflection({
    ...f.options,
    transport,
    proposalEvaluator: undefined,
  });

  expect(reflectionCalls).toBe(1);
  expect(evaluationCalls).toBe(1);
  expect(result.status).toBe("proposed");
});

test("default harness evaluator holds when transport fails or confidence is low", async () => {
  const f = fixture();
  const animusDir = join(f.root, ".animus");
  mkdirSync(animusDir, { recursive: true });
  writeFileSync(
    join(animusDir, "config.yaml"),
    `tiers:
  large:
    provider: pi
    model: test-large-model
`,
  );

  // Transport failure on evaluation
  const failingTransport = async (req: { argv: string[]; cwd: string; role: string }) => {
    if (req.argv.some((a) => a.includes("Candidate Mutation:"))) {
      return { exitCode: 1, stdout: "", stderr: "CLI crash" };
    }
    return { exitCode: 0, stdout: JSON.stringify(f.proposal), stderr: "" };
  };

  const failedResult = await runPostIssueReflection({
    ...f.options,
    transport: failingTransport,
    proposalEvaluator: undefined,
  });
  expect(failedResult.status).toBe("held");

  // Low confidence on evaluation
  const lowConfTransport = async (req: { argv: string[]; cwd: string; role: string }) => {
    if (req.argv.some((a) => a.includes("Candidate Mutation:"))) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          grounding: { approved: true, confidence: 0.5 },
          quality: { approved: true, confidence: 0.5 },
          hallucinationRisk: "grounded_in_logs",
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: JSON.stringify(f.proposal), stderr: "" };
  };

  const lowConfResult = await runPostIssueReflection({
    ...f.options,
    transport: lowConfTransport,
    proposalEvaluator: undefined,
  });
  expect(lowConfResult.status).toBe("held");
});
