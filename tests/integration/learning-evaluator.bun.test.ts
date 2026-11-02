import { test, expect } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateLearningWithHarness } from "../../scripts/loop/learning-gates";
import type {
  LearningMutation,
  ResolvedLearningEvidence,
} from "../../scripts/loop/learning-schema";
import type { AgentTransport } from "../../scripts/loop/types";

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "learning-eval-"));
  const animusDir = join(root, ".animus");
  mkdirSync(animusDir, { recursive: true });
  writeFileSync(
    join(animusDir, "config.yaml"),
    `assistant: pi
assistants:
  pi:
    model: test-model
tiers:
  large:
    provider: pi
    model: test-model
    effort: high
`,
  );

  const mutation: LearningMutation = {
    category: "lesson",
    key: "explicit-port",
    value: {
      topic: "explicit-port",
      rule: "Assign an explicit port.",
      trigger_patterns: ["tests/*"],
      evidence: "Port transition",
    },
    evidence: [
      {
        runId: "run-1",
        candidate: "abc123",
        path: "check.log",
        lineStart: 1,
        lineEnd: 2,
        quote: "failed port zero\nexplicit port passed",
      },
    ],
  };

  const resolvedEvidence: ResolvedLearningEvidence[] = [
    {
      ...mutation.evidence[0]!,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      content: "failed port zero\nexplicit port passed",
    },
  ];

  return { root, mutation, resolvedEvidence };
}

test("evaluateLearningWithHarness fails closed when PI_OFFLINE=1", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      grounding: { approved: true, confidence: 0.9 },
      quality: { approved: true, confidence: 0.9 },
      hallucinationRisk: "grounded_in_logs",
    }),
    stderr: "",
  });

  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: f.root,
      transport,
      env: { PI_OFFLINE: "1" },
    }),
    /harness_evaluator_offline/,
  );
});

test("evaluateLearningWithHarness fails closed when provider or model is not configured", async () => {
  const f = createFixture();
  const emptyRoot = mkdtempSync(join(tmpdir(), "empty-animus-"));
  const transport: AgentTransport = async () => ({
    exitCode: 0,
    stdout: "{}",
    stderr: "",
  });

  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: emptyRoot,
      transport,
      env: {},
    }),
    /harness_evaluator_unconfigured/,
  );
});

test("unknown configured provider cannot silently select a different harness", async () => {
  const f = createFixture();
  writeFileSync(
    join(f.root, ".animus/config.yaml"),
    "assistant: unknown-harness\nassistants:\n  unknown-harness:\n    model: test-model\n",
  );
  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: f.root,
      transport: async () => {
        throw new Error("unexpected provider fallback");
      },
    }),
    /harness_evaluator_unconfigured/,
  );
});

test("evaluateLearningWithHarness fails closed on transport failure", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "process exited with code 1",
  });

  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: f.root,
      transport,
      env: {},
    }),
    /harness_evaluator_transport_failed/,
  );
});

test("evaluateLearningWithHarness fails closed on transport timeout", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 124,
    stdout: "",
    stderr: "timeout",
    timedOut: true,
  });

  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: f.root,
      transport,
      env: {},
    }),
    /harness_evaluator_timeout/,
  );
});

test("evaluateLearningWithHarness fails closed on malformed agent output", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 0,
    stdout: "not json at all",
    stderr: "",
  });

  await rejects(
    evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
      root: f.root,
      transport,
      env: {},
    }),
    /harness_evaluator_malformed/,
  );
});

test("evaluateLearningWithHarness fails closed when schema confidence is outside [0, 1]", async () => {
  const f = createFixture();
  for (const invalidConfidence of [-0.1, 1.1, NaN]) {
    const transport: AgentTransport = async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        grounding: { approved: true, confidence: invalidConfidence },
        quality: { approved: true, confidence: 0.9 },
        hallucinationRisk: "grounded_in_logs",
      }),
      stderr: "",
    });

    await rejects(
      evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
        root: f.root,
        transport,
        env: {},
      }),
      /harness_evaluator_schema_mismatch/,
    );
  }
});

test("evaluateLearningWithHarness clamps approved to false when confidence is below 0.7", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      grounding: { approved: true, confidence: 0.65 },
      quality: { approved: true, confidence: 0.9 },
      hallucinationRisk: "grounded_in_logs",
    }),
    stderr: "",
  });

  const verdict = await evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
    root: f.root,
    transport,
    env: {},
  });

  expect(verdict.grounding.approved).toBe(false);
  expect(verdict.grounding.confidence).toBe(0.65);
});

test("evaluateLearningWithHarness preserves ungrounded hallucinationRisk", async () => {
  const f = createFixture();
  const transport: AgentTransport = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      grounding: { approved: true, confidence: 0.9 },
      quality: { approved: true, confidence: 0.9 },
      hallucinationRisk: "unsupported_claim",
    }),
    stderr: "",
  });

  const verdict = await evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
    root: f.root,
    transport,
    env: {},
  });

  expect(verdict.hallucinationRisk).toBe("unsupported_claim");
});

test("ambient offline mode cannot be bypassed by unrelated environment overrides", async () => {
  const f = createFixture();
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    await rejects(
      evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
        root: f.root,
        env: { OTHER_SETTING: "enabled" },
        transport: async () => {
          throw new Error("transport must not run offline");
        },
      }),
      /harness_evaluator_offline/,
    );
  } finally {
    if (previous === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous;
  }
});

test("configured harness content events are parsed through the shared report boundary", async () => {
  const f = createFixture();
  const verdict = await evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
    root: f.root,
    transport: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        content: JSON.stringify({
          grounding: { approved: true, confidence: 0.8 },
          quality: { approved: true, confidence: 0.85 },
          hallucinationRisk: "grounded_in_logs",
        }),
      }),
      stderr: "",
    }),
  });
  expect(verdict.quality.confidence).toBe(0.85);
  expect(verdict.grounding.approved).toBe(true);
});

test("evaluateLearningWithHarness builds real CLI argv and succeeds with valid verdict", async () => {
  const f = createFixture();
  let receivedArgv: string[] = [];
  let receivedRole: string = "";
  let receivedProvider: string | undefined = "";

  const transport: AgentTransport = async (req) => {
    receivedArgv = req.argv;
    receivedRole = req.role;
    receivedProvider = req.provider;

    return {
      exitCode: 0,
      stdout: JSON.stringify({
        grounding: { approved: true, confidence: 0.95 },
        quality: { approved: true, confidence: 0.9 },
        hallucinationRisk: "grounded_in_logs",
        reason: "Valid evidence supports the explicit port guidance.",
      }),
      stderr: "",
    };
  };

  const verdict = await evaluateLearningWithHarness(f.mutation, f.resolvedEvidence, {
    root: f.root,
    transport,
    env: {},
  });

  expect(verdict.grounding.approved).toBe(true);
  expect(verdict.grounding.confidence).toBe(0.95);
  expect(verdict.quality.approved).toBe(true);
  expect(verdict.hallucinationRisk).toBe("grounded_in_logs");
  expect(receivedRole).toBe("reflector");
  expect(receivedProvider).toBe("pi");
  expect(receivedArgv[0]).toBe("pi");
  expect(receivedArgv).toContain("--model");
  expect(receivedArgv).toContain("test-model");
});
