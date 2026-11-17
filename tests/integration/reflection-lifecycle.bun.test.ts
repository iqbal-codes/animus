import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLapAttempt, shouldTriggerReflection } from "../../scripts/loop/dossier";

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

test("historic failures never turn a nonterminal lap into terminal reflection", () => {
  expect(shouldTriggerReflection(dossier(["failed", "sent_back", "failed"]))).toBe(false);
  expect(shouldTriggerReflection(dossier(["sent_back", "sent_back"]))).toBe(false);
  expect(shouldTriggerReflection(dossier(["failed", "waiting_approval"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["failed", "merged"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["needs_owner"]))).toBe(true);
  expect(shouldTriggerReflection(dossier(["waiting_approval"]))).toBe(false);
});
