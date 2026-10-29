import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyControlAction, launchNativeLap } from "../../apps/engine-host/src/native";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Stages a fake pinned Archon CLI.
 *
 * The fake `bun` binary records that it was invoked instead of starting a workflow, so a
 * launch that reaches Archon leaves a marker file behind. No live workflow is ever launched.
 */
function stageFakeArchon(root: string): { bunBin: string; marker: string; home: string } {
  const home = join(root, "home");
  const revision = "rev-under-test";
  const cliDir = join(home, ".cache/factory/archon", revision, "packages/cli/src");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, "cli.ts"), "// fake pinned archon cli\n");

  const marker = join(root, "archon-invoked.json");
  const bunBin = join(root, "fake-bun");
  writeFileSync(
    bunBin,
    [
      "#!/bin/sh",
      `printf '{"cwd":"%s","argv":"%s"}' "$PWD" "$*" > "${marker}"`,
      `printf '{"ok":true,"runId":"fake-run-1","status":"pending"}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bunBin, 0o755);
  return { bunBin, marker, home };
}

test("AC3: a shared brake refuses the launch before Archon is invoked", () => {
  const root = mkdtempSync(join(tmpdir(), "control-brake-launch-test-"));
  const previousHome = process.env.HOME;
  try {
    const primary = join(root, "primary");
    mkdirSync(primary, { recursive: true });
    git(["init", "-b", "main"], primary);
    git(["config", "user.name", "Test Runner"], primary);
    git(["config", "user.email", "test@example.com"], primary);
    git(["config", "commit.gpgsign", "false"], primary);
    writeFileSync(join(primary, "README.md"), "# linked worktree launch brake test\n");
    git(["add", "README.md"], primary);
    git(["commit", "-m", "initial commit"], primary);

    const linked = join(root, "linked");
    git(["worktree", "add", "-b", "feature/linked", linked, "HEAD"], primary);

    const { bunBin, marker, home } = stageFakeArchon(root);
    mkdirSync(join(linked, ".factory"), { recursive: true });
    writeFileSync(join(linked, ".factory/settings.json"), JSON.stringify({ bun: bunBin }));
    mkdirSync(join(linked, "factory"), { recursive: true });
    writeFileSync(
      join(linked, "factory/pack.json"),
      JSON.stringify({
        integration_revision_required: "rev-under-test",
        entries: {},
        default_inputs: {},
      }),
    );
    process.env.HOME = home;

    // A shared STOP set from the primary checkout refuses the launch from the linked
    // worktree, and Archon is never invoked.
    applyControlAction(primary, "halt");
    expect(() => launchNativeLap(linked, "specification")).toThrow("launch_brake_set");
    expect(existsSync(marker)).toBe(false);

    // The same holds for a shared PAUSE.
    applyControlAction(primary, "unhalt");
    applyControlAction(linked, "pause");
    expect(() => launchNativeLap(linked, "specification")).toThrow("launch_brake_set");
    expect(existsSync(marker)).toBe(false);

    // With the brakes cleared the launch reaches the pinned Archon CLI, which proves the
    // brake check above is what refused the launch.
    applyControlAction(linked, "unpause");
    const ack = launchNativeLap(linked, "specification");
    expect(ack.id).toBe("fake-run-1");
    expect(existsSync(marker)).toBe(true);

    const invocation = JSON.parse(readFileSync(marker, "utf-8")) as { cwd: string; argv: string };
    expect(realpathSync(invocation.cwd)).toBe(realpathSync(linked));
    expect(invocation.argv).toContain("workflow run");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
