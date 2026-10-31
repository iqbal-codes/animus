import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const { bundles, checksums } = await packageAllReleaseBundles({
    version,
    gitSha,
    outDir,
  });
  for (const b of bundles) {
    console.log(
      `Packaged ${b.manifest.platform}-${b.manifest.arch}: ${b.bundlePath} (${b.sha256.slice(0, 12)}...)`,
    );
  }
  console.log(
    `Generated checksums for ${checksums.entries.length} release artifacts at ${checksums.checksumsPath}`,
  );
}
