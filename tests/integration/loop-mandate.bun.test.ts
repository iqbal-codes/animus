import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadPrompt, renderPrompt } from "../../scripts/loop/prompts";

test("unattended builder keeps local authority without inventing product or harness standards", () => {
  const prompt = renderPrompt(
    loadPrompt("loop-work", resolve(import.meta.dir, "../..")),
    {
      target: "offline://issue/1",
      protected_paths: "harness/**",
      route: "simple",
      pr: "",
      reason: "mandate verification",
      runtime: "bun start",
    },
    "/tmp/mandate-artifacts",
  );
  expect(prompt).toContain("Resolve local implementation details using existing architecture");
  expect(prompt).toContain("Escalate contradictory requirements");
  expect(prompt).toContain("data ownership, module boundaries");
  expect(prompt).toContain("separate reviewed delivery rather than automatic registration");
  expect(prompt).not.toContain("Never wait for a human");
  expect(prompt).not.toContain("register them in `.factory/codebase-rules.json`");
});

test("black-box verification derives expectations from contract rather than builder narrative", () => {
  const prompt = loadPrompt("loop-check-app", resolve(import.meta.dir, "../.."));
  expect(prompt).toContain("without reading its diff");
  expect(prompt).toContain("Read the work item and its `Contract` comment");
  expect(prompt).toContain("Candidate head commit: $INPUTS.head");
  expect(prompt).toContain("identical commit");
});
