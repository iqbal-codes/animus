import { expect, test } from "bun:test";
import { interruptionReport, resolveRoleBudgets } from "../../scripts/loop/deadlines";
import { processRun } from "../../scripts/loop/process";
import { runLocalLoop } from "../../scripts/local-loop";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("role budgets default independently and reject invalid or inverted deadlines", () => {
  const budgets = resolveRoleBudgets({});
  expect(budgets.builder).toEqual({ softMs: 1_200_000, hardMs: 1_500_000 });
  expect(budgets.qa).toEqual({ softMs: 900_000, hardMs: 1_200_000 });
  expect(budgets.reviewer).toEqual({ softMs: 900_000, hardMs: 1_200_000 });
  expect(resolveRoleBudgets({ timeoutMs: 100 }).builder).toEqual({ softMs: 80, hardMs: 100 });
  expect(resolveRoleBudgets({ roleBudgets: { qa: { softMs: 10, hardMs: 20 } } }).qa).toEqual({
    softMs: 10,
    hardMs: 20,
  });
  for (const timeoutMs of [0, -1, Infinity, NaN, 1.5]) {
    expect(() => resolveRoleBudgets({ timeoutMs })).toThrow();
  }
  for (const softMs of [0, -1, NaN, 20, 21]) {
    expect(() =>
      resolveRoleBudgets({ roleBudgets: { builder: { softMs, hardMs: 20 } } }),
    ).toThrow();
  }
  for (const maxContinuations of [-1, 3, 0.5, NaN]) {
    expect(() => resolveRoleBudgets({ maxContinuations })).toThrow();
  }
});

test("CLI environment budgets are validated and explicit role options win", () => {
  expect(
    resolveRoleBudgets({}, { FACTORY_LOOP_QA_SOFT_MS: "30", FACTORY_LOOP_QA_HARD_MS: "40" }).qa,
  ).toEqual({ softMs: 30, hardMs: 40 });
  expect(() => resolveRoleBudgets({}, { FACTORY_LOOP_QA_HARD_MS: "no" })).toThrow();
  expect(
    resolveRoleBudgets(
      { roleBudgets: { qa: { softMs: 10, hardMs: 20 } } },
      { FACTORY_LOOP_QA_HARD_MS: "no" },
    ).qa,
  ).toEqual({ softMs: 10, hardMs: 20 });
});

test("timeoutMs overrides shadowed invalid environment budgets", () => {
  expect(
    resolveRoleBudgets(
      { timeoutMs: 10 },
      {
        FACTORY_LOOP_BUILDER_SOFT_MS: "invalid",
        FACTORY_LOOP_QA_HARD_MS: "-1",
      },
    ).qa,
  ).toEqual({ softMs: 8, hardMs: 10 });
});

test("interruption reports support string content provider envelopes", () => {
  expect(interruptionReport(JSON.stringify({ content: '{"verdict":"interrupted"}' }))).toBe(true);
  expect(interruptionReport(JSON.stringify({ content: '{"verdict":"pass"}' }))).toBe(false);
});

test("owned execution drains large output exactly and forwards environment", async () => {
  const result = await processRun(
    [
      "node",
      "-e",
      `process.stdout.write('x'.repeat(2_000_000)); process.stderr.write(process.env.DRAIN_TEST)`,
    ],
    process.cwd(),
    5000,
    { DRAIN_TEST: "forwarded" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("x".repeat(2_000_000));
  expect(result.stderr).toBe("forwarded");
});

test("hard timeout kills owned child and grandchild but preserves unrelated cwd reader", async () => {
  const reader = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  try {
    const started = Date.now();
    const result = await processRun(
      [
        "node",
        "-e",
        `
      const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
      console.log(JSON.stringify([process.pid,grandchild.pid]));
      setInterval(()=>{},1000);
    `,
      ],
      process.cwd(),
      400,
    );
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    const pids: number[] = JSON.parse(result.stdout.trim());
    for (const pid of pids) {
      const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
        .stdout.toString()
        .trim();
      expect(state === "" || state.startsWith("Z")).toBe(true);
    }
    expect(() => process.kill(reader.pid!, 0)).not.toThrow();
  } finally {
    reader.kill("SIGKILL");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`host ${signal} exits after cleaning all owned groups and preserves unrelated processes`, async () => {
    const reader = spawn("node", ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const modulePath = join(process.cwd(), "scripts/loop/process.ts");
    const host = spawn(
      process.execPath,
      [
        "-e",
        `
      import { processRun } from ${JSON.stringify(modulePath)};
      await Promise.all([1,2].map(() => processRun(['node','-e', \`
        const {spawn}=require('node:child_process');
        process.on('SIGTERM',()=>{});
        const grandchild=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
        console.log(JSON.stringify([process.pid,grandchild.pid]));
        setInterval(()=>{},1000);
      \`], process.cwd(), 30000).then(r=>console.log(r.stdout))));
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let pids: number[] = [];
    const exited = new Promise<number | null>((resolve) => host.once("exit", resolve));
    try {
      // Readiness comes from the owned processes, not a sleep before signaling.
      for (let i = 0; i < 200; i++) {
        const listing = Bun.spawnSync(["ps", "-axo", "pid=,ppid="]).stdout.toString();
        const rows = listing
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        const children = rows.filter(([, parent]) => parent === host.pid).map(([pid]) => pid!);
        const grandchildren = rows
          .filter(([, parent]) => children.includes(parent!))
          .map(([pid]) => pid!);
        if (children.length === 2 && grandchildren.length === 2) {
          pids = [...children, ...grandchildren];
          break;
        }
        await Bun.sleep(10);
      }
      expect(pids).toHaveLength(4);
      host.kill(signal);
      const code = await Promise.race([exited, Bun.sleep(3000).then(() => "timeout")]);
      expect(code).toBe(signal === "SIGINT" ? 130 : 143);
      for (const pid of pids) {
        const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
          .stdout.toString()
          .trim();
        expect(state === "" || state.startsWith("Z")).toBe(true);
      }
      expect(() => process.kill(reader.pid!, 0)).not.toThrow();
    } finally {
      host.kill("SIGKILL");
      reader.kill("SIGKILL");
      const cleanup = pids.map((pid) =>
        Promise.resolve().then(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }),
      );
      await Promise.all([...cleanup, exited]);
    }
  });
}

test("owned execution removes host signal listeners after every completion path", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await processRun(["node", "-e", ""], process.cwd(), 1000);
  await processRun(["/nonexistent-deadline-executable"], process.cwd(), 1000);
  await processRun(["node", "-e", "setInterval(()=>{},1000)"], process.cwd(), 20);
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "deadline-loop-"));
  git(root, "init");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Deadline Tests");
  await mkdir(join(root, "harness"));
  await Bun.write(join(root, "harness/harness.config.json"), JSON.stringify({ static: "true" }));
  await Bun.write(join(root, "README.md"), "base");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  const bin = join(root, "bin");
  await mkdir(bin);
  await Bun.write(join(bin, "gh"), "#!/bin/sh\nprintf '[]'\n");
  await chmod(join(bin, "gh"), 0o755);
  return { root, bin };
}

const issue = {
  number: 1,
  url: "https://github.com/test/offline/issues/1",
  title: "deadline",
  body: "test deadline",
  comments: [],
  dependencies: [],
  activeClaim: false,
};

for (const mode of ["hard", "soft"] as const) {
  test(`${mode} exhaustion checkpoints dirty work and never promotes QA or publishes`, async () => {
    const { root, bin } = await fixture();
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const worktrees: string[] = [];
      const result = await runLocalLoop(root, issue, {
        maxContinuations: 1,
        transport: async ({ cwd, role, argv, env }) => {
          expect(role).toBe("builder");
          expect(Number(env!.FACTORY_LOOP_HARD_DEADLINE_MS)).toBeGreaterThan(
            Number(env!.FACTORY_LOOP_SOFT_DEADLINE_MS),
          );
          expect(argv.join(" ")).toContain(env!.FACTORY_LOOP_CHECKPOINT_PATH!);
          worktrees.push(cwd);
          await Bun.write(join(cwd, "partial.txt"), "durable partial work");
          if (worktrees.length === 2) {
            expect(await Bun.file(env!.FACTORY_LOOP_CHECKPOINT_PATH!).text()).toContain(
              "partial.txt",
            );
            expect(argv.join(" ")).toContain("Continuation 1");
          }
          return {
            exitCode: mode === "hard" ? 124 : 0,
            timedOut: mode === "hard",
            stdout: JSON.stringify({ verdict: "interrupted" }),
            stderr: "",
          };
        },
      });
      expect(result.status).toBe("interrupted");
      expect(result.error).toContain("exhausted");
      expect(worktrees).toEqual([result.worktree, result.worktree]);
      expect(result.evidence).toHaveLength(2);
      expect(new Set(result.evidence.map((e) => e.artifact)).size).toBe(2);
      expect(result.pr).toBeUndefined();
      expect(await Bun.file(join(result.worktree, "partial.txt")).text()).toBe(
        "durable partial work",
      );
      const checkpoint = await Bun.file(
        join(result.runDirectory, "artifacts/handoff/checkpoint.md"),
      ).text();
      expect(checkpoint).toContain("HEAD:");
      expect(checkpoint).toContain("Stage: building");
      expect(checkpoint).toContain("builder-attempt-1.json");
    } finally {
      process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const maxContinuations of [0, 2]) {
  test(`continuation limit ${maxContinuations} bounds the number of attempts`, async () => {
    const { root, bin } = await fixture();
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      let attempts = 0;
      const result = await runLocalLoop(root, issue, {
        maxContinuations,
        push: false,
        transport: async () => {
          attempts++;
          return { exitCode: 124, timedOut: true, stdout: "", stderr: "deadline" };
        },
      });
      expect(result.status).toBe("interrupted");
      expect(attempts).toBe(maxContinuations + 1);
    } finally {
      process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("soft checkpoint continues builder in place and requires fresh successful QA and review", async () => {
  const { root, bin } = await fixture();
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const roles: string[] = [];
    const result = await runLocalLoop(root, issue, {
      push: false,
      transport: async ({ cwd, role, env }) => {
        roles.push(role);
        if (roles.length === 1) {
          await Bun.write(join(cwd, "partial.txt"), "retained");
          await Bun.write(env!.FACTORY_LOOP_CHECKPOINT_PATH!, "Resume by committing partial.txt");
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: '{"verdict":"interrupted"}' }],
              },
            }),
            stderr: "",
          };
        }
        if (role === "builder") {
          expect(await Bun.file(join(cwd, "partial.txt")).text()).toBe("retained");
          git(cwd, "add", "partial.txt");
          git(cwd, "commit", "-m", "finish retained work");
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            candidate: git(cwd, "rev-parse", "HEAD"),
            verdict: "pass",
            findings: [],
            checks: [],
          }),
          stderr: "",
        };
      },
    });
    expect(result.status).toBe("waiting_approval");
    expect(roles).toEqual(["builder", "builder", "qa", "reviewer"]);
    expect(result.evidence.filter((e) => e.role === "builder")).toHaveLength(2);
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

for (const interruptedRole of ["qa", "reviewer"]) {
  test(`${interruptedRole} timeout cannot promote a passing partial report`, async () => {
    const { root, bin } = await fixture();
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const roles: string[] = [];
      const result = await runLocalLoop(root, issue, {
        push: false,
        maxContinuations: 0,
        transport: async ({ cwd, role }) => {
          roles.push(role);
          const timedOut = role === interruptedRole;
          return {
            exitCode: timedOut ? 124 : 0,
            timedOut,
            stdout: JSON.stringify({
              candidate: git(cwd, "rev-parse", "HEAD"),
              verdict: "pass",
              findings: [],
              checks: [],
            }),
            stderr: "",
          };
        },
      });
      expect(result.status).toBe("interrupted");
      expect(result.error).toContain(interruptedRole);
      expect(roles).toEqual(
        interruptedRole === "qa" ? ["builder", "qa"] : ["builder", "qa", "reviewer"],
      );
      expect(await Bun.file(join(result.runDirectory, "artifacts/review.json")).exists()).toBe(
        false,
      );
    } finally {
      process.env.PATH = path;
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("host bookkeeping after an on-time transport return does not cause hard interruption", async () => {
  const { root, bin } = await fixture();
  const path = process.env.PATH;
  const realGit = Bun.spawnSync(["which", "git"]).stdout.toString().trim();
  const marker = join(root, "delay-next-head");
  await Bun.write(
    join(bin, "git"),
    `#!/bin/sh\nif [ "$1" = rev-parse ] && [ "$2" = HEAD ] && [ -f '${marker}' ]; then\n rm '${marker}'\n sleep 0.4\nfi\nexec '${realGit}' "$@"\n`,
  );
  await chmod(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  try {
    const result = await runLocalLoop(root, issue, {
      push: false,
      maxContinuations: 0,
      roleBudgets: { builder: { softMs: 150, hardMs: 300 } },
      transport: async ({ cwd, role }) => {
        const candidate = git(cwd, "rev-parse", "HEAD");
        if (role === "builder") await Bun.write(marker, "delay bookkeeping");
        return {
          exitCode: 0,
          stdout: JSON.stringify({ candidate, verdict: "pass", findings: [], checks: [] }),
          stderr: "",
        };
      },
    });
    expect(result.status).toBe("waiting_approval");
    const attempt = await Bun.file(join(result.runDirectory, "builder-attempt-0.json")).json();
    expect(attempt.finishedAt).toBeLessThan(attempt.hardDeadline);
  } finally {
    process.env.PATH = path;
    await rm(root, { recursive: true, force: true });
  }
});

for (const terminalPath of ["approved", "failed"] as const) {
  for (const exhaustion of ["hard", "soft", "resume"] as const) {
    test(`reflector ${exhaustion} budget enforcement on ${terminalPath} post-run path`, async () => {
      const { root, bin } = await fixture();
      const path = process.env.PATH;
      process.env.PATH = `${bin}:${path}`;
      const dossierPath = join(root, ".git/factory-local-loop/dossiers/issue-1.json");
      await mkdir(join(root, ".git/factory-local-loop/dossiers"), { recursive: true });
      await Bun.write(
        dossierPath,
        JSON.stringify({
          issueNumber: 1,
          issueTitle: issue.title,
          issueUrl: issue.url,
          branch: "prior",
          attempts: [
            {
              lapIndex: 0,
              runId: "prior",
              timestamp: new Date().toISOString(),
              status: "failed",
              changedFiles: [],
              reviewFindings: [],
              qaFailures: [],
            },
          ],
        }),
      );
      try {
        let attempts = 0;
        const result = await runLocalLoop(root, issue, {
          push: false,
          maxContinuations: exhaustion === "resume" ? 1 : 0,
          roleBudgets: { reflector: { softMs: 4000, hardMs: 5000 } },
          transport: async ({ role, cwd, env, argv, timeoutMs }) => {
            if (role !== "reflector")
              return {
                exitCode: terminalPath === "failed" ? 1 : 0,
                stdout: JSON.stringify({
                  candidate: git(cwd, "rev-parse", "HEAD"),
                  verdict: "pass",
                  findings: [],
                  checks: [],
                }),
                stderr: "",
              };
            attempts++;
            expect(timeoutMs).toBeGreaterThan(4500);
            expect(timeoutMs).toBeLessThanOrEqual(5000);
            expect(
              Number(env!.FACTORY_LOOP_HARD_DEADLINE_MS) -
                Number(env!.FACTORY_LOOP_SOFT_DEADLINE_MS),
            ).toBe(1000);
            expect(argv.at(-1)).toContain(env!.FACTORY_LOOP_CHECKPOINT_PATH!);
            if (attempts === 2) {
              expect(argv.at(-1)).toContain("Continuation 1");
              expect(await Bun.file(env!.FACTORY_LOOP_CHECKPOINT_PATH!).text()).toContain(
                "reflector-partial.txt",
              );
              return {
                exitCode: 0,
                stdout: JSON.stringify({ attribution: "no_observed_effect" }),
                stderr: "",
              };
            }
            await Bun.write(join(cwd, "reflector-partial.txt"), "retain reflection evidence");
            return {
              exitCode: exhaustion === "hard" ? 124 : 0,
              timedOut: exhaustion === "hard",
              stdout: JSON.stringify({ content: '{"verdict":"interrupted"}' }),
              stderr: "",
            };
          },
        });
        expect({ attempts, status: result.status, error: result.error }).toMatchObject({
          attempts: exhaustion === "resume" ? 2 : 1,
        });
        expect(result.status).toBe(
          exhaustion === "resume"
            ? terminalPath === "approved"
              ? "waiting_approval"
              : "failed"
            : "interrupted",
        );
        expect(result.evidence.filter((e) => e.role === "reflector")).toHaveLength(attempts);
        const checkpoint = await Bun.file(
          join(result.runDirectory, "artifacts/handoff/reflector-checkpoint.md"),
        ).text();
        expect(checkpoint).toContain("reflector-partial.txt");
        const dossier = await Bun.file(dossierPath).json();
        if (exhaustion === "resume") expect(dossier.reflectedAt).toBeString();
        else {
          expect(dossier.reflectedAt).toBeUndefined();
          expect(
            await Bun.file(join(result.runDirectory, "artifacts/reflection.json")).exists(),
          ).toBe(false);
        }
      } finally {
        process.env.PATH = path;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test("normal parent exit also reaps owned background descendants", async () => {
  const result = await processRun(
    [
      "node",
      "-e",
      `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
    console.log(child.pid);
    child.unref();
  `,
    ],
    process.cwd(),
    3000,
  );
  expect(result.exitCode).toBe(0);
  const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", result.stdout.trim()])
    .stdout.toString()
    .trim();
  expect(state === "" || state.startsWith("Z")).toBe(true);
});
