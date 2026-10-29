import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  applyControlAction,
  launchNativeLap,
  readControlState,
  resolveSharedRoot,
} from "../../apps/engine-host/src/native";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Creates an isolated primary checkout; never touches the real operator repository. */
function createPrimaryCheckout(root: string): string {
  const primary = join(root, "primary");
  mkdirSync(primary, { recursive: true });
  git(["init", "-b", "main"], primary);
  git(["config", "user.name", "Test Runner"], primary);
  git(["config", "user.email", "test@example.com"], primary);
  git(["config", "commit.gpgsign", "false"], primary);
  writeFileSync(join(primary, "README.md"), "# linked worktree control test\n");
  git(["add", "README.md"], primary);
  git(["commit", "-m", "initial commit"], primary);
  return primary;
}

/** Creates a linked worktree of the primary checkout via real Git plumbing. */
function createLinkedWorktree(primary: string, root: string): string {
  const linked = join(root, "linked");
  git(["worktree", "add", "-b", "feature/linked", linked, "HEAD"], primary);
  return linked;
}

/** Canonicalizes a path so symlinked temp roots compare equal. */
function canonical(path: string): string {
  return realpathSync(path);
}

function withWorktreeFixture(run: (primary: string, linked: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "control-worktree-test-"));
  try {
    const primary = createPrimaryCheckout(root);
    const linked = createLinkedWorktree(primary, root);
    run(primary, linked);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Shared operator brakes across linked Git worktrees (Issue #72)", () => {
  test("AC1: primary checkout and linked worktree resolve to the same shared factory root", () => {
    withWorktreeFixture((primary, linked) => {
      const commonFromLinked = git(["rev-parse", "--git-common-dir"], linked);
      const commonFromPrimary = git(["rev-parse", "--git-common-dir"], primary);

      // Git reports an absolute common directory for a linked worktree and a relative one
      // for the primary checkout; both must resolve to the same primary repository root.
      const expectedFromLinked = dirname(resolve(linked, commonFromLinked));
      const expectedFromPrimary = dirname(resolve(primary, commonFromPrimary));

      expect(canonical(resolveSharedRoot(linked))).toBe(canonical(expectedFromLinked));
      expect(canonical(resolveSharedRoot(linked))).toBe(canonical(expectedFromPrimary));
      expect(canonical(resolveSharedRoot(linked))).toBe(canonical(primary));
      expect(canonical(resolveSharedRoot(primary))).toBe(canonical(primary));
    });
  });

  test("invariant: a non-Git directory keeps its own path as the shared root", () => {
    const plain = mkdtempSync(join(tmpdir(), "control-plain-test-"));
    try {
      expect(resolveSharedRoot(plain)).toBe(plain);
      const state = readControlState(plain);
      expect(state.halted).toBe(false);
      expect(state.paused).toBe(false);
      expect(state.active_brake).toBe("none");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("AC2: a shared brake set from either checkout is observed from the other", () => {
    withWorktreeFixture((primary, linked) => {
      const initial = readControlState(linked);
      expect(initial.halted).toBe(false);
      expect(initial.paused).toBe(false);
      expect(initial.active_brake).toBe("none");

      // STOP set from the primary checkout is visible from the linked worktree.
      const halted = applyControlAction(primary, "halt");
      expect(halted.halted).toBe(true);
      expect(halted.paused).toBe(false);
      expect(halted.active_brake).toBe("stop");

      const haltedFromLinked = readControlState(linked);
      expect(haltedFromLinked.halted).toBe(true);
      expect(haltedFromLinked.paused).toBe(false);
      expect(haltedFromLinked.active_brake).toBe("stop");

      // PAUSE set from the linked worktree is visible from the primary checkout.
      const paused = applyControlAction(linked, "pause");
      expect(paused.halted).toBe(true);
      expect(paused.paused).toBe(true);
      expect(paused.active_brake).toBe("both");

      const pausedFromPrimary = readControlState(primary);
      expect(pausedFromPrimary.halted).toBe(true);
      expect(pausedFromPrimary.paused).toBe(true);
      expect(pausedFromPrimary.active_brake).toBe("both");
    });
  });

  test("AC3: a launch from the linked worktree refuses while a shared brake exists", () => {
    withWorktreeFixture((primary, linked) => {
      applyControlAction(primary, "halt");
      expect(() => launchNativeLap(linked, "specification")).toThrow("launch_brake_set");

      applyControlAction(primary, "unhalt");
      applyControlAction(linked, "pause");
      expect(() => launchNativeLap(linked, "specification")).toThrow("launch_brake_set");

      // With the brakes cleared the launch proceeds past the brake check, which proves the
      // refusal above happened before any Archon invocation was attempted.
      applyControlAction(linked, "unpause");
      expect(() => launchNativeLap(linked, "specification")).toThrow("native_source_unavailable");
    });
  });

  test("AC4: unhalt and unpause clear only their own brake and stay idempotent", () => {
    withWorktreeFixture((primary, linked) => {
      applyControlAction(primary, "halt");
      applyControlAction(primary, "pause");

      const afterUnhalt = applyControlAction(linked, "unhalt");
      expect(afterUnhalt.halted).toBe(false);
      expect(afterUnhalt.paused).toBe(true);
      expect(afterUnhalt.active_brake).toBe("pause");

      const afterUnhaltAgain = applyControlAction(linked, "unhalt");
      expect(afterUnhaltAgain.halted).toBe(false);
      expect(afterUnhaltAgain.paused).toBe(true);
      expect(afterUnhaltAgain.active_brake).toBe("pause");

      const afterUnpause = applyControlAction(linked, "unpause");
      expect(afterUnpause.halted).toBe(false);
      expect(afterUnpause.paused).toBe(false);
      expect(afterUnpause.active_brake).toBe("none");

      const afterUnpauseAgain = applyControlAction(linked, "unpause");
      expect(afterUnpauseAgain.active_brake).toBe("none");

      // A checkout-local brake in the linked worktree is still honored and clearable.
      mkdirSync(join(linked, ".factory"), { recursive: true });
      writeFileSync(join(linked, ".factory/STOP"), "local halt\n");
      const localState = readControlState(linked);
      expect(localState.halted).toBe(true);
      expect(localState.active_brake).toBe("stop");
      expect(() => launchNativeLap(linked, "specification")).toThrow("launch_brake_set");

      const clearedLocal = applyControlAction(linked, "unhalt");
      expect(clearedLocal.halted).toBe(false);
      expect(clearedLocal.active_brake).toBe("none");
    });
  });
});
