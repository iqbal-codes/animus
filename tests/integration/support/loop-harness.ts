import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnimusLoop as baseRunAnimusLoop } from "../../../scripts/animus-loop";

// Re-export the canonical loop surface unchanged for tests that inspect exports.
export * from "../../../scripts/animus-loop";

let installationStateDir: string | null = null;

/**
 * Loop integration tests exercise the real native seam. They must never read the
 * operator's live Animus home, so every call pins the installation hold check to
 * an isolated temporary state directory (a missing database is a brand-new
 * installation). Workspace paths remain unchanged because ANIMUS_HOME is not set.
 */
function testInstallationStateDir(): string {
  installationStateDir ??= mkdtempSync(join(tmpdir(), "animus-loop-test-installation-"));
  return installationStateDir;
}

process.on("exit", () => {
  if (!installationStateDir) return;
  try {
    rmSync(installationStateDir, { recursive: true, force: true });
  } catch {}
});

function withTestInstallationState<T extends { installationStateDir?: string }>(
  options: T | undefined,
): T & { installationStateDir: string } {
  return {
    ...(options ?? ({} as T)),
    installationStateDir: options?.installationStateDir ?? testInstallationStateDir(),
  };
}

export function runAnimusLoop(
  ...[root, issue, options]: Parameters<typeof baseRunAnimusLoop>
): ReturnType<typeof baseRunAnimusLoop> {
  return baseRunAnimusLoop(root, issue, withTestInstallationState(options));
}

/** Mirrors the production alias so callers keep one stable reference. */
export const runLocalLoop = runAnimusLoop;
