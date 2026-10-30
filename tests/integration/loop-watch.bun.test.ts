import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlCursor,
  formatSessionEvent,
  summarize,
  terminalSummary,
  watchRun,
  resolveRunLap,
} from "../../scripts/loop-watch";

test("prints concise responses, actual commands and result summaries without prompts or thinking", () => {
  expect(
    formatSessionEvent({ type: "message", message: { role: "user", content: "secret prompt" } }),
  ).toEqual([]);
  expect(
    formatSessionEvent({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "Running regression tests" },
          { type: "toolCall", name: "bash", arguments: { command: "secret" } },
        ],
      },
    }),
  ).toEqual(["PI Running regression tests", "ACTION bash → secret"]);
  expect(
    formatSessionEvent({
      type: "message",
      message: { role: "toolResult", toolName: "bash", isError: true, content: "secret output" },
    }),
  ).toEqual(["ERROR bash → secret output"]);
});

test("summarizes file edits, test failures and multiline responses while redacting common credentials", () => {
  expect(
    formatSessionEvent({
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "edit",
            arguments: {
              path: "src/control.ts",
              edits: [{ oldText: "private", newText: "private" }],
            },
          },
        ],
      },
    }),
  ).toEqual(["ACTION edit → src/control.ts (1 replacement)"]);
  expect(
    formatSessionEvent({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        durationMs: 18,
        isError: true,
        content: [{ type: "text", text: "noise\nFAIL controls\n2 tests failed\n" }],
      },
    }),
  ).toEqual(["ERROR bash (18ms) → FAIL controls | 2 tests failed"]);
  expect(summarize("first\nsecond\tthird")).toBe("first second third");
  expect(summarize("API_KEY=supersecret Bearer abc ghp_abcdef")).toBe(
    "API_KEY=[REDACTED] Bearer [REDACTED] [REDACTED]",
  );
  expect(summarize("abcdefghijk", 8)).toBe("abcdefg…");
});

test("terminal failures explain the end instead of implying a successful QA exit", () => {
  const lines = terminalSummary({
    status: "failed",
    error: "Malformed QA report",
    worktree: "/work",
    runDirectory: "/evidence",
    evidence: [{ role: "qa", round: 0, exitCode: 0 }],
  }).join("\n");
  expect(lines).toContain("RUN ENDED: FAILED");
  expect(lines).toContain("Reason: Malformed QA report");
  expect(lines).toContain("not a verification verdict");
  expect(terminalSummary({ status: "building" })).toEqual([]);
  const interrupted = terminalSummary({
    status: "interrupted",
    error: "continuation budget exhausted",
    worktree: "/work",
    runDirectory: "/evidence",
  }).join("\n");
  expect(interrupted).toContain("RUN ENDED: INTERRUPTED");
  expect(interrupted).toContain("Worktree preserved: /work");
});

test("default watcher skips old messages and explains an already-ended run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-watch-ended-"));
  const { mkdir } = await import("node:fs/promises");
  const lines: string[] = [];
  const original = console.log;
  try {
    await mkdir(join(directory, "0-qa-session"));
    await Bun.write(
      join(directory, "state.json"),
      JSON.stringify({
        status: "failed",
        error: "invalid report",
        runDirectory: directory,
        worktree: "/work",
        issue: "issue/72",
      }),
    );
    await Bun.write(
      join(directory, "0-qa-session", "test.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "OLD MESSAGE" }] },
      }) + "\n",
    );
    console.log = (...args) => {
      lines.push(args.join(" "));
    };
    await watchRun(directory);
    expect(lines.join("\n")).not.toContain("OLD MESSAGE");
    expect(lines.join("\n")).toContain("RUN ENDED: FAILED");
    lines.length = 0;
    await watchRun(directory, false, undefined, true);
    expect(lines.join("\n")).toContain("OLD MESSAGE");
  } finally {
    console.log = original;
    await rm(directory, { recursive: true, force: true });
  }
});

test("follows appended JSONL without duplicate events or dropping partial UTF-8 lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loop-watch-"));
  try {
    const path = join(directory, "session.jsonl");
    const cursor = new JsonlCursor();
    await Bun.write(path, '{"text":"first"}\n{"text":"');
    expect(await cursor.read(path)).toEqual([{ text: "first" }]);
    expect(await cursor.read(path)).toEqual([]);
    const bytes = Buffer.from('✓"}\n');
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, bytes.subarray(0, 1));
    expect(await cursor.read(path)).toEqual([]);
    await appendFile(path, bytes.subarray(1));
    expect(await cursor.read(path)).toEqual([{ text: "✓" }]);
    await Bun.write(path, "{}\n");
    expect(await cursor.read(path)).toEqual([{}]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("resolves lap number and shows lap count in terminal summary", async () => {
  const summaryWithLap = terminalSummary({
    status: "failed",
    lap: 3,
    error: "Test failure",
    worktree: "/work",
    runDirectory: "/evidence",
  }).join("\n");
  expect(summaryWithLap).toContain("RUN ENDED: FAILED (Lap 3)");
  expect(summaryWithLap).toContain("Lap: 3");

  // Directly from state
  expect(await resolveRunLap("/fake/dir", { lap: 4 })).toBe(4);

  // From dossier fallback
  const tmp = await mkdtemp(join(tmpdir(), "loop-watch-dossier-"));
  try {
    const runsDir = join(tmp, "factory-local-loop", "runs", "test-run");
    const dossiersDir = join(tmp, "factory-local-loop", "dossiers");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(runsDir, { recursive: true });
    await mkdir(dossiersDir, { recursive: true });
    await Bun.write(
      join(dossiersDir, "issue-42.json"),
      JSON.stringify({
        attempts: [
          { runId: "other-run", lapIndex: 0 },
          { runId: "test-run", lapIndex: 1 },
        ],
      }),
    );
    const resolved = await resolveRunLap(runsDir, {
      runId: "test-run",
      issue: "https://github.com/org/repo/issues/42",
    });
    expect(resolved).toBe(2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
