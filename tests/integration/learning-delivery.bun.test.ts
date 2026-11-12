import { test, expect } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { deliverLearningProposal } from "../../scripts/loop/learning-delivery";
import { runPostIssueReflection } from "../../scripts/loop/reflector";

async function fixture(
  category = "lesson",
  value: unknown = {
    topic: "port",
    trigger_patterns: ["tests/*"],
    rule: "Assign an explicit port.",
    evidence: "transition",
  },
) {
  const root = mkdtempSync(join(tmpdir(), "learning-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "feature\n");
  git("add", ".");
  git("commit", "-m", "feature");
  const candidate = git("rev-parse", "HEAD");
  const artifacts = mkdtempSync(join(tmpdir(), "learning-evidence-"));
  writeFileSync(join(artifacts, "check.log"), "failed\npassed\n");
  const dossier = {
    issueNumber: 1,
    issueTitle: "Port",
    issueUrl: "https://example.test/1",
    branch: "main",
    attempts: [
      {
        runId: "run1",
        candidateHead: candidate,
        lapIndex: 0,
        timestamp: new Date().toISOString(),
        status: "failed" as const,
        changedFiles: [],
        reviewFindings: [],
        qaFailures: [],
      },
    ],
  };
  const proposal = {
    schema_version: 1,
    attribution: "helped",
    mutations: [
      {
        category,
        key: "port",
        value,
        evidence: [
          {
            runId: "run1",
            candidate,
            path: "check.log",
            lineStart: 1,
            lineEnd: 2,
            quote: "failed\npassed",
          },
        ],
      },
    ],
  };
  const evidenceRoots = { run1: artifacts };
  const reflected = await runPostIssueReflection({
    root,
    worktree: root,
    artifactsDir: artifacts,
    dossier,
    evidenceRoots,
    transport: async () => ({ exitCode: 0, stdout: JSON.stringify(proposal), stderr: "" }),
    proposalEvaluator: async () => ({
      grounding: { approved: true, confidence: 0.9 },
      quality: { approved: true, confidence: 0.9 },
      hallucinationRisk: "grounded_in_logs",
    }),
  });
  return {
    root,
    candidate,
    git,
    dossier,
    evidenceRoots,
    proposal,
    artifacts,
    proposalPath: reflected.proposalPath!,
    proposalEvaluator: async () => ({
      grounding: { approved: true, confidence: 0.9 },
      quality: { approved: true, confidence: 0.9 },
      hallucinationRisk: "grounded_in_logs",
    }),
  };
}

test("lightweight delivery opens draft review on isolated commit without changing verified candidate", async () => {
  const f = await fixture();
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    transport: async ({ argv, cwd }) => {
      if (argv[0] === "gh") {
        expect(argv).toContain("--draft");
        return { exitCode: 0, stdout: "https://github.com/test/repo/pull/1\n", stderr: "" };
      }
      if (argv[1] === "push") return { exitCode: 0, stdout: "", stderr: "" };
      return {
        exitCode: 0,
        stdout: execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" }),
        stderr: "",
      };
    },
  });
  expect(result.status).toBe("proposed");
  expect(result.prUrl).toContain("/pull/1");
  expect(f.git("rev-parse", "HEAD")).toBe(f.candidate);
  expect(f.git("status", "--porcelain")).toBe("");
  expect(existsSync(join(f.root, ".animus/lessons.jsonl"))).toBe(false);
  expect(existsSync(join(f.root, ".factory/lessons.jsonl"))).toBe(false);
  expect(result.deliveryHead).not.toBe(f.candidate);
});

test("structural learning remains isolated and review-required", async () => {
  const f = await fixture("pattern", "Use scripts/port.ts for port selection.");
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("proposed");
  expect(result.reviewRequired).toBe(true);
  expect(result.kind).toBe("structural");
  expect(readFileSync(join(result.worktree!, ".animus/codebase-rules.json"), "utf8")).toContain(
    "scripts/port.ts",
  );
  expect(existsSync(join(f.root, ".animus/codebase-rules.json"))).toBe(false);
  expect(existsSync(join(f.root, ".factory/codebase-rules.json"))).toBe(false);
});

test("structural delivery excludes unmerged feature commits", async () => {
  const f = await fixture("pattern", "Use the canonical port module.");
  f.git("checkout", "-b", "feature");
  writeFileSync(join(f.root, "feature-only.txt"), "unmerged");
  f.git("add", ".");
  f.git("commit", "-m", "unmerged feature");
  const featureHead = f.git("rev-parse", "HEAD");
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: featureHead,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("proposed");
  expect(existsSync(join(result.worktree!, "feature-only.txt"))).toBe(false);
  expect(f.git("rev-parse", "HEAD")).toBe(featureHead);
});

test("delivery re-evaluates edited proposals and holds changed evidence", async () => {
  const f = await fixture();
  writeFileSync(join(f.artifacts, "check.log"), "invented\npassed\n");
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("held");
  expect(result.deliveryHead).toBeUndefined();
});

test("delivery runs configured checks and cannot publish after a failed check", async () => {
  const f = await fixture();
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    checks: [["bun", "-e", "process.exit(2)"]],
    publish: false,
  });
  expect(result.status).toBe("held");
  expect(result.deliveryHead).toBeUndefined();
});

test("recurrence deduplicates replay, revisions preserve audit, and topic veto blocks re-ID", async () => {
  const f = await fixture();
  const deliver = (base: string) =>
    deliverLearningProposal({
      ...f,
      verifiedCandidate: f.candidate,
      acceptedBase: base,
      baseBranch: "main",
      publish: false,
    });
  const first = await deliver(f.candidate);
  expect(first.status).toBe("proposed");
  const historyDir = join(first.worktree!, ".animus/learning-history");
  const receiptFile = readdirSync(historyDir).find((name) => name.endsWith(".json"));
  expect(receiptFile).toBeDefined();
  const receipt = JSON.parse(readFileSync(join(historyDir, receiptFile!), "utf8"));
  expect(receipt.sourceCandidate).toBe(f.candidate);
  expect(receipt.accepted[0].evidence[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  const repeated = await deliver(first.deliveryHead!);
  expect(repeated.status).toBe("held");
  expect(repeated.reasons).toContain("no_new_learning");
  const raw = JSON.parse(readFileSync(f.proposalPath, "utf8"));
  raw.accepted[0].mutation.value.rule = "Reserve a port before binding.";
  writeFileSync(f.proposalPath, JSON.stringify(raw));
  const revised = await deliver(first.deliveryHead!);
  expect(revised.status).toBe("proposed");
  const entries = readFileSync(join(revised.worktree!, ".animus/lessons.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(entries).toHaveLength(2);
  expect(entries[0].superseded_by).toBe(entries[1].revision_id);
  expect(entries[1].occurrence_count).toBe(1);
  entries[0].vetoed = true;
  writeFileSync(
    join(revised.worktree!, ".animus/lessons.jsonl"),
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  execFileSync("git", ["add", "."], { cwd: revised.worktree });
  execFileSync("git", ["commit", "-m", "operator veto"], { cwd: revised.worktree });
  const vetoHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: revised.worktree,
    encoding: "utf8",
  }).trim();
  const vetoed = await deliver(vetoHead);
  expect(vetoed.status).toBe("held");
  expect(vetoed.reasons).toContain("operator_veto_topic");
});

test("distinct recorded runs increase recurrence but preserve their exact evidence identities", async () => {
  const f = await fixture();
  const first = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
  });
  const raw = JSON.parse(readFileSync(f.proposalPath, "utf8"));
  raw.accepted[0].mutation.evidence[0].runId = "run2";
  raw.accepted[0].evidence[0].runId = "run2";
  writeFileSync(f.proposalPath, JSON.stringify(raw));
  const dossier = {
    ...f.dossier,
    attempts: [...f.dossier.attempts, { ...f.dossier.attempts[0]!, runId: "run2", lapIndex: 1 }],
  };
  const result = await deliverLearningProposal({
    ...f,
    dossier,
    evidenceRoots: { ...f.evidenceRoots, run2: f.artifacts },
    verifiedCandidate: f.candidate,
    acceptedBase: first.deliveryHead!,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("proposed");
  const entry = JSON.parse(
    readFileSync(join(result.worktree!, ".animus/lessons.jsonl"), "utf8").trim(),
  );
  expect(entry.occurrence_count).toBe(2);
  expect(entry.provenance.map((p: { runId: string }) => p.runId)).toEqual(["run1", "run2"]);
});

test("mixed learning requires explicitly separate delivery categories", async () => {
  const f = await fixture();
  const raw = JSON.parse(readFileSync(f.proposalPath, "utf8"));
  raw.accepted.push({
    ...raw.accepted[0],
    mutation: {
      ...raw.accepted[0].mutation,
      category: "pattern",
      value: "Use the canonical module.",
    },
  });
  writeFileSync(f.proposalPath, JSON.stringify(raw));
  const options = { ...f, verifiedCandidate: f.candidate, baseBranch: "main", publish: false };
  expect((await deliverLearningProposal(options)).reasons).toContain(
    "mixed_proposal_select_delivery_category",
  );
  const lightweight = await deliverLearningProposal({ ...options, category: "lightweight" });
  const structural = await deliverLearningProposal({ ...options, category: "structural" });
  expect(lightweight.status).toBe("proposed");
  expect(structural.status).toBe("proposed");
  expect(existsSync(join(lightweight.worktree!, ".animus/codebase-rules.json"))).toBe(false);
  expect(existsSync(join(structural.worktree!, ".animus/lessons.jsonl"))).toBe(false);
});

test("default harness evaluator in delivery executes via agentTransport and delivers proposal", async () => {
  const f = await fixture();
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

  let evaluationCalls = 0;
  const agentTransport = async (req: { argv: string[]; cwd: string; role: string }) => {
    evaluationCalls++;
    expect(req.role).toBe("reflector");
    expect(req.argv).toContain("--model");
    expect(req.argv).toContain("test-large-model");
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        grounding: { approved: true, confidence: 0.95 },
        quality: { approved: true, confidence: 0.9 },
        hallucinationRisk: "grounded_in_logs",
        reason: "Valid delivery evidence",
      }),
      stderr: "",
    };
  };

  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
    proposalEvaluator: undefined,
    agentTransport,
  });

  expect(evaluationCalls).toBe(1);
  expect(result.status).toBe("proposed");
});

test("default harness evaluator in delivery fails closed when agentTransport returns low confidence", async () => {
  const f = await fixture();
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

  const agentTransport = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      grounding: { approved: true, confidence: 0.5 },
      quality: { approved: true, confidence: 0.5 },
      hallucinationRisk: "grounded_in_logs",
    }),
    stderr: "",
  });

  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
    proposalEvaluator: undefined,
    agentTransport,
  });

  expect(result.status).toBe("held");
  expect(result.reasons).toContain("delivery_evaluation_rejected");
});

test("delivery records the mutation in the harness ledger and its generated changelog", async () => {
  const f = await fixture("pattern", "Use scripts/port.ts for port selection.");
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("proposed");
  const ledger = readFileSync(
    join(result.worktree!, ".animus/learning-history/ledger.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  expect(ledger).toHaveLength(1);
  expect(JSON.parse(ledger[0]!)).toMatchObject({
    issueNumber: 1,
    sourceCandidate: f.candidate,
    mutations: [{ category: "pattern", key: "port" }],
  });
  const changelog = readFileSync(
    join(result.worktree!, ".animus/learning-history/HARNESS-CHANGELOG.md"),
    "utf8",
  );
  expect(changelog).toContain("`pattern:port`");
  expect(changelog).toContain("#1");
});

test("the harness ledger appends to the accepted baseline instead of replacing it", async () => {
  const f = await fixture("pattern", "Use scripts/port.ts for port selection.");
  const earlier = {
    at: "2026-01-01T00:00:00Z",
    issueNumber: 7,
    branch: "learning/7-earlier",
    sourceCandidate: f.candidate,
    receipt: "a".repeat(64),
    mutations: [{ category: "lesson", key: "earlier-lesson" }],
  };
  mkdirSync(join(f.root, ".animus/learning-history"), { recursive: true });
  writeFileSync(
    join(f.root, ".animus/learning-history/ledger.jsonl"),
    `${JSON.stringify(earlier)}\n`,
  );
  f.git("add", ".");
  f.git("commit", "-m", "earlier learning");
  const result = await deliverLearningProposal({
    ...f,
    verifiedCandidate: f.candidate,
    baseBranch: "main",
    publish: false,
  });
  expect(result.status).toBe("proposed");
  const ledger = readFileSync(
    join(result.worktree!, ".animus/learning-history/ledger.jsonl"),
    "utf8",
  )
    .split("\n")
    .filter(Boolean);
  expect(ledger).toHaveLength(2);
  const changelog = readFileSync(
    join(result.worktree!, ".animus/learning-history/HARNESS-CHANGELOG.md"),
    "utf8",
  );
  expect(changelog).toContain("`lesson:earlier-lesson`");
  expect(changelog).toContain("`pattern:port`");
});
