import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";

export const MARKER = ".factory-resource.json";
// Forbidden patterns in candidate snapshots: metadata, credentials, and protected paths
export const FORBIDDEN_SUBSTRINGS = [
  ".git",
  ".factory",
  ".animus",
  ".claude",
  ".env",
  MARKER,
  "node_modules",
  ".venv",
  "__pycache__",
];

export function calculateResourceDigest(root: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];

  function walk(dir: string) {
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      const s = statSync(full);
      if (s.isDirectory()) {
        walk(full);
      } else if (s.isFile()) {
        const rel = relative(root, full);
        if (rel !== MARKER) {
          files.push(rel);
        }
      }
    }
  }

  walk(root);
  files.sort();

  if (files.length === 0) {
    throw new Error("delivering revision produced an empty resource");
  }

  for (const rel of files) {
    const full = join(root, rel);
    const content = readFileSync(full);
    hash.update(rel);
    hash.update("\0");
    hash.update(String(content.length));
    hash.update("\0");
    hash.update(content);
  }

  return hash.digest("hex");
}

export function isOwnedDestination(destination: string): boolean {
  const markerPath = join(destination, MARKER);
  if (!existsSync(markerPath)) return false;
  try {
    const data = JSON.parse(readFileSync(markerPath, "utf-8"));
    return (
      data.version === 1 &&
      data.kind === "factory-runtime-resource" &&
      data.resource_root === destination
    );
  } catch {
    return false;
  }
}

export function verifyDeliveringCheckout(
  repoRoot: string,
  expectedRevision?: string,
): { root: string; revision: string } {
  let actualRev = "";
  try {
    actualRev = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
  } catch {
    throw new Error("Git could not verify the delivering revision");
  }

  if (!/^[0-9a-f]{40}$/.test(actualRev)) {
    throw new Error("delivering checkout does not have a full commit revision");
  }
  if (expectedRevision && expectedRevision !== actualRev) {
    throw new Error("expected revision does not match the delivering checkout");
  }

  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).trim();
  if (status.length > 0) {
    throw new Error("delivering checkout has modified tracked files");
  }

  return { root: repoRoot, revision: actualRev };
}

export interface PreparedResource {
  version: 1;
  kind: "factory-runtime-resource";
  source_revision: string;
  resource_root: string;
  resource_digest: string;
  created_at: string;
}

export function prepareRuntimeResource(
  repoRoot: string,
  destination: string,
  includes: string[],
  expectedRevision?: string,
): PreparedResource {
  for (const inc of includes) {
    if (isAbsolute(inc) || inc.includes("..")) {
      throw new Error("private or escaping source path refused");
    }
    const parts = inc.split("/");
    if (parts.some((p) => FORBIDDEN_SUBSTRINGS.includes(p.toLowerCase()))) {
      throw new Error("private or escaping source path refused");
    }
  }

  const { revision } = verifyDeliveringCheckout(repoRoot, expectedRevision);

  if (existsSync(destination)) {
    const entries = readdirSync(destination);
    if (entries.length > 0 && !isOwnedDestination(destination)) {
      throw new Error("destination exists and is not an owned resource root");
    }
    rmSync(destination, { recursive: true, force: true });
  }

  mkdirSync(destination, { recursive: true });

  for (const inc of includes) {
    const src = join(repoRoot, inc);
    const dest = join(destination, inc);
    if (!existsSync(src)) {
      throw new Error(`Configured source missing: ${inc}`);
    }
    const stat = statSync(src);
    if (stat.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyDirectory(src, dest);
    } else {
      const parent = join(dest, "..");
      if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
      copyFileSync(src, dest);
    }
  }

  const digest = calculateResourceDigest(destination);
  const metadata: PreparedResource = {
    version: 1,
    kind: "factory-runtime-resource",
    source_revision: revision,
    resource_root: destination,
    resource_digest: digest,
    created_at: new Date().toISOString(),
  };

  writeFileSync(join(destination, MARKER), JSON.stringify(metadata, null, 2));
  return metadata;
}

function copyDirectory(src: string, dest: string) {
  for (const f of readdirSync(src)) {
    if (FORBIDDEN_SUBSTRINGS.includes(f.toLowerCase())) continue;
    const srcFile = join(src, f);
    const destFile = join(dest, f);
    const stat = statSync(srcFile);
    if (stat.isDirectory()) {
      mkdirSync(destFile, { recursive: true });
      copyDirectory(srcFile, destFile);
    } else if (stat.isFile()) {
      copyFileSync(srcFile, destFile);
    }
  }
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Unable to obtain port")));
        return;
      }
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

export function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    try {
      // Send signal to process group
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
    }
  }
}

export interface CandidateEnvironmentOptions {
  slot: string;
  resourceRoot: string;
  expectedRevision: string;
  command: string[];
  port?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ActiveCandidate {
  slot: string;
  proc: ChildProcess;
  candidateIdentity: string;
  port: number;
  stateDir: string;
  url: string;
  stop: () => Promise<void>;
}

export async function startCandidateEnvironment(
  options: CandidateEnvironmentOptions,
): Promise<ActiveCandidate> {
  const { slot, resourceRoot, expectedRevision, command, env = {}, timeoutMs = 15000 } = options;

  if (!isOwnedDestination(resourceRoot)) {
    throw new Error("bound root is not an owned runtime resource");
  }

  const marker = JSON.parse(readFileSync(join(resourceRoot, MARKER), "utf-8")) as PreparedResource;
  if (marker.source_revision !== expectedRevision) {
    throw new Error("stale expected candidate revision");
  }
  const currentDigest = calculateResourceDigest(resourceRoot);
  if (currentDigest !== marker.resource_digest) {
    throw new Error("prepared candidate resource changed");
  }

  const tmpState = mkdtempSync(join(tmpdir(), "candidate-state-"));
  const resolvedPort = options.port ?? (await getAvailablePort());

  const exe = command[0];
  const exeName = exe.split("/").pop() || "";
  if (!/^(bun|node)$/.test(exeName)) {
    throw new Error("only ordinary Bun/Node executables are supported; no shells or provider CLIs");
  }

  const cleanEnv: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: tmpState,
    TMPDIR: tmpState,
    FACTORY_RUNTIME_STATE: tmpState,
    FACTORY_RUNTIME_PORT: String(resolvedPort),
  };

  for (const [k, v] of Object.entries(env)) {
    if (
      !k.startsWith("FACTORY_RUNTIME_") &&
      !k.startsWith("OPENROUTER_") &&
      !k.startsWith("FACTORY_HOST_TOKEN")
    ) {
      cleanEnv[k] = v;
    }
  }

  const identityHash = createHash("sha256")
    .update(JSON.stringify({ digest: currentDigest, argv: command, port: resolvedPort }))
    .digest("hex");
  const candidateIdentity = `factory-v1:${identityHash}`;
  cleanEnv.FACTORY_RUNTIME_CANDIDATE = candidateIdentity;

  const interpolatedArgs = command
    .slice(1)
    .map((arg) =>
      arg
        .replace("{port}", String(resolvedPort))
        .replace("{state}", tmpState)
        .replace("{source}", resourceRoot),
    );

  const proc = spawn(exe, interpolatedArgs, {
    cwd: resourceRoot,
    env: cleanEnv,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const pid = proc.pid;

  const cleanup = () => {
    if (pid) {
      killProcessTree(pid, "SIGKILL");
    }
    rmSync(tmpState, { recursive: true, force: true });
  };

  // Register foreground parent exit/death cleanup
  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const url = `http://127.0.0.1:${resolvedPort}`;
  const deadline = Date.now() + timeoutMs;
  let ready = false;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      cleanup();
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      throw new Error("app stopped before readiness");
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  if (!ready) {
    cleanup();
    process.removeListener("exit", cleanup);
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
    throw new Error("app readiness/identity refused");
  }

  return {
    slot,
    proc,
    candidateIdentity,
    port: resolvedPort,
    stateDir: tmpState,
    url,
    async stop() {
      process.removeListener("exit", cleanup);
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      if (pid) {
        killProcessTree(pid, "SIGTERM");
      }
      await new Promise<void>((resolve) => {
        if (proc.exitCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          if (pid) killProcessTree(pid, "SIGKILL");
          resolve();
        }, 3000);
        proc.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      rmSync(tmpState, { recursive: true, force: true });
    },
  };
}
