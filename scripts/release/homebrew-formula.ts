import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const HOMEBREW_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export type HomebrewTarget = (typeof HOMEBREW_TARGETS)[number];

export interface HomebrewFormulaOptions {
  version: string;
  repo?: string;
  desc?: string;
  homepage?: string;
  license?: string;
  sha256?: Record<string, string>;
  checksums?: Record<string, string>;
  "darwin-arm64"?: string;
  "darwin-x64"?: string;
  "linux-arm64"?: string;
  "linux-x64"?: string;
  darwin_arm64?: string;
  darwin_x64?: string;
  linux_arm64?: string;
  linux_x64?: string;
  darwinArm64?: string;
  darwinX64?: string;
  linuxArm64?: string;
  linuxX64?: string;
}

export function generateHomebrewFormula(opts: HomebrewFormulaOptions): string {
  if (!opts || typeof opts !== "object") {
    throw new Error("Missing options for generateHomebrewFormula");
  }

  if (!opts.version || typeof opts.version !== "string" || !opts.version.trim()) {
    throw new Error("Missing or empty version in generateHomebrewFormula options");
  }

  const cleanVersion = opts.version.replace(/^v/, "").trim();
  if (!cleanVersion) {
    throw new Error("Invalid empty version in generateHomebrewFormula options");
  }

  const resolveTargetSha = (target: HomebrewTarget): string => {
    const tarballFilename = `labq-factory-v${cleanVersion}-${target}.tar.gz`;
    const altTargetUnder = target.replace("-", "_");
    const altTargetCamel = target.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

    const rawVal =
      opts.sha256?.[target] ??
      opts.sha256?.[tarballFilename] ??
      opts.checksums?.[target] ??
      opts.checksums?.[tarballFilename] ??
      (opts as Record<string, any>)[target] ??
      (opts as Record<string, any>)[altTargetUnder] ??
      (opts as Record<string, any>)[altTargetCamel];

    if (rawVal === undefined || rawVal === null || typeof rawVal !== "string" || !rawVal.trim()) {
      throw new Error(
        `Missing SHA-256 digest for target "${target}". All 4 targets (darwin-arm64, darwin-x64, linux-arm64, linux-x64) are required.`,
      );
    }

    const trimmed = rawVal.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(trimmed)) {
      throw new Error(
        `Invalid SHA-256 digest for target "${target}": expected 64 hexadecimal characters, got "${rawVal}".`,
      );
    }

    return trimmed;
  };

  const darwinArm64Sha = resolveTargetSha("darwin-arm64");
  const darwinX64Sha = resolveTargetSha("darwin-x64");
  const linuxArm64Sha = resolveTargetSha("linux-arm64");
  const linuxX64Sha = resolveTargetSha("linux-x64");

  const repo = (opts.repo ?? "iqbal-codes/labq-software-factory").trim();
  const desc = (
    opts.desc ??
    "Autonomous software factory with unified launcher, local-first React web console, and private engine-host coordination"
  ).trim();
  const homepage = (opts.homepage ?? `https://github.com/${repo}`).trim();
  const license = (opts.license ?? "MIT").trim();

  const baseUrl = `https://github.com/${repo}/releases/download/v${cleanVersion}`;

  return `class LabqFactory < Formula
  desc "${desc}"
  homepage "${homepage}"
  version "${cleanVersion}"
  license "${license}"

  on_macos do
    on_arm do
      url "${baseUrl}/labq-factory-v${cleanVersion}-darwin-arm64.tar.gz"
      sha256 "${darwinArm64Sha}"
    end
    on_intel do
      url "${baseUrl}/labq-factory-v${cleanVersion}-darwin-x64.tar.gz"
      sha256 "${darwinX64Sha}"
    end
  end

  on_linux do
    on_arm do
      url "${baseUrl}/labq-factory-v${cleanVersion}-linux-arm64.tar.gz"
      sha256 "${linuxArm64Sha}"
    end
    on_intel do
      url "${baseUrl}/labq-factory-v${cleanVersion}-linux-x64.tar.gz"
      sha256 "${linuxX64Sha}"
    end
  end

  def install
    bin.install "labq-factory"
    bin.install_symlink "labq-factory" => "factory"
    bin.install_symlink "labq-factory" => "labq"
  end

  test do
    assert_match "labq-factory", shell_output("#{bin}/labq-factory version")
  end
end
`;
}

export function stageReleaseHomebrewFormula(opts: {
  version: string;
  outDir: string;
  sha256?: Record<string, string>;
  checksums?: Record<string, string>;
  repo?: string;
  desc?: string;
  homepage?: string;
  license?: string;
  "darwin-arm64"?: string;
  "darwin-x64"?: string;
  "linux-arm64"?: string;
  "linux-x64"?: string;
}): { formulaPath: string; content: string; sha256: string } {
  const content = generateHomebrewFormula(opts as HomebrewFormulaOptions);
  const outDir = resolve(opts.outDir);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const formulaPath = join(outDir, "labq-factory.rb");
  writeFileSync(formulaPath, content, "utf-8");
  const sha256 = createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex");
  return { formulaPath, content, sha256 };
}

const isMain =
  (typeof Bun !== "undefined" && Boolean(import.meta.main)) ||
  (process.argv[1] !== undefined && process.argv[1].endsWith("homebrew-formula.ts"));

if (isMain) {
  const args = process.argv.slice(2);
  let version = process.env.RELEASE_VERSION ?? "0.2.0";
  let outDir = resolve(process.cwd(), "dist/releases");
  let checksumsPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[++i];
    } else if (args[i] === "--outDir" && args[i + 1]) {
      outDir = resolve(args[++i]);
    } else if (args[i] === "--checksums" && args[i + 1]) {
      checksumsPath = resolve(args[++i]);
    }
  }

  const checksumsFile = checksumsPath ?? join(outDir, "checksums.txt");
  const checksumsMap: Record<string, string> = {};

  if (existsSync(checksumsFile)) {
    const text = readFileSync(checksumsFile, "utf-8");
    for (const line of text.split("\n")) {
      const match = line.trim().match(/^([a-fA-F0-9]{64})\s+(.+)$/);
      if (match) {
        checksumsMap[match[2].trim()] = match[1].toLowerCase();
      }
    }
  }

  const result = stageReleaseHomebrewFormula({
    version,
    outDir,
    checksums: checksumsMap,
  });

  console.log(
    `Generated Homebrew formula to ${result.formulaPath} (sha256: ${result.sha256.slice(0, 12)}...)`,
  );
}
