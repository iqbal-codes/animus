import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBoundedRole, RoleInterrupted } from "../../scripts/loop/role-runner";
import { runAnimusLoop } from "./support/loop-harness";
import * as loopExports from "../../scripts/loop/index";
import * as animusExports from "./support/loop-harness";
import { git } from "../../scripts/loop/worktree";
import type { LocalIssue } from "../../scripts/loop/types";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

async function createRepoFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "role-runner-fixture-"));
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
      protected_paths: "harness/**,.animus/holdout/**",
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
  await writeFile(join(root, "README.md"), "# Test Role Runner\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial commit");
  return root;
}

function makeValidIssue(): LocalIssue {
  return {
    number: 70,
    url: "https://github.com/example/repo/issues/70",
    title: "Implement role runner extraction",
    body: "AC1: Role runner executes bounded role sessions and enforces deadlines",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };
}

describe("scripts/loop/role-runner (unified bounded role runner)", () => {
  test("AC3: runBoundedRole executes bounded role, extracts structured report, and records evidence", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-"));
    tempDirs.push(runDir);

    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(artifactsDir, "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    let receivedEnv: Record<string, string | undefined> = {};
    let receivedArgv: string[] = [];

    const evidenceList: any[] = [];
    const res = await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70",
      sessionDir: join(runDir, "0-builder-session"),
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 1,
      provider: "pi",
      model: "small",
      transport: async (req) => {
        receivedEnv = req.env ?? {};
        receivedArgv = req.argv;
        const { writeFile } = await import("node:fs/promises");
        await writeFile(join(req.cwd, "delivered.txt"), "hello world\n");
        await git(req.cwd, "add", "delivered.txt");
        await git(req.cwd, "commit", "-m", "feat: deliver 70");
        const head = await git(req.cwd, "rev-parse", "HEAD");
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
                    verdict: "pass",
                    passed: true,
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
      onEvidence: (ev) => {
        evidenceList.push(ev);
      },
    });

    expect(res.report).toBeDefined();
    expect(res.report.verdict).toBe("pass");
    expect(evidenceList.length).toBe(1);
    expect(evidenceList[0].role).toBe("builder");
    expect(receivedEnv.FACTORY_LOOP_SOFT_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_HARD_DEADLINE_MS).toBeDefined();
    expect(receivedEnv.FACTORY_LOOP_CHECKPOINT_PATH).toBe(join(handoffDir, "checkpoint.md"));
    expect(receivedArgv.length).toBeGreaterThan(0);
    expect(receivedArgv.at(-1)).toContain("Bounded role execution");
  });

  test("AC3: runBoundedRole enforces checkpointing and throws RoleInterrupted when budget exhausted", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-interrupted-"));
    tempDirs.push(runDir);

    const artifactsDir = join(runDir, "artifacts");
    const handoffDir = join(artifactsDir, "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    const checkpointPath = join(handoffDir, "checkpoint.md");

    expect(
      runBoundedRole({
        role: "builder",
        root,
        cwd: root,
        prompt: "Deliver feature 71",
        checkpointPath,
        handoffDir,
        runDirectory: runDir,
        budget: { softMs: 1_000, hardMs: 2_000 },
        maxContinuations: 0,
        provider: "pi",
        model: "small",
        transport: async () => ({
          exitCode: 124,
          stdout: "",
          stderr: "timed out",
          timedOut: true,
        }),
      }),
    ).rejects.toThrow(RoleInterrupted);

    // Verify checkpoint was written
    expect(existsSync(checkpointPath)).toBe(true);
    const checkpointContent = readFileSync(checkpointPath, "utf8");
    expect(checkpointContent).toContain("Host checkpoint: builder attempt 0");
  });

  test("AC3: runAnimusLoop handles role interruption and transitions cleanly to interrupted", async () => {
    const root = await createRepoFixture();
    const issue = makeValidIssue();

    const result = await runAnimusLoop(root, issue, {
      push: false,
      maxContinuations: 0,
      transport: async () => ({
        exitCode: 124,
        stdout: "",
        stderr: "timed out",
        timedOut: true,
      }),
    });

    expect(result.status).toBe("interrupted");
    expect(result.error).toContain("interrupted");
    const checkpointPath = join(result.runDirectory, "artifacts", "handoff", "checkpoint.md");
    expect(existsSync(checkpointPath)).toBe(true);
  });

  test("continuation resumes the observed session in the same session directory", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-continuation-"));
    tempDirs.push(runDir);
    const handoffDir = join(runDir, "artifacts", "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    const seen: Array<{ argv: string[]; sessionDir?: string }> = [];

    const res = await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70 across attempts",
      sessionDir: join(runDir, "0-builder-session"),
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 1,
      provider: "pi",
      model: "small",
      transport: async (req) => {
        const sessionDirFlag = req.argv[req.argv.indexOf("--session-dir") + 1];
        seen.push({ argv: [...req.argv], sessionDir: sessionDirFlag });

        if (seen.length === 1) {
          // First attempt writes a real transcript so attempt 2 can resume it.
          const sessionDir = sessionDirFlag!;
          await mkdir(join(sessionDir, "--/cwd--"), { recursive: true });
          await (
            await import("node:fs/promises")
          ).writeFile(
            join(sessionDir, "--/cwd--", "2026-01-01T00-00-00-000Z_first-attempt.jsonl"),
            "",
          );
          return {
            exitCode: 0,
            stdout: [
              JSON.stringify({ type: "session", version: 3, id: "first-attempt", cwd: req.cwd }),
              JSON.stringify({ type: "message_end", content: [{ type: "text", text: "" }] }),
            ].join("\n"),
            stderr: "",
            timedOut: true,
          };
        }

        const head = await git(req.cwd, "rev-parse", "HEAD");
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
                    verdict: "pass",
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(seen.length).toBe(2);
    // Same session directory for both attempts; no separate per-attempt directory.
    expect(seen[0]!.sessionDir).toBe(join(runDir, "0-builder-session"));
    expect(seen[1]!.sessionDir).toBe(seen[0]!.sessionDir);
    // The continuation resumes the id observed in attempt 0.
    expect(seen[1]!.argv).toContain("--session-id");
    expect(seen[1]!.argv).toContain("first-attempt");
    expect(seen[1]!.argv).not.toContain("--continue");
    expect(res.report.verdict).toBe("pass");
  });

  test("continuation prompt never claims resume when provider layout is unverified", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-continuation-unverified-"));
    tempDirs.push(runDir);
    const handoffDir = join(runDir, "artifacts", "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    const prompts: string[] = [];

    await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70",
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 1,
      provider: "commandcode",
      model: "small",
      transport: async (req) => {
        prompts.push(req.argv.at(-1)!);
        if (prompts.length === 1) {
          return {
            exitCode: 0,
            stdout: [
              JSON.stringify({ type: "result", sessionId: "cc-session", finalText: "" }),
            ].join("\n"),
            stderr: "",
            timedOut: true,
          };
        }
        const head = await git(req.cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "result",
            sessionId: "cc-session",
            finalText: JSON.stringify({
              candidate: head,
              verdict: "pass",
              checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
            }),
          }),
          stderr: "",
        };
      },
    });

    expect(prompts[1]).toContain("No prior conversation was resumed");
    expect(prompts[1]).not.toContain("Your previous conversation in this role is resumed");
  });

  test("AC4: invokeRoleWithDeadlines is NOT exported in barrel or public animus-loop orchestrator", () => {
    expect((loopExports as any).invokeRoleWithDeadlines).toBeUndefined();
    expect((animusExports as any).invokeRoleWithDeadlines).toBeUndefined();
    expect(typeof loopExports.runBoundedRole).toBe("function");
  });

  test("resumes an explicit session id on the first attempt and reports the observed id", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-resume-"));
    tempDirs.push(runDir);
    const handoffDir = join(runDir, "artifacts", "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    const seenArgv: string[][] = [];
    const res = await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70 again",
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 0,
      provider: "pi",
      model: "small",
      resumeSessionId: "resume-me-123",
      transport: async (req) => {
        seenArgv.push(req.argv);
        const head = await git(req.cwd, "rev-parse", "HEAD");
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "session", version: 3, id: "resume-me-123", cwd: req.cwd }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      candidate: head,
                      verdict: "pass",
                      checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                    }),
                  },
                ],
              },
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    });

    // Pi resumes by an explicit id via --session-id; never --continue.
    expect(seenArgv[0]).toContain("--session-id");
    expect(seenArgv[0]).toContain("resume-me-123");
    expect(seenArgv[0]).not.toContain("--continue");
    expect(res.sessionId).toBe("resume-me-123");
  });

  test("omits resume flags when no session id is given", async () => {
    const root = await createRepoFixture();
    const runDir = await mkdtemp(join(tmpdir(), "role-run-fresh-"));
    tempDirs.push(runDir);
    const handoffDir = join(runDir, "artifacts", "handoff");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });

    let argv: string[] = [];
    const res = await runBoundedRole({
      role: "builder",
      root,
      cwd: root,
      prompt: "Deliver feature 70 fresh",
      checkpointPath: join(handoffDir, "checkpoint.md"),
      handoffDir,
      runDirectory: runDir,
      budget: { softMs: 10_000, hardMs: 15_000 },
      maxContinuations: 0,
      provider: "pi",
      model: "small",
      transport: async (req) => {
        argv = req.argv;
        const head = await git(req.cwd, "rev-parse", "HEAD");
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
                    verdict: "pass",
                    checks: [{ criterion: "AC1", result: "pass", evidence: "verified" }],
                  }),
                },
              ],
            },
          }),
          stderr: "",
        };
      },
    });

    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--continue");
    expect(res.sessionId).toBeUndefined();
  });
});
