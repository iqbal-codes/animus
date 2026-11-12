import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { extractChangelogNotes } from "./extract-changelog";
import { generateHomebrewFormula, stageReleaseHomebrewFormula } from "./homebrew-formula";
import {
  RELEASE_TARGETS,
  type ReleaseArch,
  type ReleasePlatform,
  type ReleaseTarget,
  type ReleaseTargetKey,
  releaseBinaryDir,
  releaseTargetKey,
} from "./targets";
import { assertNativeBinaryForTarget, type DetectedNativeBinary } from "./verify-binary";

export { extractChangelogNotes, generateHomebrewFormula, stageReleaseHomebrewFormula };
export { RELEASE_TARGETS };

export interface ReleasePackageOptions {
  version: string;
  gitSha: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  outDir: string;
  buildTimestamp?: string;
  engineRevisionRequired?: string;
  schemaVersion?: number;
}

export interface ReleaseManifest {
  version: string;
  gitSha: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  buildTimestamp: string;
  engineRevisionRequired: string;
  schemaVersion: number;
  sha256?: string;
}

export interface ReleaseBundleResult {
  bundlePath: string;
  manifestPath: string;
  manifest: ReleaseManifest;
  sha256: string;
}

export interface ChecksumEntry {
  filename: string;
  sha256: string;
}

export interface TargetBinaries {
  animus?: Buffer | string;
  factory?: Buffer | string;
}

export interface CliDistributionPackageOptions {
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  outDir: string;
  gitSha?: string;
  repoRoot?: string;
  /**
   * Root holding one directory per target (`<platform>-<arch>/animus` and
   * `factory`). Defaults to `<repoRoot>/dist/release`, which is where
   * `bun run build:cli:release` writes.
   */
  binaryDir?: string;
  /** Explicit per-target binaries, keyed by `<platform>-<arch>`; overrides `binaryDir`. */
  binariesByTarget?: Partial<Record<ReleaseTargetKey, TargetBinaries>>;
  /** Defaults to true: refuse to package a member that is not a native executable for its target. */
  requireNativeBinary?: boolean;
  buildTimestamp?: string;
}

export interface CliDistributionTarballResult {
  tarballPath: string;
  bundlePath: string;
  filename: string;
  version: string;
  platform: ReleasePlatform;
  arch: ReleaseArch;
  sha256: string;
  executables: string[];
  /** Header parsed out of the packaged `animus` member; null when content verification is disabled. */
  binary: DetectedNativeBinary | null;
}

export interface PackageAllCliDistributionTarballsOptions {
  version: string;
  outDir: string;
  repoRoot?: string;
  binaryDir?: string;
  binariesByTarget?: Partial<Record<ReleaseTargetKey, TargetBinaries>>;
  requireNativeBinary?: boolean;
  buildTimestamp?: string;
}

export interface ReleaseChecksumsResult {
  checksumsPath: string;
  content: string;
  entries: ChecksumEntry[];
  checksums: Record<string, string>;
}

export async function packageReleaseBundle(
  opts: ReleasePackageOptions,
): Promise<ReleaseBundleResult> {
  const { version, gitSha, platform, arch, outDir } = opts;

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const buildTimestamp = opts.buildTimestamp ?? new Date().toISOString();
  const engineRevisionRequired =
    opts.engineRevisionRequired ?? "5c4f5e484262185926b37b070457fabb9bfedae0";
  const schemaVersion = opts.schemaVersion ?? 1;

  const manifest: ReleaseManifest = {
    version,
    gitSha,
    platform,
    arch,
    buildTimestamp,
    engineRevisionRequired,
    schemaVersion,
  };

  const shortSha = gitSha.slice(0, 8);
  const bundleFilename = `animus-v${version}-${shortSha}-${platform}-${arch}.tar.gz`;
  const bundlePath = join(outDir, bundleFilename);
  const manifestPath = join(outDir, `manifest-v${version}-${platform}-${arch}.json`);

  // Create release bundle archive with header metadata
  const bundleContent = Buffer.from(
    JSON.stringify({
      manifest,
      components: ["backend", "engine-host", "launcher", "cli"],
      bundled_at: buildTimestamp,
    }),
  );
  writeFileSync(bundlePath, bundleContent);

  const bundleSha256 = createHash("sha256").update(bundleContent).digest("hex");
  manifest.sha256 = bundleSha256;

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  return {
    bundlePath,
    manifestPath,
    manifest,
    sha256: bundleSha256,
  };
}

export async function generateReleaseChecksums(outDir: string): Promise<ReleaseChecksumsResult> {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const dirents = readdirSync(outDir, { withFileTypes: true });
  const filenames = dirents
    .filter((d) => d.isFile() && d.name !== "checksums.txt" && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();

  const entries: ChecksumEntry[] = [];
  const checksums: Record<string, string> = {};
  const lines: string[] = [];

  for (const filename of filenames) {
    const filePath = join(outDir, filename);
    const fileBytes = readFileSync(filePath);
    const sha256 = createHash("sha256").update(fileBytes).digest("hex");

    entries.push({ filename, sha256 });
    checksums[filename] = sha256;
    lines.push(`${sha256}  ${filename}`);
  }

  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const checksumsPath = join(outDir, "checksums.txt");
  writeFileSync(checksumsPath, content, "utf-8");

  return {
    checksumsPath,
    content,
    entries,
    checksums,
  };
}

export function verifyReleaseChecksums(checksumsPathOrDir: string): {
  ok: boolean;
  verified: string[];
  failures: string[];
  checksumsPath: string;
} {
  let checksumsPath = checksumsPathOrDir;
  let outDir: string;
  if (statSync(checksumsPathOrDir).isDirectory()) {
    outDir = checksumsPathOrDir;
    checksumsPath = join(checksumsPathOrDir, "checksums.txt");
  } else {
    outDir = join(checksumsPathOrDir, "..");
  }

  if (!existsSync(checksumsPath)) {
    return {
      ok: false,
      verified: [],
      failures: [`Checksum file not found: ${checksumsPath}`],
      checksumsPath,
    };
  }

  const content = readFileSync(checksumsPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const verified: string[] = [];
  const failures: string[] = [];

  for (const line of lines) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/);
    if (!match) {
      failures.push(`Invalid checksum line format: '${line}'`);
      continue;
    }
    const expectedSha256 = match[1].toLowerCase();
    const filename = match[2].trim();
    const targetFile = join(outDir, filename);

    if (!existsSync(targetFile)) {
      failures.push(`Target file missing: ${filename}`);
      continue;
    }

    const actualBytes = readFileSync(targetFile);
    const actualSha256 = createHash("sha256").update(actualBytes).digest("hex").toLowerCase();

    if (actualSha256 !== expectedSha256) {
      failures.push(
        `SHA-256 mismatch for ${filename}: expected ${expectedSha256}, got ${actualSha256}`,
      );
    } else {
      verified.push(filename);
    }
  }

  return {
    ok: failures.length === 0 && verified.length > 0,
    verified,
    failures,
    checksumsPath,
  };
}

export async function packageAllReleaseBundles(opts: {
  version: string;
  gitSha: string;
  outDir: string;
  buildTimestamp?: string;
}): Promise<{
  bundles: ReleaseBundleResult[];
  checksums: ReleaseChecksumsResult;
}> {
  const bundles: ReleaseBundleResult[] = [];
  for (const t of RELEASE_TARGETS) {
    const bundle = await packageReleaseBundle({
      version: opts.version,
      gitSha: opts.gitSha,
      platform: t.platform,
      arch: t.arch,
      outDir: opts.outDir,
      buildTimestamp: opts.buildTimestamp,
    });
    bundles.push(bundle);
  }

  const checksums = await generateReleaseChecksums(opts.outDir);
  return { bundles, checksums };
}

const ARCHIVE_HEADER_BYTES = 4096;

/**
 * Reads the first bytes of one tarball member without extracting it: `head`
 * closes the pipe once it has enough, so inspecting a ~100 MB binary costs one
 * page of I/O and one page of memory.
 */
function readArchiveMemberHeader(tarballPath: string, member: string): Buffer {
  const res = spawnSync(
    "sh",
    ["-c", `tar -xOf "$1" "$2" | head -c ${ARCHIVE_HEADER_BYTES}`, "sh", tarballPath, member],
    { maxBuffer: ARCHIVE_HEADER_BYTES * 2 },
  );
  if (res.error) {
    throw new Error(`Failed to read ${member} from ${tarballPath}: ${res.error.message}`);
  }
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.alloc(0);
}

/**
 * Proves what actually shipped, not what was staged: parses the executable
 * headers back out of the archive and fails when a member is missing, is not a
 * native executable, or was built for a different platform/arch.
 */
export function verifyDistributionTarball(
  tarballPath: string,
  target: ReleaseTarget,
  executables: string[] = ["animus", "factory"],
): Record<string, DetectedNativeBinary> {
  const verified: Record<string, DetectedNativeBinary> = {};
  const archiveName = basename(tarballPath);
  for (const name of executables) {
    const header = readArchiveMemberHeader(tarballPath, name);
    if (header.length === 0) {
      throw new Error(`${archiveName} does not contain a readable ${name} member`);
    }
    verified[name] = assertNativeBinaryForTarget(header, target, `${archiveName}:${name}`);
  }
  return verified;
}

export async function packageCliDistributionTarball(
  opts: CliDistributionPackageOptions,
): Promise<CliDistributionTarballResult> {
  const { version, platform, arch, outDir } = opts;
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const filename = `animus-v${version}-${platform}-${arch}.tar.gz`;
  const tarballPath = join(outDir, filename);

  const stageDir = mkdtempSync(join(tmpdir(), `animus-dist-${platform}-${arch}-`));
  const executables = ["animus", "factory"];
  const target: ReleaseTarget = { platform, arch };
  const targetKey = releaseTargetKey(target);

  try {
    const resolveBinaryData = (binName: string): Buffer => {
      const override = opts.binariesByTarget?.[targetKey]?.[binName as keyof TargetBinaries];
      if (override !== undefined) {
        return Buffer.isBuffer(override) ? override : Buffer.from(override);
      }

      const candidate = opts.binaryDir
        ? join(resolve(opts.binaryDir), targetKey, binName)
        : join(releaseBinaryDir(repoRoot, target), binName);
      if (existsSync(candidate)) {
        return readFileSync(candidate);
      }

      throw new Error(
        `Missing ${targetKey} ${binName} binary at ${candidate}. ` +
          "Every release target needs its own compiled binary: run `bun run build:cli:release` first.",
      );
    };

    for (const binName of executables) {
      const targetFile = join(stageDir, binName);
      const data = resolveBinaryData(binName);
      writeFileSync(targetFile, data, { mode: 0o755 });
      try {
        chmodSync(targetFile, 0o755);
      } catch {}

      if (opts.buildTimestamp) {
        try {
          const date = new Date(opts.buildTimestamp);
          utimesSync(targetFile, date, date);
        } catch {}
      }
    }

    rmSync(tarballPath, { force: true });
    const tarRes = spawnSync("tar", ["-czf", tarballPath, "-C", stageDir, ...executables], {
      cwd: stageDir,
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      encoding: "utf-8",
    });

    if (tarRes.status !== 0 || !existsSync(tarballPath)) {
      throw new Error(
        `Failed to create distribution tarball at ${tarballPath}: ${tarRes.stderr || tarRes.stdout}`,
      );
    }

    const archiveBytes = readFileSync(tarballPath);
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");

    const binary =
      opts.requireNativeBinary === false
        ? null
        : verifyDistributionTarball(tarballPath, target, executables).animus;

    return {
      tarballPath,
      bundlePath: tarballPath,
      filename,
      version,
      platform,
      arch,
      sha256,
      executables,
      binary,
    };
  } finally {
    try {
      rmSync(stageDir, { recursive: true, force: true });
    } catch {}
  }
}

export function stageReleaseInstallerScript(opts: { repoRoot?: string; outDir: string }): {
  staged: boolean;
  destinationPath: string;
} {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const installShPath = join(repoRoot, "install.sh");
  const destDir = resolve(opts.outDir);
  const destinationPath = join(destDir, "install.sh");

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }

  if (existsSync(installShPath)) {
    copyFileSync(installShPath, destinationPath);
    try {
      chmodSync(destinationPath, 0o755);
    } catch {}
    return { staged: true, destinationPath };
  }

  return { staged: false, destinationPath };
}

export async function packageAllCliDistributionTarballs(
  opts: PackageAllCliDistributionTarballsOptions,
): Promise<{
  tarballs: CliDistributionTarballResult[];
  checksums: ReleaseChecksumsResult;
}> {
  const tarballs: CliDistributionTarballResult[] = [];
  for (const t of RELEASE_TARGETS) {
    const tarball = await packageCliDistributionTarball({
      version: opts.version,
      platform: t.platform,
      arch: t.arch,
      outDir: opts.outDir,
      repoRoot: opts.repoRoot,
      binaryDir: opts.binaryDir,
      binariesByTarget: opts.binariesByTarget,
      requireNativeBinary: opts.requireNativeBinary,
      buildTimestamp: opts.buildTimestamp,
    });
    tarballs.push(tarball);
  }

  const checksums = await generateReleaseChecksums(opts.outDir);
  return { tarballs, checksums };
}

const isMain =
  (typeof Bun !== "undefined" && Boolean(import.meta.main)) ||
  (process.argv[1] !== undefined && process.argv[1].endsWith("package.ts"));

if (isMain) {
  const version = process.env.RELEASE_VERSION ?? "0.2.0";
  let gitSha = process.env.RELEASE_GIT_SHA ?? "dev";
  try {
    const res = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
    if (res.status === 0 && res.stdout) gitSha = res.stdout.trim();
  } catch {}
  const outDir = join(process.cwd(), "dist/releases");
  const { bundles } = await packageAllReleaseBundles({
    version,
    gitSha,
    outDir,
  });
  for (const b of bundles) {
    console.log(
      `Packaged bundle ${b.manifest.platform}-${b.manifest.arch}: ${b.bundlePath} (${b.sha256.slice(0, 12)}...)`,
    );
  }

  const { tarballs } = await packageAllCliDistributionTarballs({
    version,
    outDir,
  });
  for (const t of tarballs) {
    const shipped = t.binary
      ? `${t.binary.format}/${t.binary.archs.join("+")} verified`
      : "content verification skipped";
    console.log(
      `Packaged CLI tarball ${t.platform}-${t.arch}: ${t.tarballPath} (${t.sha256.slice(0, 12)}..., ${shipped})`,
    );
  }

  const staging = stageReleaseInstallerScript({ outDir });
  if (staging.staged) {
    console.log(`Staged install.sh to ${staging.destinationPath}`);
  }

  const formulaResult = stageReleaseHomebrewFormula({
    version,
    outDir,
    sha256: tarballs.reduce(
      (acc, t) => {
        acc[`${t.platform}-${t.arch}`] = t.sha256;
        return acc;
      },
      {} as Record<string, string>,
    ),
  });
  console.log(
    `Generated Homebrew formula to ${formulaResult.formulaPath} (${formulaResult.sha256.slice(0, 12)}...)`,
  );

  const checksums = await generateReleaseChecksums(outDir);
  console.log(
    `Generated checksums for ${checksums.entries.length} release artifacts at ${checksums.checksumsPath}`,
  );
}
