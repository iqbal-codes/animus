import { afterEach, expect, test, vi } from "vitest";
import registerLoopGuard from "../../.factory/hooks/loop-guard";

function guard() {
  const handlers = new Map<string, (event: any) => Promise<any>>();
  registerLoopGuard({
    on: (name: string, handler: (event: any) => Promise<any>) => handlers.set(name, handler),
  });
  return handlers.get("tool_call")!;
}
afterEach(() => vi.unstubAllEnvs());

test("bash keeps legitimate explicit budgets and clamps to remaining hard deadline", async () => {
  vi.stubEnv("FACTORY_LOOP_HARD_DEADLINE_MS", String(Date.now() + 600_000));
  const call = guard();
  const input = { command: "bun run verify", timeout: 300 };
  await call({ toolName: "bash", input });
  expect(input.timeout).toBe(300);
  const missing: Record<string, unknown> = { command: "echo ok" };
  await call({ toolName: "bash", input: missing });
  expect(missing.timeout).toBe(90);
  vi.stubEnv("FACTORY_LOOP_HARD_DEADLINE_MS", String(Date.now() + 2_000));
  await call({ toolName: "bash", input });
  expect(input.timeout).toBeGreaterThan(0);
  expect(input.timeout).toBeLessThanOrEqual(2);
});

test("soft deadline permits checkpoint only, rejects shell compound commands and new code", async () => {
  vi.stubEnv("FACTORY_LOOP_SOFT_DEADLINE_MS", String(Date.now() - 100));
  vi.stubEnv("FACTORY_LOOP_CHECKPOINT_PATH", "/tmp/run/artifacts/handoff/checkpoint.md");
  const call = guard();
  expect((await call({ toolName: "bash", input: { command: "bun test" } }))?.block).toBe(true);
  expect(
    (await call({ toolName: "bash", input: { command: "git status; bun test" } }))?.block,
  ).toBe(true);
  expect(
    (await call({ toolName: "write", input: { path: "src/new.ts", content: "code" } }))?.block,
  ).toBe(true);
  expect(
    await call({
      toolName: "write",
      input: { path: "/tmp/run/artifacts/handoff/checkpoint.md", content: "remaining work" },
    }),
  ).toBeUndefined();
  expect(
    await call({ toolName: "bash", input: { command: "git status --short" } }),
  ).toBeUndefined();
});

test("hard deadline refuses tools, including checkpoint commands", async () => {
  vi.stubEnv("FACTORY_LOOP_HARD_DEADLINE_MS", String(Date.now() - 100));
  expect((await guard()({ toolName: "bash", input: { command: "git status" } }))?.block).toBe(true);
});
