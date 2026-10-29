import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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
  commitAll(primary, "# linked worktree control test");
  return primary;
}

/** Creates a linked worktree of the primary checkout via real Git plumbing. */
function createLinkedWorktree(primary: string, root: string): string {
  const linked = join(root, "linked");
  git(["worktree", "add", "-b", "feature/linked", linked, "HEAD"], primary);
  return linked;
}

/** Writes one file and commits it in an isolated repository. */
function commitAll(dir: string, contents: string): void {
  git(["config", "user.name", "Test Runner"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, "README.md"), `${contents}\n`);
  git(["add", "README.md"], dir);
  git(["commit", "-m", "initial commit"], dir);
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

/**
 * Creates a checkout whose Git directory lives outside the checkout.
 *
 * Git records no worktree for such a repository, so the shared root cannot be the checkout
 * itself; both the checkout and its linked worktree must still name one shared location.
 */
function withSeparateGitDirFixture(
  run: (work: string, linked: string, root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "control-separate-git-dir-test-"));
  try {
    const work = join(root, "work");
    const gitDir = join(root, "gitdir");
    mkdirSync(work, { recursive: true });
    git(["init", "-b", "main", `--separate-git-dir=${gitDir}`], work);
    commitAll(work, "# separate git dir control test");
    const linked = join(root, "linked");
    git(["worktree", "add", "-b", "feature/linked", linked, "HEAD"], work);
    run(work, linked, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Creates a bare repository with two worktrees; never touches the real operator repository. */
function withBareRepositoryFixture(
  run: (first: string, second: string, root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "control-bare-test-"));
  try {
    const bare = join(root, "bare.git");
    mkdirSync(bare, { recursive: true });
    git(["init", "-b", "main", "--bare"], bare);
    const first = join(root, "first");
    const second = join(root, "second");
    git(["--git-dir", bare, "worktree", "add", "-b", "feature/first", first], root);
    git(["--git-dir", bare, "worktree", "add", "-b", "feature/second", second], root);
    run(first, second, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Creates a superproject with a submodule checkout; never touches real repositories. */
function withSubmoduleFixture(
  run: (submodule: string, submoduleLinked: string, superproject: string, root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "control-submodule-test-"));
  try {
    const superproject = join(root, "superproject");
    mkdirSync(superproject, { recursive: true });
    git(["init", "-b", "main"], superproject);
    commitAll(superproject, "# superproject");

    const child = join(root, "child");
    mkdirSync(child, { recursive: true });
    git(["init", "-b", "main"], child);
    commitAll(child, "# child");

    git(
      ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "child"],
      superproject,
    );
    const submodule = join(superproject, "child");

    const submoduleLinked = join(root, "submodule-linked");
    git(["-C", submodule, "worktree", "add", "-b", "feature/linked", submoduleLinked], root);
    run(submodule, submoduleLinked, superproject, root);
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

  test("invariant: the shared root is a checkout root and never a path inside a Git directory", () => {
    withWorktreeFixture((primary, linked) => {
      for (const root of [primary, linked]) {
        const shared = resolveSharedRoot(root);
        expect(canonical(shared)).toBe(canonical(primary));
        expect(shared.split(sep)).not.toContain(".git");
      }
    });
  });

  test("AC1: a checkout whose Git directory lives elsewhere shares one brake root with its linked worktree", () => {
    withSeparateGitDirFixture((work, linked, root) => {
      const sharedFromWork = resolveSharedRoot(work);
      const sharedFromLinked = resolveSharedRoot(linked);

      // The checkout and its linked worktree must name one shared brake location.
      expect(canonical(sharedFromWork)).toBe(canonical(sharedFromLinked));

      // The shared root must never be inside the Git directory, and must not be nested
      // beneath the checkout the way an absolute common directory used to be.
      expect(sharedFromWork).not.toContain(`${sep}gitdir${sep}`);
      expect(sharedFromWork.startsWith(work + sep)).toBe(false);
      expect(sharedFromWork.split(sep)).not.toContain(".git");
      expect(canonical(sharedFromWork)).not.toBe(canonical(join(root, "gitdir")));
    });
  });

  test("AC2: a brake set from either checkout of a separate Git directory is observed from the other", () => {
    withSeparateGitDirFixture((work, linked) => {
      const halted = applyControlAction(work, "halt");
      expect(halted.halted).toBe(true);
      expect(halted.active_brake).toBe("stop");

      const fromLinked = readControlState(linked);
      expect(fromLinked.halted).toBe(true);
      expect(fromLinked.paused).toBe(false);
      expect(fromLinked.active_brake).toBe("stop");

      applyControlAction(linked, "pause");
      const paused = readControlState(work);
      expect(paused.halted).toBe(true);
      expect(paused.paused).toBe(true);
      expect(paused.active_brake).toBe("both");
    });
  });

  test("AC1: the worktrees of a bare repository share one brake root", () => {
    withBareRepositoryFixture((first, second) => {
      const sharedFromFirst = resolveSharedRoot(first);
      const sharedFromSecond = resolveSharedRoot(second);

      expect(canonical(sharedFromFirst)).toBe(canonical(sharedFromSecond));
      expect(sharedFromFirst.split(sep)).not.toContain(".git");

      applyControlAction(first, "halt");
      const fromSecond = readControlState(second);
      expect(fromSecond.halted).toBe(true);
      expect(fromSecond.active_brake).toBe("stop");
    });
  });

  test("AC1: a submodule checkout resolves to its own checkout root, never inside a Git directory", () => {
    withSubmoduleFixture((submodule) => {
      const shared = resolveSharedRoot(submodule);
      expect(canonical(shared)).toBe(canonical(submodule));
      expect(shared).not.toContain(`${sep}modules${sep}`);
    });
  });

  test("AC1: a submodule checkout and its linked worktree share one brake root", () => {
    withSubmoduleFixture((submodule, submoduleLinked) => {
      const sharedFromSubmodule = resolveSharedRoot(submodule);
      const sharedFromLinked = resolveSharedRoot(submoduleLinked);

      expect(canonical(sharedFromSubmodule)).toBe(canonical(sharedFromLinked));
      expect(canonical(sharedFromSubmodule)).toBe(canonical(submodule));

      applyControlAction(submodule, "pause");
      const fromLinked = readControlState(submoduleLinked);
      expect(fromLinked.paused).toBe(true);
      expect(fromLinked.halted).toBe(false);
      expect(fromLinked.active_brake).toBe("pause");
    });
  });

  test("invariant: a user-level core.worktree cannot redirect the shared brake root", () => {
    withSeparateGitDirFixture((work, linked, root) => {
      // A user-level "core.worktree" must never move the brake location of a repository.
      const globalConfig = join(root, "global-gitconfig");
      writeFileSync(globalConfig, `[core]\n\tworktree = ${join(root, "leaked")}\n`);
      const previous = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = globalConfig;
      try {
        const shared = resolveSharedRoot(work);
        expect(shared).not.toContain("leaked");
        expect(canonical(resolveSharedRoot(linked))).toBe(canonical(shared));
      } finally {
        if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = previous;
      }
    });
  });

  test("AC1: a linked worktree inside the primary checkout's Git directory resolves to the primary checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "control-nested-worktree-test-"));
    try {
      // The factory keeps its own linked worktrees inside the primary checkout's Git
      // directory, so the shared root must still be the primary checkout.
      const primary = createPrimaryCheckout(root);
      const linked = join(primary, ".git", "factory-local-loop", "worktrees", "linked");
      mkdirSync(join(primary, ".git", "factory-local-loop", "worktrees"), { recursive: true });
      git(["worktree", "add", "-b", "feature/linked", linked, "HEAD"], primary);

      expect(canonical(resolveSharedRoot(linked))).toBe(canonical(primary));
      expect(canonical(resolveSharedRoot(primary))).toBe(canonical(primary));

      applyControlAction(primary, "halt");
      expect(readControlState(linked).halted).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
