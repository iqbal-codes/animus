import { expect, test } from "bun:test";
import { interruptionReport, resolveRoleBudgets } from "../../scripts/loop/deadlines";
import { processRun } from "../../scripts/loop/process";
import { spawn } from "node:child_process";
import { join } from "node:path";

test("role budgets default independently and reject invalid or inverted deadlines", () => {
  const budgets = resolveRoleBudgets({});
  expect(budgets.builder).toEqual({ softMs: 1_200_000, hardMs: 1_500_000 });
  expect(budgets.qa).toEqual({ softMs: 900_000, hardMs: 1_200_000 });
  expect(budgets.reviewer).toEqual({ softMs: 900_000, hardMs: 1_200_000 });
  expect(budgets.triage).toEqual({ softMs: 120_000, hardMs: 180_000 });
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
  expect(
    resolveRoleBudgets(
      {},
      { FACTORY_LOOP_TRIAGE_SOFT_MS: "60000", FACTORY_LOOP_TRIAGE_HARD_MS: "90000" },
    ).triage,
  ).toEqual({ softMs: 60000, hardMs: 90000 });
  expect(() => resolveRoleBudgets({}, { FACTORY_LOOP_QA_HARD_MS: "no" })).toThrow();
  expect(
    resolveRoleBudgets(
      { roleBudgets: { qa: { softMs: 10, hardMs: 20 } } },
      { FACTORY_LOOP_QA_HARD_MS: "no" },
    ).qa,
  ).toEqual({ softMs: 10, hardMs: 20 });
  expect(
    resolveRoleBudgets(
      { roleBudgets: { triage: { softMs: 40000, hardMs: 50000 } } },
      { FACTORY_LOOP_TRIAGE_HARD_MS: "no" },
    ).triage,
  ).toEqual({ softMs: 40000, hardMs: 50000 });
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

test("processRun defaults PI_CACHE_RETENTION to long when unset, preserving explicit overrides", async () => {
  const defaultRes = await processRun(
    ["node", "-e", "process.stdout.write(process.env.PI_CACHE_RETENTION || '')"],
    process.cwd(),
    5000,
  );
  expect(defaultRes.exitCode).toBe(0);
  expect(defaultRes.stdout).toBe("long");

  const overrideRes = await processRun(
    ["node", "-e", "process.stdout.write(process.env.PI_CACHE_RETENTION || '')"],
    process.cwd(),
    5000,
    { PI_CACHE_RETENTION: "short" },
  );
  expect(overrideRes.exitCode).toBe(0);
  expect(overrideRes.stdout).toBe("short");
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
