import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface BuildCliOptions {
  repoRoot?: string;
  outfile?: string;
  target?: string;
  version?: string;
  gitCommit?: string;
}

export async function buildStandaloneCli(opts: BuildCliOptions = {}): Promise<{
  outfile: string;
  aliasOutfile: string;
  version: string;
  gitCommit: string;
}> {
  const repoRoot = resolve(opts.repoRoot ?? process.cwd());
  const version = opts.version ?? "0.2.0";
  let gitCommit = opts.gitCommit;
  if (!gitCommit) {
    const gitRes = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repoRoot });
    gitCommit = gitRes.exitCode === 0 ? gitRes.stdout.toString().trim() : "unknown";
  }

  const outfile = resolve(opts.outfile ?? join(repoRoot, "dist/bin/labq-factory"));
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

    const res = Bun.spawnSync([process.execPath, ...buildArgs], {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    });

    if (res.exitCode !== 0 || !existsSync(outfile)) {
      throw new Error(`Failed to compile standalone CLI binary at ${outfile}`);
    }

    if (process.platform === "darwin") {
      Bun.spawnSync(["codesign", "--remove-signature", outfile]);
      Bun.spawnSync(["codesign", "-s", "-", outfile]);
    }

    copyFileSync(outfile, aliasOutfile);
    if (process.platform === "darwin") {
      Bun.spawnSync(["codesign", "--remove-signature", aliasOutfile]);
      Bun.spawnSync(["codesign", "-s", "-", aliasOutfile]);
    }

    return { outfile, aliasOutfile, version, gitCommit };
  } finally {
    writeFileSync(bundledBuildPath, originalContent, "utf-8");
  }
}

if (import.meta.main) {
  try {
    const result = await buildStandaloneCli();
    console.log(
      `Built standalone LabQ Factory CLI v${result.version} (${result.gitCommit}) -> ${result.outfile} (alias: ${result.aliasOutfile})`,
    );
  } catch (err: any) {
    console.error(err?.message ?? String(err));
    process.exit(1);
  }
}
