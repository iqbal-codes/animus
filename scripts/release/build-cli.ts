import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface BuildCliOptions {
  repoRoot?: string;
  outfile?: string;
  target?: string;
  version?: string;
  gitCommit?: string;
  smokeVerify?: boolean;
}

export interface VerifyCliBinarySmokeOptions {
  binaryPath?: string;
  expectedVersion?: string;
  expectedGitSha?: string;
  tempDir?: string;
  throwOnError?: boolean;
}

export interface CliSmokeResult {
  ok: boolean;
  version: string;
  gitCommit: string;
  commands: string[];
  versionOutput: string;
  helpOutput: string;
  errors: string[];
}

export async function verifyCliBinarySmoke(
  targetOrOpts?: string | VerifyCliBinarySmokeOptions,
  maybeOpts?: VerifyCliBinarySmokeOptions,
): Promise<CliSmokeResult> {
  const opts: VerifyCliBinarySmokeOptions =
    typeof targetOrOpts === "string"
      ? { ...maybeOpts, binaryPath: targetOrOpts }
      : { ...targetOrOpts };

  const repoRoot = resolve(process.cwd());
  const defaultBin = join(repoRoot, "dist/bin/animus");
  const defaultEntry = join(repoRoot, "scripts/cli/cli.ts");
  const binaryPath = resolve(
    opts.binaryPath ?? (existsSync(defaultBin) ? defaultBin : defaultEntry),
  );

  const errors: string[] = [];

  if (!existsSync(binaryPath)) {
    const msg = `CLI binary or entrypoint not found at ${binaryPath}`;
    if (opts.throwOnError !== false) {
      throw new Error(msg);
    }
    return {
      ok: false,
      version: "",
      gitCommit: "",
      commands: [],
      versionOutput: "",
      helpOutput: "",
      errors: [msg],
    };
  }

  const isScript =
    binaryPath.endsWith(".ts") || binaryPath.endsWith(".js") || binaryPath.endsWith(".mjs");

  if (!isScript) {
    try {
      chmodSync(binaryPath, 0o755);
    } catch {}
  }

  const runner = typeof Bun !== "undefined" ? process.execPath : "bun";
  const execCmd = isScript ? [runner, binaryPath] : [binaryPath];

  let isolatedDir = opts.tempDir;
  let ownsTempDir = false;
  if (!isolatedDir) {
    isolatedDir = mkdtempSync(join(tmpdir(), "animus-cli-smoke-"));
    ownsTempDir = true;
  } else if (!existsSync(isolatedDir)) {
    mkdirSync(isolatedDir, { recursive: true });
  }

  try {
    // 1. Execute 'version' command
    const versionRes = spawnSync(execCmd[0], [...execCmd.slice(1), "version"], {
      cwd: isolatedDir,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf-8",
    });

    const versionOutput = (versionRes.stdout ?? "") + (versionRes.stderr ?? "");
    const exitCode = versionRes.status ?? (versionRes.error ? 1 : 0);

    if (exitCode !== 0) {
      errors.push(
        `CLI 'version' command failed with exit code ${exitCode}: ${versionOutput.trim()}`,
      );
    }

    let actualVersion = "";
    let actualCommit = "";

    const verMatch = versionOutput.match(/v?([0-9]+\.[0-9]+\.[0-9]+[^\s,)]*)/);
    if (verMatch) actualVersion = verMatch[1];
    const commitMatch = versionOutput.match(/commit:\s*([^,\s)]+)/i);
    if (commitMatch) actualCommit = commitMatch[1];

    if (opts.expectedVersion) {
      const cleanExpected = opts.expectedVersion.replace(/^v/, "");
      if (!versionOutput.includes(cleanExpected)) {
        errors.push(
          `Version mismatch: expected '${opts.expectedVersion}', got '${versionOutput.trim()}'`,
        );
      }
    }

    if (opts.expectedGitSha) {
      const shortSha = opts.expectedGitSha.slice(0, 7);
      const shortSha8 = opts.expectedGitSha.slice(0, 8);
      if (
        !versionOutput.includes(shortSha) &&
        !versionOutput.includes(shortSha8) &&
        !versionOutput.includes(opts.expectedGitSha)
      ) {
        errors.push(
          `Git SHA mismatch: expected '${opts.expectedGitSha}' (short: '${shortSha}'), got '${versionOutput.trim()}'`,
        );
      }
    }

    // 2. Execute '--help' command
    const helpRes = spawnSync(execCmd[0], [...execCmd.slice(1), "--help"], {
      cwd: isolatedDir,
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf-8",
    });

    const helpOutput = (helpRes.stdout ?? "") + (helpRes.stderr ?? "");
    const helpExitCode = helpRes.status ?? (helpRes.error ? 1 : 0);

    if (helpExitCode !== 0) {
      errors.push(
        `CLI '--help' command failed with exit code ${helpExitCode}: ${helpOutput.trim()}`,
      );
    }

    const requiredCommands = ["setup", "project", "serve"];
    const foundCommands: string[] = [];
    const missingCommands: string[] = [];

    for (const cmd of requiredCommands) {
      const cmdRegex = new RegExp(`(^|\\s)${cmd}(\\s|\\[|<|$)`, "m");
      if (cmdRegex.test(helpOutput) || helpOutput.includes(cmd)) {
        foundCommands.push(cmd);
      } else {
        missingCommands.push(cmd);
      }
    }

    if (missingCommands.length > 0) {
      errors.push(`Core command(s) missing from CLI help output: ${missingCommands.join(", ")}`);
    }

    const ok = errors.length === 0;

    if (!ok && opts.throwOnError !== false) {
      throw new Error(`CLI smoke verification failed: ${errors.join("; ")}`);
    }

    return {
      ok,
      version: actualVersion,
      gitCommit: actualCommit,
      commands: foundCommands,
      versionOutput: versionOutput.trim(),
      helpOutput: helpOutput.trim(),
      errors,
    };
  } finally {
    if (ownsTempDir && isolatedDir) {
      try {
        rmSync(isolatedDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function buildStandaloneCli(opts: BuildCliOptions = {}): Promise<{
  outfile: string;
  aliasOutfile: string;
  version: string;
  gitCommit: string;
}> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const version = opts.version ?? process.env.RELEASE_VERSION ?? "0.2.0";
  let gitCommit = opts.gitCommit;
  if (!gitCommit) {
    const gitRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    gitCommit = gitRes.status === 0 && gitRes.stdout ? gitRes.stdout.trim() : "unknown";
  }

  const outfile = resolve(opts.outfile ?? join(repoRoot, "dist/bin/animus"));
  const aliasOutfile = join(dirname(outfile), "factory");
  mkdirSync(dirname(outfile), { recursive: true });
  rmSync(outfile, { force: true });
  rmSync(aliasOutfile, { force: true });

  const bundledBuildPath = join(repoRoot, "scripts/cli/bundled-build.ts");
  const originalContent = readFileSync(bundledBuildPath, "utf-8");

  try {
    writeFileSync(
      bundledBuildPath,
      [
        "export const BUNDLED_IS_BINARY = true;",
        `export const BUNDLED_VERSION = ${JSON.stringify(version)};`,
        `export const BUNDLED_GIT_COMMIT = ${JSON.stringify(gitCommit)};`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const buildArgs = [
      "build",
      "--compile",
      "--minify",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      ...(opts.target ? [`--target=${opts.target}`] : []),
      `--outfile=${outfile}`,
      join(repoRoot, "scripts/cli/cli.ts"),
    ];

    const bunBin = typeof Bun !== "undefined" ? process.execPath : "bun";
    const res = spawnSync(bunBin, buildArgs, {
      cwd: repoRoot,
      stdio: "inherit",
    });

    if (res.status !== 0 || !existsSync(outfile)) {
      throw new Error(`Failed to compile standalone CLI binary at ${outfile}`);
    }

    if (process.platform === "darwin") {
      spawnSync("codesign", ["--remove-signature", outfile]);
      spawnSync("codesign", ["-s", "-", outfile]);
    }

    copyFileSync(outfile, aliasOutfile);
    if (process.platform === "darwin") {
      spawnSync("codesign", ["--remove-signature", aliasOutfile]);
      spawnSync("codesign", ["-s", "-", aliasOutfile]);
    }

    if (opts.smokeVerify) {
      await verifyCliBinarySmoke({
        binaryPath: outfile,
        expectedVersion: version,
        expectedGitSha: gitCommit,
      });
    }

    return { outfile, aliasOutfile, version, gitCommit };
  } finally {
    writeFileSync(bundledBuildPath, originalContent, "utf-8");
  }
}

export async function buildBundledCliScript(opts: BuildCliOptions = {}): Promise<{
  outfile: string;
  version: string;
  gitCommit: string;
}> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const version = opts.version ?? process.env.RELEASE_VERSION ?? "0.2.0";
  let gitCommit = opts.gitCommit;
  if (!gitCommit) {
    const gitRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });
    gitCommit = gitRes.status === 0 && gitRes.stdout ? gitRes.stdout.trim() : "unknown";
  }

  const outfile = resolve(opts.outfile ?? join(repoRoot, "dist/cli.js"));
  mkdirSync(dirname(outfile), { recursive: true });
  rmSync(outfile, { force: true });

  const bundledBuildPath = join(repoRoot, "scripts/cli/bundled-build.ts");
  const originalContent = readFileSync(bundledBuildPath, "utf-8");

  try {
    writeFileSync(
      bundledBuildPath,
      [
        "export const BUNDLED_IS_BINARY = false;",
        `export const BUNDLED_VERSION = ${JSON.stringify(version)};`,
        `export const BUNDLED_GIT_COMMIT = ${JSON.stringify(gitCommit)};`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const buildArgs = [
      "build",
      "--target=bun",
      `--outfile=${outfile}`,
      join(repoRoot, "scripts/cli/cli.ts"),
    ];

    const bunBin = typeof Bun !== "undefined" ? process.execPath : "bun";
    const res = spawnSync(bunBin, buildArgs, {
      cwd: repoRoot,
      stdio: "pipe",
    });

    if (res.status !== 0 || !existsSync(outfile)) {
      const errOut = (res.stderr?.toString() || "") + (res.stdout?.toString() || "");
      throw new Error(`Failed to bundle CLI script at ${outfile}: ${errOut}`);
    }

    let content = readFileSync(outfile, "utf-8");
    if (!content.startsWith("#!/usr/bin/env bun")) {
      if (content.startsWith("#!")) {
        content = content.replace(/^#![^\n]*\n/, "#!/usr/bin/env bun\n");
      } else {
        content = `#!/usr/bin/env bun\n${content}`;
      }
      writeFileSync(outfile, content, "utf-8");
    }

    try {
      chmodSync(outfile, 0o755);
    } catch {}

    if (opts.smokeVerify) {
      await verifyCliBinarySmoke({
        binaryPath: outfile,
        expectedVersion: version,
        expectedGitSha: gitCommit,
      });
    }

    return { outfile, version, gitCommit };
  } finally {
    writeFileSync(bundledBuildPath, originalContent, "utf-8");
  }
}

const isMain =
  (typeof Bun !== "undefined" && Boolean(import.meta.main)) ||
  (process.argv[1] !== undefined && process.argv[1].endsWith("build-cli.ts"));

if (isMain) {
  try {
    const args = process.argv.slice(2);
    const isBundleOnly = args.includes("--bundle-only") || args.includes("--bundle");
    const isStandaloneOnly = args.includes("--standalone-only") || args.includes("--standalone");

    if (!isStandaloneOnly) {
      const bundleResult = await buildBundledCliScript({ smokeVerify: true });
      console.log(
        `Built bundled Animus CLI script v${bundleResult.version} (${bundleResult.gitCommit}) -> ${bundleResult.outfile}`,
      );
      console.log(`Verified CLI bundled script smoke check for ${bundleResult.outfile}`);
    }

    if (!isBundleOnly) {
      const standaloneResult = await buildStandaloneCli({ smokeVerify: true });
      console.log(
        `Built standalone Animus CLI v${standaloneResult.version} (${standaloneResult.gitCommit}) -> ${standaloneResult.outfile} (alias: ${standaloneResult.aliasOutfile})`,
      );
      console.log(`Verified CLI binary smoke check for ${standaloneResult.outfile}`);
    }
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
