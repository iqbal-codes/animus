import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLocalLoop, type AgentTransport } from "./support/loop-harness";
import {
  recordLapAttempt,
  shouldTriggerReflection,
  loadIssueDossier,
} from "../../scripts/loop/dossier";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dossier(
  statuses: Array<"failed" | "sent_back" | "waiting_approval" | "merged" | "needs_owner">,
) {
  const root = mkdtempSync(join(tmpdir(), "reflection-lifecycle-"));
  roots.push(root);
  let result;
  for (const status of statuses)
    result = recordLapAttempt(
      root,
      {
        issueNumber: 1,
        issueTitle: "Fix",
        issueUrl: "https://github.com/o/r/issues/1",
        branch: "fix",
      },
      {
        runId: `run-${status}`,
        timestamp: "2026-01-01T00:00:00Z",
        status,
        changedFiles: [],
        reviewFindings: [],
        qaFailures: [],
      },
    );
  return result!;
}

test("explicit within-lap recovery triggers reflection only after terminal resolution", () => {
  const resolved = dossier(["waiting_approval"]);
  resolved.attempts[0]!.recoveries = [
    { role: "builder", artifact: "builder-attempt-0.json", reason: "hard deadline exceeded" },
  ];
  expect(shouldTriggerReflection(resolved)).toBe(true);
  resolved.attempts[0]!.status = "sent_back";
  expect(shouldTriggerReflection(resolved)).toBe(false);
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function runRecovered(
  reflect: AgentTransport,
  reflection?: NonNullable<Parameters<typeof runLocalLoop>[2]>["reflection"],
) {
  const root = mkdtempSync(join(tmpdir(), "reflection-delivery-"));
  roots.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Offline Test");
  await Bun.write(
    join(root, "harness/harness.config.json"),
    JSON.stringify({ static: "true", unit: "true", protected_paths: "MISSION.md" }),
  );
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  let attempts = 0;
  const transport: AgentTransport = async (request) => {
    if (request.role === "reflector") return reflect(request);
    if (request.role === "builder") {
      if (attempts++ === 0) return { exitCode: 124, stdout: "", stderr: "", timedOut: true };
      await Bun.write(join(request.cwd, "fix.txt"), "fixed\n");
      git(request.cwd, "add", "fix.txt");
      git(request.cwd, "commit", "-m", "fix");
    }
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        candidate: git(request.cwd, "rev-parse", "HEAD"),
        verdict: "pass",
        findings: [],
        checks: [{ criterion: "AC1", result: "pass", evidence: "builder-checks.log" }],
      }),
    };
  };
  const result = await runLocalLoop(
    root,
    {
      number: 1,
      url: "https://github.com/o/r/issues/1",
      title: "Fix",
      body: "Fix it",
      comments: [],
      dependencies: [],
      activeClaim: false,
    },
    { transport, push: false, reflection },
  );
  const stateRoot = join(root, ".git/factory-local-loop");
  return { root, result, dossier: loadIssueDossier(stateRoot, 1)! };
}

for (const mode of ["error", "malformed", "held", "no_entry", "dirty"] as const) {
  test(`within-lap recovery preserves delivery and retry semantics when reflection is ${mode}`, async () => {
    let scratch = "";
    const { result, dossier } = await runRecovered(async (request) => {
      scratch = request.cwd;
      if (mode === "error") throw new Error("offline reflector failed");
      if (mode === "dirty") await Bun.write(join(request.cwd, "scratch.txt"), "preserve me");
      return {
        exitCode: 0,
        stderr: "",
        stdout:
          mode === "malformed"
            ? "not json"
            : JSON.stringify({
                schema_version: 1,
                attribution: "no_observed_effect",
                mutations:
                  mode === "held"
                    ? [{ category: "pattern", key: "unproven", value: "unproven", evidence: [] }]
                    : [],
              }),
      };
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("waiting_approval");
    expect(git(result.worktree, "rev-parse", "HEAD")).toBe(result.candidate!);
    expect(git(result.worktree, "status", "--porcelain")).toBe("");
    expect(dossier.attempts[0]!.recoveries).toHaveLength(1);
    expect(Boolean(dossier.reflectedAt)).toBe(mode === "no_entry" || mode === "dirty");
    if (mode === "dirty")
      expect(await Bun.file(join(scratch, "scratch.txt")).text()).toBe("preserve me");
  });
}

test("out-of-band mutation of verified candidate is detected and held", async () => {
  const { result, dossier } = await runRecovered(async (request) => {
    const records = git(request.cwd, "worktree", "list", "--porcelain").split("\n\n");
    const feature = records.find((record) => record.includes("branch refs/heads/local-loop/"));
    expect(feature).toBeDefined();
    const checkout = feature!.split("\n")[0]!.slice("worktree ".length);
    await Bun.write(join(checkout, "fix.txt"), "unauthorized mutation\n");
    return {
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        schema_version: 1,
        attribution: "no_observed_effect",
        mutations: [],
      }),
    };
  });
  expect(result.status).toBe("failed");
  expect(result.error).toContain("Reflection changed the verified candidate or dirty state");
  expect(dossier.reflectedAt).toBeUndefined();
});

for (const failDelivery of [false, true]) {
  test(`gated learning proposal ${failDelivery ? "delivery failure remains retryable" : "delivers on an isolated branch before marking reflected"}`, async () => {
    const { result, dossier } = await runRecovered(
      async (request) => {
        const commands = await Bun.file(
          join(dirname(request.cwd), "artifacts/host-command-records.json"),
        ).json();
        const record = commands[0];
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            schema_version: 1,
            attribution: "helped",
            mutations: [
              {
                category: "tool",
                key: "verify",
                value: { command: record.command, executionId: record.executionId },
                evidence: [record.artifact],
              },
            ],
          }),
        };
      },
      {
        proposalEvaluator: async () => ({
          grounding: { approved: true, confidence: 1 },
          quality: { approved: true, confidence: 1 },
          hallucinationRisk: "grounded_in_logs",
        }),
        ...(failDelivery
          ? {
              deliveryTransport: async () => ({
                exitCode: 1,
                stdout: "",
                stderr: "offline delivery failure",
              }),
            }
          : {}),
      },
    );
    expect(result.status).toBe("waiting_approval");
    expect(result.error).toBeUndefined();
    const delivery = await Bun.file(
      join(result.runDirectory, "artifacts/learning-delivery.json"),
    ).json();
    expect(delivery.status).toBe(failDelivery ? "held" : "proposed");
    expect(Boolean(dossier.reflectedAt)).toBe(!failDelivery);
    expect(git(result.worktree, "rev-parse", "HEAD")).toBe(result.candidate!);
    expect(git(result.worktree, "status", "--porcelain")).toBe("");
    if (!failDelivery) {
      expect(delivery.kind).toBe("lightweight");
      expect(delivery.deliveryHead).not.toBe(result.candidate!);
      expect(await Bun.file(join(delivery.worktree, ".animus/tool-guidance.json")).json()).toEqual({
        verify: "true",
      });
      expect(await Bun.file(join(result.worktree, ".animus/tool-guidance.json")).exists()).toBe(
        false,
      );
    }
  });
}

test("historic failures never turn a nonterminal lap into terminal reflection", () => {
  expect(shouldTriggerReflection(dossier(["failed", "sent_back", "failed"]))).toBe(false);
  expect(shouldTriggerReflection(dossier(["sent_back", "sent_back"]))).toBe(false);
  expect(shouldTriggerReflection(dossier(["failed", "waiting_approval"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["failed", "merged"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["needs_owner"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["waiting_approval"]))).toBe(false);
});
