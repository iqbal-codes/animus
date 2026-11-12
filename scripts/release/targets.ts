import { join } from "node:path";

/**
 * Platforms and architectures the CLI ships for. `install.sh` selects a
 * tarball from `uname`, so every entry here must contain a binary compiled for
 * exactly this platform and arch — never a host build repackaged four times.
 */
export const RELEASE_TARGETS = [
  { platform: "darwin", arch: "arm64" },
  { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
] as const;

export type ReleasePlatform = (typeof RELEASE_TARGETS)[number]["platform"];
export type ReleaseArch = (typeof RELEASE_TARGETS)[number]["arch"];

export interface ReleaseTarget {
  platform: ReleasePlatform;
  arch: ReleaseArch;
}

export type ReleaseTargetKey = `${ReleasePlatform}-${ReleaseArch}`;

export function releaseTargetKey(target: ReleaseTarget): ReleaseTargetKey {
  return `${target.platform}-${target.arch}`;
}

/** The value `bun build --compile --target` expects for this release target. */
export function bunCompileTarget(target: ReleaseTarget): string {
  return `bun-${target.platform}-${target.arch}`;
}

/** The target of the machine currently running the compiler, or null when it is not shippable. */
export function hostReleaseTarget(): ReleaseTarget | null {
  const { platform, arch } = process;
  if (platform !== "darwin" && platform !== "linux") return null;
  if (arch !== "arm64" && arch !== "x64") return null;
  return { platform, arch };
}

export function isHostReleaseTarget(target: ReleaseTarget): boolean {
  const host = hostReleaseTarget();
  return host !== null && host.platform === target.platform && host.arch === target.arch;
}

/** Whether a `bun-<platform>-<arch>` compile target can be executed on this machine. */
export function isHostCompileTarget(compileTarget: string | undefined): boolean {
  if (!compileTarget) return true;
  const host = hostReleaseTarget();
  return host !== null && compileTarget === bunCompileTarget(host);
}

/** Directory holding the compiled `animus` and `factory` binaries for one target. */
export function releaseBinaryDir(repoRoot: string, target: ReleaseTarget): string {
  return join(repoRoot, "dist", "release", releaseTargetKey(target));
}
