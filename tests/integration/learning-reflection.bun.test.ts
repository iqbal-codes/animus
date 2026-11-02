import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPostIssueReflection } from "../../scripts/loop/reflector";
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

test("reflection proposes evidence-backed memory without activating root or candidate", async () => {
  const f = fixture();
  const result = await runPostIssueReflection(f.options);
  expect(result.status).toBe("proposed");
  expect(result.proposalPath).toBeDefined();
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

test("host successful command and valid guard independently admit while failed execution holds", async () => {
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
  Object.assign(f.proposal.mutations[0]!, {
    category: "guard",
    value: {
      id: "port",
      description: "Require explicit port",
      file_glob: "*.ts",
      forbid_regex: "listen\\(0\\)",
      replacement_hint: "Assign a port.",
      fixtures: { valid: ["listen(3000)"], invalid: ["listen(0)"] },
    },
  });
  expect((await runPostIssueReflection(f.options)).status).toBe("proposed");
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
