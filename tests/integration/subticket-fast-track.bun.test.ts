import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAnimusLoop } from "../../scripts/loop/session";
import { git } from "../../scripts/loop/worktree";
import type { LocalIssue } from "../../scripts/loop/types";

async function createRepoFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "animus-subticket-test-"));
  await git(dir, "init");
  await git(dir, "config", "user.name", "Test");
  await git(dir, "config", "user.email", "test@test.local");
  await git(dir, "config", "commit.gpgsign", "false");

  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "harness"), { recursive: true });
  await writeFile(
    join(dir, "harness/harness.config.json"),
    JSON.stringify({
      static: "echo static-ok",
      unit: "echo unit-ok",
      protected_paths: "harness/**,.animus/holdout/**",
    }),
  );

  await mkdir(join(dir, ".animus"), { recursive: true });
  await writeFile(join(dir, ".animus/config.yaml"), `roles:\n  builder:\n    model: "small"\n`);

  await writeFile(join(dir, "README.md"), "# Test\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-m", "initial");
  await git(dir, "branch", "-M", "main");
  return dir;
}

describe("Subticket Fast-Track Pipeline", () => {
  test("Subticket targeting integration branch bypasses micro-review and merges on green CI", async () => {
    const root = await createRepoFixture();
    try {
      // Create spec integration branch
      await git(root, "branch", "factory/spec-100-integration", "main");

      let reviewerInvoked = false;
      let qaInvoked = false;

      const issue: LocalIssue = {
        number: 101,
        title: "Subticket 101 for Spec 100",
        body: "Part of #100\nImplements feature slice.",
        url: "https://github.com/example/repo/issues/101",
        comments: [],
        dependencies: [],
        activeClaim: false,
        labels: ["ready-for-agent"],
      };

      const result = await runAnimusLoop(root, issue, {
        push: false,
        transport: async ({ cwd, role }) => {
          if (role === "reviewer") {
            reviewerInvoked = true;
          }
          if (role === "qa") {
            qaInvoked = true;
          }
          if (role === "builder") {
            await writeFile(join(cwd, "feature-slice.txt"), "subticket 101 work\n");
            await git(cwd, "add", "feature-slice.txt");
            await git(cwd, "commit", "-m", "feat: slice 101");
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

      // Verification:
      // 1. Neither QA nor Reviewer role should be invoked for intermediate subticket!
      expect(qaInvoked).toBe(false);
      expect(reviewerInvoked).toBe(false);

      // 2. The subticket should be merged directly into the integration branch!
      expect(result.status).toBe("merged");
      expect(result.autoMerge?.authorized).toBe(true);

      // 3. The integration branch ref should now contain the candidate commit!
      const integrationHead = (await git(root, "rev-parse", "factory/spec-100-integration")).trim();
      expect(integrationHead).toBe(result.candidate!);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
