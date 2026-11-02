import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { resolveAnimusStateDir } from "../../packages/contracts/src/paths";

/**
 * Resolves the canonical absolute path of the Git common directory for a repository or worktree.
 * For primary checkouts, this is <repo>/.git.
 * For linked worktrees, git rev-parse --git-common-dir points to the primary checkout's .git directory.
 * Across all linked worktrees of the same repository, this returns the exact same canonical path.
 */
export function resolveCanonicalGitCommon(root: string): string {
  try {
    const gitRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
      cwd: root,
      stderr: "pipe",
    });
    if (gitRes.exitCode === 0) {
      const raw = gitRes.stdout.toString().trim();
      const resolved = resolve(root, raw);
      try {
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    }
  } catch {}

  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function canonicalizePath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    // Resolve symlinks (e.g. macOS /var -> /private/var) via closest existing ancestor
    let curr = resolve(targetPath);
    const parts: string[] = [];
    while (!existsSync(curr) && curr !== "/" && curr !== ".") {
      parts.unshift(basename(curr));
      curr = dirname(curr);
    }
    try {
      const canonicalParent = realpathSync(curr);
      return join(canonicalParent, ...parts);
    } catch {
      return resolve(targetPath);
    }
  }
}

/**
 * Checks whether stateRoot is strictly outside the checkout root.
 * Validates realpath containment just like validateTriagePassInputs.
 */
export function isStateRootOutsideCheckout(root: string, stateRoot: string): boolean {
  const canonicalRoot = canonicalizePath(root);
  const canonicalStateRoot = canonicalizePath(stateRoot);

  const rootPrefix = canonicalRoot.endsWith("/") ? canonicalRoot : canonicalRoot + "/";
  return canonicalStateRoot !== canonicalRoot && !canonicalStateRoot.startsWith(rootPrefix);
}

/**
 * Computes a stable identifier hash for the canonical Git common directory.
 */
export function computeGitCommonHash(canonicalCommon: string): string {
  return createHash("sha256").update(canonicalCommon).digest("hex");
}

/**
 * Resolves a canonical per-repo TRIAGE STATE ONLY directory outside the checkout.
 *
 * Rules:
 * 1. Explicit caller stateRoot outside checkout root is accepted and returned directly.
 * 2. If caller stateRoot is inside checkout root (e.g. builder stateRoot in .git/factory-local-loop),
 *    or omitted, derives a separate triageRoot in the external OS state directory.
 * 3. The derived triageRoot is keyed by the SHA-256 hash of the canonical Git common directory,
 *    ensuring all linked worktrees and entrypoints (scheduler, monitor, CLI) share the exact
 *    same lock root and staging state for the repository.
 */
export function resolveTriageStateRoot(
  root: string,
  callerStateRoot?: string,
  customExternalStateDir?: string,
): string {
  if (callerStateRoot && callerStateRoot.trim() !== "") {
    if (isStateRootOutsideCheckout(root, callerStateRoot)) {
      return callerStateRoot;
    }
  }

  const canonicalCommon = resolveCanonicalGitCommon(root);
  const hash = computeGitCommonHash(canonicalCommon);
  const baseStateDir = resolveAnimusStateDir(customExternalStateDir);
  const triageRoot = join(baseStateDir, "triage", hash);

  if (!existsSync(triageRoot)) {
    try {
      mkdirSync(triageRoot, { recursive: true });
    } catch {}
  }

  return triageRoot;
}
