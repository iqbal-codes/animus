import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimusLoop } from "../../scripts/animus-loop";
import * as animusExports from "../../scripts/animus-loop";
import * as loopExports from "../../scripts/loop/index";
import { git, inspectLocalLoop, acquireIssueLock } from "../../scripts/loop/worktree";
import type { LocalIssue, GhRunner } from "../../scripts/loop/types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verification-fixture-"));
  tempDirs.push(root);

  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Test Agent");
  await git(root, "config", "user.email", "agent@animus.local");
  await git(root, "config", "commit.gpgsign", "false");

  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(root, "harness"), { recursive: true });
  await writeFile(
    join(root, "harness/harness.config.json"),
    JSON.stringify({
      static: "echo static-ok",
      unit: "echo unit-ok",
      protected_paths: "harness/**,.factory/holdout/**",
    }),
  );

  await mkdir(join(root, ".animus"), { recursive: true });
  await writeFile(
    join(root, ".animus/config.yaml"),
    `
roles:
  builder:
    model: "small"
`,
  );

  await writeFile(join(root, "README.md"), "# Test Verification Repository\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial commit");
  return root;
}

function makeValidIssue(overrides: Partial<LocalIssue> = {}): LocalIssue {
  const number = overrides.number ?? 80;
  return {
    number,
    url: overrides.url ?? `https://github.com/example/repo/issues/${number}`,
    title: "Implement verification extraction",
    body: "AC1: Validate checks, QA fast-fail, CI fast-fail, and publication",
    comments: [],
    dependencies: [],
    activeClaim: false,
    ...overrides,
  };
}

describe("scripts/loop/verification (migrated to public runAnimusLoop seam)", () => {
  test("AC1: ordinary checks run in worktree, write builder-checks.log and command records", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue();

    const result = await runAnimusLoop(root, issue, {
      push: false,
      transport: async ({ cwd, role }) => {
        if (role === "builder") {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(cwd, "delivered.txt"), "hello\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "deliver");
        }
        const head = await git(cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    candidate: head,
                    sha: head,
                    verdict: "pass",
                    outcome: "approved",
                    passed: true,
                    overall: "PASS",
                    delivers: "all",
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                    lines: [
                      {
                        id: "AC1",
                        kind: "criterion",
                        verdict: "PASS",
                        evidence: ["builder-checks.log"],
                      },
                    ],
                    findings: [],
                    dispositions: [],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("waiting_approval");
    expect(existsSync(join(result.runDirectory, "artifacts", "builder-checks.log"))).toBe(true);
    expect(existsSync(join(result.runDirectory, "artifacts", "host-command-records.json"))).toBe(
      true,
    );

    const logContent = readFileSync(
      join(result.runDirectory, "artifacts", "builder-checks.log"),
      "utf8",
    );
    expect(logContent).toContain("echo static-ok");
    expect(logContent).toContain("echo unit-ok");
  });

  test("AC1: fails closed and transitions to failed when ordinary checks fail", async () => {
    const root = await createRepoFixture();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(root, "harness/harness.config.json"),
      JSON.stringify({ static: "exit 1", unit: "echo ok" }),
    );

    const issue = makeValidIssue();
    const result = await runAnimusLoop(root, issue, {
      push: false,
      transport: async ({ cwd, role }) => {
        if (role === "builder") {
          const { writeFile: wf } = await import("node:fs/promises");
          await wf(join(cwd, "delivered.txt"), "hello\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "deliver");
        }
        const head = await git(cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ candidate: head, verdict: "pass" }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("Ordinary project check failed: exit 1");

    // Lock must be released
    const { common } = await inspectLocalLoop(root);
    const stateRoot = join(common, "factory-local-loop");
    const reacquired = await acquireIssueLock(stateRoot, issue.number);
    expect(typeof reacquired).toBe("function");
    await reacquired();
  });

  test("AC2: QA fast-fail transitions to sent_back when lap < maxLaps, short-circuiting reviewer", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue();
    const capturedRoles: string[] = [];

    const result = await runAnimusLoop(root, issue, {
      push: false,
      transport: async ({ cwd, role }) => {
        capturedRoles.push(role);
        if (role === "builder") {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(cwd, "delivered.txt"), "hello\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "deliver");
          const head = await git(cwd, "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        if (role === "qa") {
          const head = await git(cwd, "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      head,
                      verdict: "fail",
                      overall: "FAIL",
                      passed: false,
                      lines: [
                        { id: "AC1", kind: "criterion", verdict: "FAIL", observed: "QA failure" },
                      ],
                    }),
                  },
                ],
              },
            }),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(capturedRoles).toEqual(["builder", "qa"]);
    expect(result.status).toBe("sent_back");
    expect((result.qaReport as any)?.passed).toBe(false);
    expect(result.reviewerReport).toBeUndefined();
  });

  test("AC2: QA fast-fail escalates to needs_owner when lap reaches maxLaps", async () => {
    const root = await createRepoFixture();
    const bareOrigin = await mkdtemp(join(tmpdir(), "bare-origin-"));
    tempDirs.push(bareOrigin);
    await git(bareOrigin, "init", "--bare", "-b", "main");
    await git(root, "remote", "add", "origin", bareOrigin);
    await git(root, "push", "-u", "origin", "main");

    const { mkdir: mkdirAsync, writeFile } = await import("node:fs/promises");
    await mkdirAsync(join(root, ".factory"), { recursive: true });
    await writeFile(
      join(root, ".factory/schedule.json"),
      JSON.stringify({ workflow: "animus-loop", max_laps: 1 }),
    );

    const issue = makeValidIssue({ number: 81 });
    let escalatedTarget: any = null;
    const ghRunner: GhRunner = async (args) => {
      if (args.includes("edit") && args.includes("ready-for-human")) {
        escalatedTarget = args;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "[]", stderr: "" };
    };

    const result = await runAnimusLoop(root, issue, {
      push: true,
      ghRunner,
      transport: async ({ cwd, role }) => {
        if (role === "builder") {
          const { writeFile: wf } = await import("node:fs/promises");
          await wf(join(cwd, "delivered.txt"), "hello\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "deliver");
          const head = await git(cwd, "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        const head = await git(cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    head,
                    verdict: "fail",
                    overall: "FAIL",
                    passed: false,
                    lines: [
                      {
                        id: "AC1",
                        kind: "criterion",
                        verdict: "FAIL",
                        observed: "max lap reached",
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(result.status).toBe("needs_owner");
    expect(escalatedTarget).not.toBeNull();
    expect(escalatedTarget).toContain("ready-for-human");
  });

  test("AC2: PR CI check failure short-circuits reviewer and transitions through terminal disposition", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue({ number: 82 });

    const capturedRoles: string[] = [];
    const result = await runAnimusLoop(root, issue, {
      push: false,
      checkPrCi: async () => ({
        status: "fail",
        checks: [{ name: "gate-verify", state: "failure", bucket: "fail" }],
        failedChecks: [{ name: "gate-verify", state: "failure", bucket: "fail" }],
        summary: "CI checks failed: gate-verify",
      }),
      transport: async ({ cwd, role }) => {
        capturedRoles.push(role);
        if (role === "builder") {
          const { writeFile } = await import("node:fs/promises");
          await writeFile(join(cwd, "delivered.txt"), "hello\n");
          await git(cwd, "add", "delivered.txt");
          await git(cwd, "commit", "-m", "deliver");
          const head = await git(cwd, "rev-parse", "HEAD");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  { type: "text", text: JSON.stringify({ candidate: head, verdict: "pass" }) },
                ],
              },
            }),
            stderr: "",
          };
        }
        const head = await git(cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    head,
                    verdict: "pass",
                    overall: "PASS",
                    passed: true,
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                    lines: [
                      {
                        id: "AC1",
                        kind: "criterion",
                        verdict: "PASS",
                        evidence: ["builder-checks.log"],
                      },
                    ],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    // Reviewer should NOT have been invoked because CI fast-fail short-circuited it
    expect(capturedRoles).toEqual(["builder", "qa"]);
    expect(result.status).toBe("sent_back");
    expect(existsSync(join(result.runDirectory, "artifacts", "pr-ci.json"))).toBe(true);
  });

  test("AC4: obsolete stage-bag helpers are removed from public exports and barrels", () => {
    expect((loopExports as any).handleQaFastFail).toBeUndefined();
    expect((loopExports as any).handleCiFastFail).toBeUndefined();
    expect((loopExports as any).finalizeReviewAndPublish).toBeUndefined();
    expect((loopExports as any).handleLoopCatch).toBeUndefined();
    expect((loopExports as any).runOrdinaryChecks).toBeUndefined();
    expect((loopExports as any).executeBlackBoxQa).toBeUndefined();
    expect((loopExports as any).verifyPrCiGate).toBeUndefined();
    expect((loopExports as any).recordLapAndReflect).toBeUndefined();

    expect((animusExports as any).handleQaFastFail).toBeUndefined();
    expect((animusExports as any).handleCiFastFail).toBeUndefined();
    expect((animusExports as any).finalizeReviewAndPublish).toBeUndefined();
    expect((animusExports as any).handleLoopCatch).toBeUndefined();
    expect((animusExports as any).runOrdinaryChecks).toBeUndefined();
    expect((animusExports as any).executeBlackBoxQa).toBeUndefined();
    expect((animusExports as any).verifyPrCiGate).toBeUndefined();
    expect((animusExports as any).recordLapAndReflect).toBeUndefined();
  });
});
