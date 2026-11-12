import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAnimusHome } from "@animus/contracts/paths";

const RUNTIME_MARKERS = ["apps/backend/src/main.ts", "apps/engine-host/src/main.ts"] as const;

export class RuntimeRootNotFoundError extends Error {
  readonly code = "runtime_root_not_found";
  constructor(readonly searched: string[]) {
    super(
      [
        "No Animus runtime found.",
        `Looked at: ${searched.join(", ")}.`,
        "Set ANIMUS_SOURCE_ROOT to an animus checkout, or run: git clone https://github.com/iqbal-codes/animus ~/.animus/source && cd ~/.animus/source && bun install --frozen-lockfile",
      ].join(" "),
    );
    this.name = "RuntimeRootNotFoundError";
  }
}

/** A directory is a runtime root only when both service entrypoints exist. */
export function isValidRuntimeRoot(dir: string): boolean {
  return RUNTIME_MARKERS.every((marker) => existsSync(join(dir, marker)));
}

export interface RuntimeRootOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Resolves the source tree that `animus start` launches.
 *
 * Precedence: ANIMUS_SOURCE_ROOT/FACTORY_SOURCE_ROOT, then the invoking
 * directory (development checkout), then ~/.animus/source (installed runtime).
 */
export function resolveRuntimeRoot(opts: RuntimeRootOptions = {}): string {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const env = opts.env ?? process.env;
  const home = resolveAnimusHome(opts.home);

  const candidates: string[] = [];
  for (const key of ["ANIMUS_SOURCE_ROOT", "FACTORY_SOURCE_ROOT"] as const) {
    const value = env[key];
    if (value && value.trim() !== "") candidates.push(resolve(value.trim()));
  }
  candidates.push(cwd, join(home, "source"));

  for (const candidate of candidates) {
    if (isValidRuntimeRoot(candidate)) return candidate;
  }
  throw new RuntimeRootNotFoundError([...new Set(candidates)]);
}

/** Built web console assets for the runtime root, when present. */
export function resolveWebDir(runtimeRoot: string): string | undefined {
  const webDir = join(runtimeRoot, "apps/web/dist");
  return existsSync(join(webDir, "index.html")) ? webDir : undefined;
}
