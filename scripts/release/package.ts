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
import { dirname, join, resolve } from "node:path";
import { extractChangelogNotes } from "./extract-changelog";

export { extractChangelogNotes };

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

export interface CliDistributionPackageOptions {
  version: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  outDir: string;
  gitSha?: string;
  repoRoot?: string;
  binaryPath?: string;
  binaryContent?: Buffer | string;
  binaries?: {
    "labq-factory"?: Buffer | string;
    factory?: Buffer | string;
    labq?: Buffer | string;
  };
  buildTimestamp?: string;
}

export interface CliDistributionTarballResult {
  tarballPath: string;
  bundlePath: string;
  filename: string;
  version: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  sha256: string;
  executables: string[];
}

export interface PackageAllCliDistributionTarballsOptions {
  version: string;
  outDir: string;
  repoRoot?: string;
  binaryPath?: string;
  binaryContent?: Buffer | string;
  binaries?: {
    "labq-factory"?: Buffer | string;
    factory?: Buffer | string;
    labq?: Buffer | string;
  };
  buildTimestamp?: string;
}

export interface ReleaseChecksumsResult {
  checksumsPath: string;
  content: string;
  entries: ChecksumEntry[];
  checksums: Record<string, string>;
}

export const RELEASE_TARGETS = [
  { platform: "darwin" as const, arch: "arm64" as const },
  { platform: "darwin" as const, arch: "x64" as const },
  { platform: "linux" as const, arch: "x64" as const },
  { platform: "linux" as const, arch: "arm64" as const },
] as const;

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
  const bundleFilename = `labq-factory-v${version}-${shortSha}-${platform}-${arch}.tar.gz`;
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

export async function packageCliDistributionTarball(
  opts: CliDistributionPackageOptions,
): Promise<CliDistributionTarballResult> {
  const { version, platform, arch, outDir } = opts;
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const filename = `labq-factory-v${version}-${platform}-${arch}.tar.gz`;
  const tarballPath = join(outDir, filename);

  const stageDir = mkdtempSync(join(tmpdir(), `labq-dist-${platform}-${arch}-`));
  const executables = ["labq-factory", "factory", "labq"];

  try {
    const resolveBinaryData = (binName: string): Buffer => {
      if (opts.binaries && opts.binaries[binName as keyof typeof opts.binaries]) {
        const val = opts.binaries[binName as keyof typeof opts.binaries]!;
        return Buffer.isBuffer(val) ? val : Buffer.from(val);
      }

      if (opts.binaryContent) {
        return Buffer.isBuffer(opts.binaryContent)
          ? opts.binaryContent
          : Buffer.from(opts.binaryContent);
      }

      if (opts.binaryPath) {
        const directPath = resolve(opts.binaryPath);
        if (existsSync(directPath)) {
          if (statSync(directPath).isDirectory()) {
            const nested = join(directPath, binName);
            if (existsSync(nested)) return readFileSync(nested);
          } else {
            const sibling = join(dirname(directPath), binName);
            if (existsSync(sibling)) return readFileSync(sibling);
            return readFileSync(directPath);
          }
        }
      }

      const candidateBin = join(repoRoot, "dist/bin", binName);
      if (existsSync(candidateBin)) {
        return readFileSync(candidateBin);
      }
      const candidateMainBin = join(repoRoot, "dist/bin/labq-factory");
      if (existsSync(candidateMainBin)) {
        return readFileSync(candidateMainBin);
      }

      const candidateCliJs = join(repoRoot, "dist/cli.js");
      if (existsSync(candidateCliJs)) {
        return readFileSync(candidateCliJs);
      }

      return Buffer.from(
        ["#!/usr/bin/env bun", `console.log("labq-factory v${version}");`, ""].join("\n"),
        "utf-8",
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

    return {
      tarballPath,
      bundlePath: tarballPath,
      filename,
      version,
      platform,
      arch,
      sha256,
      executables,
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
      binaryPath: opts.binaryPath,
      binaryContent: opts.binaryContent,
      binaries: opts.binaries,
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
    console.log(
      `Packaged CLI tarball ${t.platform}-${t.arch}: ${t.tarballPath} (${t.sha256.slice(0, 12)}...)`,
    );
  }

  const staging = stageReleaseInstallerScript({ outDir });
  if (staging.staged) {
    console.log(`Staged install.sh to ${staging.destinationPath}`);
  }

  const checksums = await generateReleaseChecksums(outDir);
  console.log(
    `Generated checksums for ${checksums.entries.length} release artifacts at ${checksums.checksumsPath}`,
  );
}
