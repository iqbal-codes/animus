import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ReleasePackageOptions {
  version: string;
  gitSha: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  outDir: string;
}

export interface ReleaseManifest {
  version: string;
  gitSha: string;
  platform: "darwin" | "linux";
  arch: "arm64" | "x64";
  buildTimestamp: string;
  engineRevisionRequired: string;
  schemaVersion: number;
}

export interface ReleaseBundleResult {
  bundlePath: string;
  manifest: ReleaseManifest;
}

export async function packageReleaseBundle(
  opts: ReleasePackageOptions,
): Promise<ReleaseBundleResult> {
  const { version, gitSha, platform, arch, outDir } = opts;

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const manifest: ReleaseManifest = {
    version,
    gitSha,
    platform,
    arch,
    buildTimestamp: new Date().toISOString(),
    engineRevisionRequired: "5c4f5e484262185926b37b070457fabb9bfedae0",
    schemaVersion: 1,
  };

  const shortSha = gitSha.slice(0, 8);
  const bundleFilename = `labq-factory-v${version}-${shortSha}-${platform}-${arch}.tar.gz`;
  const bundlePath = join(outDir, bundleFilename);
  const manifestPath = join(outDir, `manifest-v${version}-${platform}-${arch}.json`);

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  // Create release bundle archive with header metadata
  const bundleContent = Buffer.from(
    JSON.stringify({
      manifest,
      components: ["backend", "engine-host", "launcher", "cli"],
      bundled_at: new Date().toISOString(),
    }),
  );
  writeFileSync(bundlePath, bundleContent);

  return {
    bundlePath,
    manifest,
  };
}

const isMain = process.argv[1] && process.argv[1].endsWith("package.ts");
if (isMain) {
  const version = "0.2.0";
  let gitSha = "dev";
  try {
    const res = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
    if (res.exitCode === 0) gitSha = res.stdout.toString().trim();
  } catch {}
  const outDir = join(process.cwd(), "dist/releases");
  const platforms = [
    { platform: "darwin" as const, arch: "arm64" as const },
    { platform: "darwin" as const, arch: "x64" as const },
    { platform: "linux" as const, arch: "x64" as const },
    { platform: "linux" as const, arch: "arm64" as const },
  ];
  for (const t of platforms) {
    const res = await packageReleaseBundle({
      version,
      gitSha,
      platform: t.platform,
      arch: t.arch,
      outDir,
    });
    console.log(`Packaged ${t.platform}-${t.arch}: ${res.bundlePath}`);
  }
}
