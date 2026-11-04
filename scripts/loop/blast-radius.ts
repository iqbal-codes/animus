import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";
import { Buffer } from "node:buffer";

export const KNOWN_EXTENSIONS: string[] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

export function extractImportSpecifiers(line: string): string[] {
  const specifiers: string[] = [];
  const fromMatches = line.matchAll(/\bfrom\s+['"`]([^'"`\r\n]+)['"`]/g);
  for (const m of fromMatches) {
    if (m[1]) specifiers.push(m[1].trim());
  }
  const callMatches = line.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`\r\n]+)['"`]/g);
  for (const m of callMatches) {
    if (m[1]) specifiers.push(m[1].trim());
  }
  const sideEffectMatches = line.matchAll(/\bimport\s+['"`]([^'"`\r\n]+)['"`]/g);
  for (const m of sideEffectMatches) {
    if (m[1]) specifiers.push(m[1].trim());
  }
  return [...new Set(specifiers)];
}

export interface GroundedAliasRule {
  scopeDir: string;
  prefix: string;
  isWildcard: boolean;
  targetDir: string;
}

export function loadGroundedAliases(worktree: string): GroundedAliasRule[] {
  const rules: GroundedAliasRule[] = [];

  const visit = (dir: string, depth: number) => {
    if (depth > 2) return;
    try {
      const fullDir = dir ? join(worktree, dir) : worktree;
      if (!existsSync(fullDir)) return;
      const entries = readdirSync(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist")
          continue;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isFile()) {
          if (
            entry.name === "tsconfig.json" ||
            (entry.name.startsWith("tsconfig.") && entry.name.endsWith(".json"))
          ) {
            try {
              const content = readFileSync(join(worktree, rel), "utf8");
              const cleaned = content.replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1");
              const parsed = JSON.parse(cleaned);
              const paths = parsed?.compilerOptions?.paths;
              const baseUrl = parsed?.compilerOptions?.baseUrl ?? ".";
              const configDir = dirname(rel);
              const baseDir = configDir === "." ? "" : configDir;
              const effectiveBase = baseDir ? join(baseDir, baseUrl) : baseUrl;

              if (paths && typeof paths === "object") {
                for (const [key, targets] of Object.entries(paths)) {
                  if (!Array.isArray(targets) || targets.length === 0) continue;
                  const target = targets[0];
                  if (typeof target !== "string") continue;
                  if (key.endsWith("/*") && target.endsWith("/*")) {
                    const prefix = key.slice(0, -1);
                    const targetPrefix = target.slice(0, -1);
                    const resolvedTargetDir = normalize(join(effectiveBase, targetPrefix))
                      .replace(/\\/g, "/")
                      .replace(/^\.\//, "")
                      .replace(/\/$/, "");
                    rules.push({
                      scopeDir: baseDir,
                      prefix,
                      isWildcard: true,
                      targetDir: resolvedTargetDir,
                    });
                  } else {
                    const resolvedTarget = normalize(join(effectiveBase, target))
                      .replace(/\\/g, "/")
                      .replace(/^\.\//, "");
                    rules.push({
                      scopeDir: baseDir,
                      prefix: key,
                      isWildcard: false,
                      targetDir: resolvedTarget,
                    });
                  }
                }
              }
            } catch {}
          } else if (entry.name === "package.json") {
            try {
              const content = readFileSync(join(worktree, rel), "utf8");
              const parsed = JSON.parse(content);
              const pkgName = parsed?.name;
              const configDir = dirname(rel);
              const pkgDir = configDir === "." ? "" : configDir;
              if (pkgName && typeof pkgName === "string") {
                if (parsed.exports && typeof parsed.exports === "object") {
                  for (const [subpath, target] of Object.entries(parsed.exports)) {
                    if (typeof target !== "string") continue;
                    const fullPrefix =
                      subpath === "." ? pkgName : `${pkgName}/${subpath.replace(/^\.\//, "")}`;
                    const targetRel = normalize(join(pkgDir, target))
                      .replace(/\\/g, "/")
                      .replace(/^\.\//, "");
                    rules.push({
                      scopeDir: "",
                      prefix: fullPrefix,
                      isWildcard: false,
                      targetDir: targetRel,
                    });
                  }
                }
                if (parsed.main && typeof parsed.main === "string") {
                  const targetRel = normalize(join(pkgDir, parsed.main))
                    .replace(/\\/g, "/")
                    .replace(/^\.\//, "");
                  rules.push({
                    scopeDir: "",
                    prefix: pkgName,
                    isWildcard: false,
                    targetDir: targetRel,
                  });
                }
              }
            } catch {}
          }
        } else if (entry.isDirectory()) {
          visit(rel, depth + 1);
        }
      }
    } catch {}
  };

  visit("", 0);
  return rules;
}

export function resolveGroundedAlias(
  specifier: string,
  callerFile: string,
  rules: GroundedAliasRule[],
): string[] {
  const results: string[] = [];
  const callerNorm = callerFile.replace(/^\.\//, "").replace(/\\/g, "/");

  for (const rule of rules) {
    if (rule.scopeDir) {
      if (!callerNorm.startsWith(`${rule.scopeDir}/`)) {
        continue;
      }
    }

    if (rule.isWildcard) {
      if (specifier.startsWith(rule.prefix)) {
        const remainder = specifier.slice(rule.prefix.length);
        const resolved = rule.targetDir ? `${rule.targetDir}/${remainder}` : remainder;
        results.push(normalize(resolved).replace(/\\/g, "/").replace(/^\.\//, ""));
      }
    } else {
      if (specifier === rule.prefix) {
        results.push(normalize(rule.targetDir).replace(/\\/g, "/").replace(/^\.\//, ""));
      }
    }
  }

  return results;
}

export function doesImportTargetFile(
  callerFile: string,
  specifier: string,
  targetFile: string,
  rules: GroundedAliasRule[],
): boolean {
  const normTarget = targetFile.replace(/^\.\//, "").replace(/\\/g, "/");
  const targetDir = dirname(normTarget);
  const targetExt = extname(normTarget);
  const targetStem = basename(normTarget, targetExt);
  const isTargetIndex = targetStem === "index";
  const targetDirNorm = targetDir === "." ? "" : targetDir;
  const targetWithoutExt = targetDirNorm ? `${targetDirNorm}/${targetStem}` : targetStem;

  let candidatePaths: string[] = [];

  if (specifier.startsWith(".")) {
    const callerDir = dirname(callerFile);
    const normCallerDir = callerDir === "." ? "" : callerDir;
    const joined = normCallerDir ? `${normCallerDir}/${specifier}` : specifier;
    const normalized = normalize(joined).replace(/\\/g, "/").replace(/^\.\//, "");
    candidatePaths.push(normalized === "." ? "" : normalized);
  } else {
    candidatePaths = resolveGroundedAlias(specifier, callerFile, rules);
  }

  for (const cand of candidatePaths) {
    const candNorm = cand.replace(/^\.\//, "").replace(/\\/g, "/");
    if (candNorm === normTarget) return true;

    const candExt = extname(candNorm);
    const candWithoutExt = KNOWN_EXTENSIONS.includes(candExt)
      ? candNorm.slice(0, candNorm.length - candExt.length)
      : candNorm;

    if (candWithoutExt === targetWithoutExt) return true;

    if (isTargetIndex) {
      if (candNorm === targetDirNorm || candWithoutExt === targetDirNorm) {
        return true;
      }
    }
  }

  return false;
}

export interface StreamBoundedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

export function streamBoundedProcess(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<StreamBoundedResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let byteCount = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PI_CACHE_RETENTION: "long",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      if (!child.pid) return false;
      try {
        if (process.platform !== "win32") {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
        return true;
      } catch {
        return false;
      }
    };

    const finish = (result: StreamBoundedResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        child.stdout?.destroy();
        child.stderr?.destroy();
      } catch {}
      try {
        child.unref();
      } catch {}
      resolve(result);
    };

    const terminateChild = () => {
      try {
        if (signalGroup("SIGTERM")) {
          setTimeout(() => {
            if (signalGroup(0)) signalGroup("SIGKILL");
          }, 100);
        }
      } catch {}
    };

    timer = setTimeout(() => {
      timedOut = true;
      terminateChild();
      finish({
        stdout,
        stderr,
        exitCode: 124,
        timedOut: true,
        truncated,
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (byteCount + chunkBytes > maxBytes) {
        truncated = true;
        const remainingBytes = Math.max(0, maxBytes - byteCount);
        if (remainingBytes > 0) {
          const buf = Buffer.from(chunk, "utf8");
          stdout += buf.subarray(0, remainingBytes).toString("utf8");
          byteCount += remainingBytes;
        }
        terminateChild();
        finish({
          stdout,
          stderr,
          exitCode: 0,
          timedOut: false,
          truncated: true,
        });
      } else {
        stdout += chunk;
        byteCount += chunkBytes;
      }
    });

    child.stderr.on("data", (chunk: string) => {
      if (settled) return;
      stderr += chunk;
    });

    child.once("error", (err: unknown) => {
      const errCode = (err as { code?: string })?.code;
      const exitCode = errCode === "ENOENT" ? 127 : 1;
      const errMsg = (err as Error)?.message || String(err);
      finish({
        stdout,
        stderr: stderr + errMsg,
        exitCode,
        timedOut: false,
        truncated,
      });
    });

    child.once("exit", (code, signal) => {
      finish({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : (code ?? (signal ? 128 : 1)),
        timedOut,
        truncated,
      });
    });
  });
}

export interface ExternalBlastRadiusOptions {
  timeoutMs?: number;
  rgBin?: string;
  maxFiles?: number;
  maxBytes?: number;
  maxResultLines?: number;
  producer?:
    | ((
        argv: string[],
        cwd: string,
        timeoutMs: number,
        maxBytes: number,
      ) => Promise<{ stdout: string; exitCode: number; timedOut?: boolean; truncated?: boolean }>)
    | ((args: {
        argv: string[];
        cwd: string;
        timeoutMs: number;
        maxBytes: number;
      }) => Promise<{ stdout: string; exitCode: number; timedOut?: boolean; truncated?: boolean }>);
}

/**
 * Scans the worktree for unmodified repository files outside the diff that
 * import or reference modified source files to prevent reviewer diff tunnel vision.
 */
export async function computeExternalBlastRadius(
  worktree: string,
  changedFiles: string[],
  options?: ExternalBlastRadiusOptions,
): Promise<string> {
  try {
    const changedSet = new Set(changedFiles.map((f) => f.replace(/^\.\//, "")));
    const allSourceFiles = changedFiles
      .map((f) => f.replace(/^\.\//, ""))
      .filter(
        (f) =>
          KNOWN_EXTENSIONS.includes(extname(f)) &&
          !/\.(test|spec)\./.test(f) &&
          !f.startsWith(".git/") &&
          !f.startsWith("node_modules/") &&
          !f.startsWith("dist/"),
      );

    const totalSourceFiles = allSourceFiles.length;
    const maxFiles = options?.maxFiles ?? 25;
    const hasFileCapTruncation = totalSourceFiles > maxFiles;
    const sourceFiles = allSourceFiles.slice(0, maxFiles);

    if (totalSourceFiles === 0) {
      return "(No unmodified external callers detected)";
    }

    const tokens = new Set<string>();
    let hasIndexFile = false;

    for (const relPath of sourceFiles) {
      const ext = extname(relPath);
      const stem = basename(relPath, ext);
      if (stem === "index") {
        hasIndexFile = true;
        tokens.add("index");
        const parentDir = basename(dirname(relPath));
        if (parentDir && parentDir !== "." && parentDir !== "/" && parentDir !== "") {
          tokens.add(parentDir);
        }
      } else {
        tokens.add(stem);
      }
    }

    const escapedTokens = Array.from(tokens).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const tokenGroup = escapedTokens.join("|");
    const indexPatterns = hasIndexFile ? `|['"\`](?:\\.|\\.\\/)['"\`]` : "";
    const rgPattern = `(?:import|export|from|require)\\b[^\\n\\r]*(?:['"\`][^'"\`]*(?:\\/|\\b)(?:${tokenGroup})['"\\/\\.]${indexPatterns})`;

    const maxBytes = options?.maxBytes ?? 256 * 1024;
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const argv = [
      options?.rgBin ?? "rg",
      "-n",
      "--max-count",
      "20",
      "--max-columns",
      "200",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!.git/**",
      rgPattern,
      ".",
    ];

    let res: StreamBoundedResult;
    if (options?.producer) {
      const p = options.producer as any;
      const customRes =
        p.length === 1
          ? await p({ argv, cwd: worktree, timeoutMs, maxBytes })
          : await p(argv, worktree, timeoutMs, maxBytes);
      res = {
        stdout: customRes.stdout ?? "",
        stderr: customRes.stderr ?? "",
        exitCode: customRes.exitCode ?? 0,
        timedOut: customRes.timedOut ?? false,
        truncated: customRes.truncated ?? false,
      };
    } else {
      res = await streamBoundedProcess(argv, worktree, timeoutMs, maxBytes);
    }

    if (res.exitCode === 127) {
      return "(External blast radius scan unavailable: ripgrep not installed)";
    }
    if (res.timedOut || res.exitCode === 124) {
      return "(External blast radius scan unavailable: scan timed out)";
    }
    if (res.exitCode !== 0 && res.exitCode !== 1 && !res.truncated) {
      return "(External blast radius scan unavailable: scan error)";
    }

    if ((res.exitCode === 1 || !res.stdout.trim()) && !res.truncated) {
      if (hasFileCapTruncation) {
        return (
          `[Notice: Changed source file list truncated: scanned ${sourceFiles.length} of ${totalSourceFiles} files]\n` +
          "(No unmodified external callers detected in scanned portion)"
        );
      }
      return "(No unmodified external callers detected)";
    }

    const hitLines = res.stdout
      .trim()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    if (res.truncated && hitLines.length > 0) {
      const last = hitLines[hitLines.length - 1];
      const c1 = last.indexOf(":");
      const c2 = c1 !== -1 ? last.indexOf(":", c1 + 1) : -1;
      if (c2 === -1) {
        hitLines.pop();
      }
    }

    const groundedAliases = loadGroundedAliases(worktree);
    const callersMap = new Map<string, string[]>();
    const callersCappedMap = new Map<string, boolean>();
    const maxCallersPerFile = 8;

    for (const line of hitLines) {
      const firstColon = line.indexOf(":");
      if (firstColon === -1) continue;
      const secondColon = line.indexOf(":", firstColon + 1);
      if (secondColon === -1) continue;
      const rawHitFile = line.slice(0, firstColon);
      const lineNum = line.slice(firstColon + 1, secondColon);
      const lineText = line.slice(secondColon + 1);

      const hitFile = rawHitFile.replace(/^\.\//, "").replace(/\\/g, "/");
      if (
        !hitFile ||
        changedSet.has(hitFile) ||
        hitFile.startsWith(".git/") ||
        hitFile.startsWith("node_modules/") ||
        hitFile.startsWith("dist/")
      ) {
        continue;
      }

      const specifiers = extractImportSpecifiers(lineText);
      if (specifiers.length === 0) continue;

      for (const relPath of sourceFiles) {
        let matchesRelPath = false;
        for (const specifier of specifiers) {
          if (doesImportTargetFile(hitFile, specifier, relPath, groundedAliases)) {
            matchesRelPath = true;
            break;
          }
        }
        if (matchesRelPath) {
          const list = callersMap.get(relPath) ?? [];
          const cleanLine = `${hitFile}:${lineNum}:${lineText}`;
          if (!list.includes(cleanLine)) {
            if (list.length < maxCallersPerFile) {
              list.push(cleanLine);
              callersMap.set(relPath, list);
            } else {
              callersCappedMap.set(relPath, true);
            }
          }
        }
      }
    }

    const resultBlocks: string[] = [];
    for (const relPath of sourceFiles) {
      const hits = callersMap.get(relPath);
      if (hits && hits.length > 0) {
        const callerLines = hits.map((h) => `  - \`${h}\``);
        if (callersCappedMap.get(relPath)) {
          callerLines.push(`  - ... [additional callers for ${relPath} truncated]`);
        }
        resultBlocks.push(
          `- \`${relPath}\` is referenced outside the diff by:\n` + callerLines.join("\n"),
        );
      }
    }

    const notices: string[] = [];
    if (hasFileCapTruncation) {
      notices.push(
        `[Notice: Changed source file list truncated: scanned ${sourceFiles.length} of ${totalSourceFiles} files]`,
      );
    }
    if (res.truncated) {
      notices.push(
        `[Notice: Scan output reached byte limit of ${maxBytes} bytes; results may be partial]`,
      );
    }

    if (resultBlocks.length === 0) {
      if (notices.length > 0) {
        return `${notices.join("\n")}\n(No unmodified external callers detected in scanned portion)`;
      }
      return "(No unmodified external callers detected)";
    }

    const maxResultLines = options?.maxResultLines ?? 50;
    const allResultLines = resultBlocks.join("\n").split("\n");

    if (allResultLines.length > maxResultLines) {
      notices.push(`[Notice: External caller results truncated to ${maxResultLines} lines]`);
      const sliced = allResultLines.slice(0, maxResultLines);
      return [...notices, ...sliced].join("\n");
    }

    if (notices.length > 0) {
      return [...notices, ...allResultLines].join("\n");
    }
    return allResultLines.join("\n");
  } catch {
    return "(External blast radius scan unavailable)";
  }
}
