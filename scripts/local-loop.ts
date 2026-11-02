import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { processRun } from "./loop/process";
import { resolveRoleBudgets, interruptionReport, RoleInterrupted } from "./loop/deadlines";
import type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
  LocalLoopStatus,
} from "./loop/types";
import {
  readAnimusConfig,
  resolveModelForRole,
  resolveProviderForRole,
  resolveEffortForRole,
} from "./loop/config";
import { loadScheduleConfig } from "./loop/scheduler";
import { buildProviderArgv } from "./loop/providers";
import {
  resolveAllowedSkills,
  resolveLoopExtensions,
  buildCuratedAppendPrompts,
} from "./loop/harness-memory";
import { resolveVerificationProfile, getProfileInstructions } from "./loop/profiles";
import { evaluateCodebaseRulesOnEdit } from "../.factory/hooks/loop-guard";
import {
  recordLapAttempt,
  shouldTriggerReflection,
  saveIssueDossier,
  loadIssueDossier,
  syncDossierFindings,
  type IssueDossier,
  type LapAttemptRecord,
} from "./loop/dossier";
import { runPostIssueReflection } from "./loop/reflector";
import { deliverLearningProposal, type LearningDeliveryTransport } from "./loop/learning-delivery";
import type { LearningCommandRecord, LearningEvaluator } from "./loop/learning-schema";
import { loadPrompt, renderPrompt, resolveAnimusCommandsDir } from "./loop/prompts";
import { resolveAnimusHome, getProjectSlug } from "../packages/contracts/src/paths";
import { pollPrCiStatus } from "./loop/ci";
import {
  setupArtifactDirectories,
  parseAgentReport,
  extractReport,
  validateEvidenceCitations,
  evaluateHostReadiness,
} from "./loop/artifacts";
import {
  formatBuilderComment,
  formatCiCheckComment,
  formatReviewComment,
  renderCanonicalPrBody,
  renderEvidenceContent,
} from "./loop/pr-reporting";
import {
  publishPrEvidenceUpdate,
  publishComment,
  syncExistingEvidenceBindings,
} from "./loop/pr-publication";
import { evaluateSubticketAutoMerge } from "./loop/merge-queue";
import { parsePartOf } from "../apps/backend/src/intake/parser";

export type {
  LocalIssue,
  LoopRole,
  ProcessResult,
  AgentTransport,
  PiTransport,
  LocalLoopOptions,
  LoopEvidence,
  LocalLoopResult,
};

export {
  resolveAnimusCommandsDir,
  renderPrompt,
  parseAgentReport,
  extractReport,
  formatBuilderComment,
  extractRequiredAcIds,
};

function extractRequiredAcIds(issue: LocalIssue): string[] {
  const text = [issue.body, ...(issue.comments ?? [])].join("\n");
  const acIds = new Set<string>();

  // 1. Look for explicit checklist criteria, e.g. - [ ] AC1: or - [ ] C1: or - [ ] AC-1:
  const checkListRegex = /^[ \t]*-[ \t]*\[[ xX]?\][ \t]*\**([A-Z]{1,4}[-_]?\d+)\b/gim;
  let match: RegExpExecArray | null;
  while ((match = checkListRegex.exec(text)) !== null) {
    if (match[1]) acIds.add(match[1]);
  }

  // 2. Look for criteria line headers, e.g. AC1: or C1: or AC-1: at line start
  const lineHeaderRegex = /^[ \t]*\**([A-Z]{1,4}[-_]?\d+)\**\s*:/gim;
  while ((match = lineHeaderRegex.exec(text)) !== null) {
    if (match[1]) acIds.add(match[1]);
  }

  // 3. Look under "## Acceptance Criteria" or "Contract" sections for criteria tags
  const contractMatch = /(?:##\s*Acceptance Criteria|Contract)[\s\S]*?(?:(?=\n##\s)|$)/i.exec(text);
  if (contractMatch) {
    const sectionText = contractMatch[0];
    const sectionAcRegex = /\b(AC[-_]?\d+|C[-_]?\d+)\b/gi;
    while ((match = sectionAcRegex.exec(sectionText)) !== null) {
      if (match[1]) acIds.add(match[1].toUpperCase());
    }
  }

  return Array.from(acIds);
}
async function git(root: string, ...args: string[]): Promise<string> {
  const result = await processRun(["git", ...args], root, 30_000);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function validateIssue(issue: LocalIssue) {
  if (
    !Number.isSafeInteger(issue.number) ||
    issue.number < 1 ||
    !issue.url.endsWith(`/issues/${issue.number}`) ||
    !issue.title.trim() ||
    !issue.body.trim()
  )
    throw new Error("Incomplete issue contract");
  if (issue.activeClaim !== false) throw new Error("Issue has an active or unverified claim");
  if (
    !Array.isArray(issue.dependencies) ||
    issue.dependencies.some((d) => d.number === issue.number || d.state !== "CLOSED")
  )
    throw new Error("Issue dependencies are unresolved");
}

export async function inspectLocalLoop(root: string) {
  const common = resolve(root, await git(root, "rev-parse", "--git-common-dir"));
  const primary = (await git(root, "worktree", "list", "--porcelain"))
    .split("\n")[0]!
    .replace(/^worktree /, "");
  for (const directory of new Set([root, primary, common])) {
    for (const brake of ["STOP", "PAUSE"]) {
      if (existsSync(join(directory, ".factory", brake)))
        throw new Error(`${brake} brake is active`);
    }
  }
  return { common, primary };
}

export async function findExistingWorktreeForBranch(
  root: string,
  branch: string,
): Promise<string | null> {
  try {
    const stdout = await git(root, "worktree", "list", "--porcelain");
    const blocks = stdout.split("\n\n");
    for (const block of blocks) {
      let worktreePath = "";
      let isTargetBranch = false;
      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          worktreePath = line.slice("worktree ".length).trim();
        } else if (line === `branch refs/heads/${branch}`) {
          isTargetBranch = true;
        }
      }
      if (isTargetBranch && worktreePath && existsSync(worktreePath)) {
        return worktreePath;
      }
    }
  } catch {}
  return null;
}
export interface BuilderCommentReport {
  summary?: string;
  changes?: string[];
  checks?: Array<{
    criterion?: string;
    result?: string;
    evidence?: string;
  }>;
}

export interface EscalationReviewReport {
  reason?: string;
  outcome?: string;
  verdict?: string;
  findings?: string[];
}

export function formatEscalationHandoff(
  _issue: LocalIssue,
  lap: number,
  maxLaps: number,
  branch: string,
  isMaxLapsExceeded: boolean,
  reviewReport: EscalationReviewReport | null | undefined,
): string {
  const reasonText = isMaxLapsExceeded
    ? `Autonomous loop reached the maximum lap budget (${lap}/${maxLaps} laps).`
    : "Reviewer requested human owner intervention (needs-owner).";

  return [
    "### 🛑 Autonomous Loop Halted: Handoff to Maintainer (`ready-for-human`)",
    "",
    "This issue has been returned to human maintainers. Label updated to `ready-for-human`.",
    "",
    "#### 📌 Executive Summary:",
    `- **Status**: Halted at Lap ${lap} (max laps: ${maxLaps}). Candidate branch preserved at \`${branch}\`.`,
    `- **Escalation Reason**: ${reasonText}`,
    reviewReport?.reason ? `- **Reviewer Rationale**: ${reviewReport.reason}` : "",
    "",
    "#### 💡 Recommended Next Steps for Maintainer:",
    "1. Checkout and inspect the branch locally:",
    `   \`\`\`bash\n   git fetch origin ${branch} && git checkout ${branch}\n   \`\`\``,
    "2. Review unresolved findings above and decide whether to simplify the interface, adopt standard libraries, or accept the current baseline.",
    "3. Merge or adjust labels once resolved.",
  ]
    .filter(Boolean)
    .join("\n");
}

const KNOWN_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function extractImportSpecifiers(line: string): string[] {
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

interface GroundedAliasRule {
  scopeDir: string;
  prefix: string;
  isWildcard: boolean;
  targetDir: string;
}

function loadGroundedAliases(worktree: string): GroundedAliasRule[] {
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

function resolveGroundedAlias(
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

function doesImportTargetFile(
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

interface StreamBoundedResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
}

function streamBoundedProcess(
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

    child.once("error", (err: any) => {
      const exitCode = err.code === "ENOENT" ? 127 : 1;
      finish({
        stdout,
        stderr: stderr + (err.message || String(err)),
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

/**
 * Executes exactly ONE autonomous lap following the Animus SDLC lifecycle:
 * pick/route -> claim -> build (loop-work) -> check-app (silent QA) -> handoff/evidence -> review (loop-review) -> land gate.
 */
export async function runLocalLoop(
  root: string,
  issue: LocalIssue,
  options: LocalLoopOptions & {
    reflection?: {
      proposalEvaluator?: LearningEvaluator;
      deliveryTransport?: LearningDeliveryTransport;
    };
  } = {},
): Promise<LocalLoopResult> {
  validateIssue(issue);
  const roleBudgets = resolveRoleBudgets(options);
  const timeout = options.timeoutMs ?? 20 * 60_000;
  const { common } = await inspectLocalLoop(root);
  const animusConfig = readAnimusConfig(root);
  const defaultBaseBranch = options.baseBranch ?? animusConfig.worktree?.baseBranch ?? "main";
  const parsedPartOf = parsePartOf([issue.body, ...(issue.comments ?? [])].join("\n"));
  const partOf =
    parsedPartOf !== null && parsedPartOf > 0 && parsedPartOf !== issue.number
      ? parsedPartOf
      : undefined;
  const integrationBranch = partOf !== undefined ? `factory/spec-${partOf}-integration` : undefined;
  const baseBranch = integrationBranch ?? defaultBaseBranch;

  let remotes: string[] = [];
  try {
    const remotesOut = await git(root, "remote");
    remotes = remotesOut
      .split("\n")
      .map((r) => r.trim())
      .filter(Boolean);
  } catch {}
  const hasOrigin = remotes.includes("origin");

  let defaultBaseSha = "";
  if (hasOrigin) {
    try {
      await git(root, "fetch", "origin", defaultBaseBranch);
      defaultBaseSha = await git(root, "rev-parse", `origin/${defaultBaseBranch}`);

      // Fast-forward root defaultBaseBranch if root is clean and on defaultBaseBranch
      try {
        const currentBranch = await git(root, "symbolic-ref", "--short", "HEAD");
        if (currentBranch === defaultBaseBranch) {
          const status = await git(root, "status", "--porcelain");
          if (!status.trim()) {
            await git(root, "merge", "--ff-only", `origin/${defaultBaseBranch}`);
          }
        }
      } catch {}
    } catch {}
  }

  if (!defaultBaseSha) {
    try {
      defaultBaseSha = await git(root, "rev-parse", defaultBaseBranch);
    } catch {
      defaultBaseSha = await git(root, "rev-parse", "HEAD");
    }
  }

  let base = "";
  if (integrationBranch) {
    if (hasOrigin) {
      try {
        await git(root, "fetch", "origin", integrationBranch);
        base = await git(root, "rev-parse", `origin/${integrationBranch}`);
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, base);
      } catch {}
    }
    if (!base) {
      try {
        base = await git(root, "rev-parse", "--verify", `refs/heads/${integrationBranch}`);
      } catch {
        await git(root, "update-ref", `refs/heads/${integrationBranch}`, defaultBaseSha);
        base = defaultBaseSha;
      }
    }
    if (hasOrigin && options.push !== false) {
      try {
        await git(root, "push", "-u", "origin", `${integrationBranch}:${integrationBranch}`);
      } catch {}
    }
  } else {
    base = defaultBaseSha;
  }
  const config = await Bun.file(join(root, "harness/harness.config.json")).json();
  const checks = [config.static, config.unit].filter(
    (s): s is string => typeof s === "string" && !!s.trim(),
  );
  if (!checks.length) throw new Error("No declared ordinary project checks");
  const protectedPaths = [
    ".factory/holdout/**",
    ".factory/hooks/**",
    ".claude/settings.json",
    "harness/**",
    ...String(config.protected_paths ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  ];

  // 1. DISCOVERY & ROUTING: Check if an open PR already exists for this issue
  let existingPr: { url: string; number: number; headRefName: string } | null = null;
  const prSearch = await processRun(
    ["gh", "pr", "list", "--state", "open", "--json", "number,url,headRefName,body"],
    root,
    30_000,
  );
  if (prSearch.exitCode === 0) {
    try {
      const openPrs = JSON.parse(prSearch.stdout);
      for (const pr of openPrs) {
        if (
          pr.headRefName?.includes(`issue-${issue.number}`) ||
          pr.body?.includes(`Closes #${issue.number}`) ||
          pr.body?.includes(`Refs #${issue.number}`)
        ) {
          existingPr = { url: pr.url, number: pr.number, headRefName: pr.headRefName };
          break;
        }
      }
    } catch {}
  }

  const route: "simple" | "continue" = existingPr ? "continue" : "simple";
  if (route === "continue" && hasOrigin && existingPr) {
    try {
      await git(root, "fetch", "origin", existingPr.headRefName);
      base = await git(
        root,
        "merge-base",
        `origin/${baseBranch}`,
        `origin/${existingPr.headRefName}`,
      );
    } catch {}
  }

  const runId = randomUUID();
  const stateRoot =
    process.env.ANIMUS_HOME || process.env.ANIMUS_STATE_DIR || process.env.ANIMUS_RUNS_DIR
      ? join(resolveAnimusHome(), "projects", getProjectSlug(root))
      : join(common, "factory-local-loop");
  const runDirectory = join(stateRoot, "runs", runId);
  const { artifactsDir, handoffDir } = await setupArtifactDirectories(runDirectory);
  const lock = join(stateRoot, "locks", `issue-${issue.number}`);
  await mkdir(dirname(lock), { recursive: true });
  try {
    await mkdir(lock);
  } catch {
    const ownerFile = join(lock, "owner.json");
    let stale = false;
    if (existsSync(ownerFile)) {
      try {
        const owner = JSON.parse(readFileSync(ownerFile, "utf8"));
        if (typeof owner.pid === "number") {
          try {
            process.kill(owner.pid, 0);
          } catch {
            stale = true;
          }
        }
      } catch {}
    }
    if (stale) {
      await rm(lock, { recursive: true, force: true });
      await mkdir(lock);
    } else {
      throw new Error(`Issue ${issue.number} is locked; inspect ${lock} before manual release`);
    }
  }

  const branch = existingPr
    ? existingPr.headRefName
    : `local-loop/issue-${issue.number}-${runId.slice(0, 8)}`;
  const existingWorktree = await findExistingWorktreeForBranch(root, branch);
  const dossier = loadIssueDossier(stateRoot, issue.number);
  const lap = (dossier?.attempts.length ?? 0) + 1;
  const initialProfile = issue.verificationProfile ?? resolveVerificationProfile(issue);
  const state: LocalLoopResult = {
    runId,
    pid: process.pid,
    lap,
    issue: issue.url,
    route,
    status: "preparing",
    runDirectory,
    worktree: existingWorktree ?? join(stateRoot, "worktrees", runId),
    branch,
    base,
    partOf,
    integrationBranch,
    pr: existingPr?.url,
    verificationProfile: initialProfile,
    evidence: [],
  };

  const save = async () => {
    await Bun.write(join(runDirectory, "state.tmp"), JSON.stringify(state, null, 2));
    await rename(join(runDirectory, "state.tmp"), join(runDirectory, "state.json"));
  };

  const transport =
    options.transport ??
    options.pi ??
    ((req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));

  const recoveries: NonNullable<LapAttemptRecord["recoveries"]> = [];
  const commandRecords: LearningCommandRecord[] = [];
  const acceptedRef = defaultBaseSha;

  // Reflection uses its own report parser, but must not bypass role deadlines or checkpoints.
  const reflectionTransport: typeof transport = async (request) => {
    const role = "reflector";
    const budget = roleBudgets.reflector;
    const checkpointPath = join(handoffDir, "reflector-checkpoint.md");
    for (let attempt = 0; attempt <= (options.maxContinuations ?? 1); attempt++) {
      const startedAt = Date.now();
      const softDeadline = startedAt + budget.softMs;
      const hardDeadline = startedAt + budget.hardMs;
      const argv = [...request.argv];
      // All supported provider argv builders put the user prompt last.
      argv[argv.length - 1] += [
        "",
        "## Bounded role execution (overrides completion instructions above)",
        `Soft deadline (absolute Unix milliseconds): ${softDeadline}.`,
        `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
        `Write a durable checkpoint to ${checkpointPath} before the soft deadline: completed work, HEAD, dirty files, evidence, blockers, and exact next steps. Preserve this worktree.`,
        "After soft deadline the Pi guard permits only write/edit of that exact checkpoint path and simple read-only git status/diff/rev-parse. No git add/commit, publication, or other work is allowed.",
        "Bash defaults to 90 seconds; explicitly longer budgets are clipped to remaining hard time.",
        'If incomplete, return {"verdict":"interrupted"}; never report completed reflection for incomplete work.',
        ...(attempt
          ? [
              `Continuation ${attempt}: resume the SAME role in the SAME worktree. Read ${checkpointPath} and prior attempt artifacts first; retain all existing work.`,
            ]
          : []),
      ].join("\n");
      const result = await transport({
        ...request,
        argv,
        timeoutMs: Math.max(1, hardDeadline - Date.now()),
        env: {
          ...request.env,
          FACTORY_LOOP_SOFT_DEADLINE_MS: String(softDeadline),
          FACTORY_LOOP_HARD_DEADLINE_MS: String(hardDeadline),
          FACTORY_LOOP_CHECKPOINT_PATH: checkpointPath,
        },
      });
      const finishedAt = Date.now();
      const artifact = join(runDirectory, `${role}-attempt-${attempt}.json`);
      await Bun.write(
        artifact,
        JSON.stringify({ ...result, attempt, softDeadline, hardDeadline, finishedAt }),
      );
      const head = await git(request.cwd, "rev-parse", "HEAD");
      state.evidence.push({
        kind: (request.provider as any) ?? "agent",
        role,
        round: attempt,
        candidate: head,
        artifact,
        exitCode: result.exitCode,
        provider: request.provider,
      });
      await save();
      const timedOut =
        result.timedOut === true || result.exitCode === 124 || finishedAt >= hardDeadline;
      if (!timedOut && !interruptionReport(result.stdout)) return result;
      const reason = timedOut ? "hard deadline exceeded" : "agent checkpoint/interrupted report";
      const dirty = await git(request.cwd, "status", "--porcelain", "--untracked-files=all");
      const previous = existsSync(checkpointPath)
        ? readFileSync(checkpointPath, "utf8")
        : "# Interrupted reflector checkpoint";
      const checkpoint =
        previous +
        `\n\n## Host checkpoint: reflector attempt ${attempt}\nReason: ${reason}\nHEAD: ${head}\nStage: ${state.status}\nArtifact: ${artifact}\nWorktree: ${request.cwd}\nDirty status:\n\`\`\`\n${dirty || "(clean)"}\n\`\`\`\n`;
      await Bun.write(checkpointPath, checkpoint);
      await Bun.write(join(handoffDir, `${role}-attempt-${attempt}-checkpoint.md`), checkpoint);
      if (attempt === (options.maxContinuations ?? 1)) {
        throw new RoleInterrupted(
          `reflector interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
        );
      }
    }
    throw new RoleInterrupted("reflector continuation budget exhausted");
  };

  const reflectTerminal = async (dossier: IssueDossier) => {
    if (!shouldTriggerReflection(dossier)) return;
    const terminalStatus = state.status;
    const reflectionWorktree = join(runDirectory, "reflection-worktree");
    const fingerprint = async () => {
      const untracked = (
        await git(state.worktree, "ls-files", "--others", "--exclude-standard", "-z")
      )
        .split("\0")
        .filter(Boolean)
        .map((path) => [
          path,
          createHash("sha256")
            .update(readFileSync(join(state.worktree, path)))
            .digest("hex"),
        ]);
      return JSON.stringify([
        await git(state.worktree, "rev-parse", "HEAD"),
        await git(state.worktree, "status", "--porcelain=v1", "--untracked-files=all"),
        await git(state.worktree, "diff", "HEAD", "--binary"),
        untracked,
      ]);
    };
    let before: string | undefined;
    try {
      before = await fingerprint();
      const pinnedHead = await git(state.worktree, "rev-parse", "HEAD");
      await git(root, "worktree", "add", "--detach", reflectionWorktree, pinnedHead);
      state.status = "reflecting";
      await save();
      const evidenceRoots = Object.fromEntries(
        dossier.attempts
          .filter((attempt) => attempt.artifactsDir)
          .map((attempt) => [attempt.runId, attempt.artifactsDir!]),
      );
      const historicalCommands = dossier.attempts.flatMap(
        (attempt) => attempt.commandRecords ?? [],
      );
      const reflection = await runPostIssueReflection({
        root,
        worktree: reflectionWorktree,
        dossier,
        artifactsDir,
        transport: reflectionTransport,
        timeoutMs: roleBudgets.reflector.hardMs,
        evidenceRoots,
        commandRecords: historicalCommands,
        acceptedRef,
        proposalEvaluator: options.reflection?.proposalEvaluator,
      });
      await Bun.write(join(artifactsDir, "reflection.json"), JSON.stringify(reflection, null, 2));
      let delivered = false;
      if (reflection.status === "proposed" && reflection.proposalPath && state.candidate) {
        const delivery = await deliverLearningProposal({
          root,
          proposalPath: reflection.proposalPath,
          verifiedCandidate: state.candidate,
          baseBranch: defaultBaseBranch,
          dossier,
          evidenceRoots,
          commandRecords: historicalCommands,
          proposalEvaluator: options.reflection?.proposalEvaluator,
          sourceDeliveryPr: state.pr,
          transport: options.reflection?.deliveryTransport,
          publish: options.push !== false,
        });
        await Bun.write(
          join(artifactsDir, "learning-delivery.json"),
          JSON.stringify(delivery, null, 2),
        );
        delivered =
          delivery.status === "proposed" && (options.push === false || Boolean(delivery.prUrl));
      }
      if (before !== (await fingerprint()))
        throw new Error("Reflection changed the verified candidate or dirty state; delivery held");
      if (delivered || reflection.status === "no_entry") {
        dossier.reflectedAt = new Date().toISOString();
        saveIssueDossier(stateRoot, dossier);
      }
    } catch (error) {
      await Bun.write(
        join(artifactsDir, "reflection.json"),
        JSON.stringify(
          {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
    } finally {
      state.status = terminalStatus;
      // Git refuses removal of dirty/interrupted reflection worktrees; preserve their evidence.
      await git(root, "worktree", "remove", reflectionWorktree).catch(() => {});
    }
    if (before !== undefined && before !== (await fingerprint())) {
      throw new Error("Reflection changed the verified candidate or dirty state; delivery held");
    }
  };

  try {
    await Bun.write(
      join(lock, "owner.json"),
      JSON.stringify({
        runId,
        pid: process.pid,
        issue: issue.url,
        route,
        pr: state.pr,
        runDirectory,
        startedAt: new Date().toISOString(),
      }),
    );
    await Bun.write(join(runDirectory, "issue.json"), JSON.stringify(issue, null, 2));
    await save();

    // 2. ISOLATED WORKTREE ALLOCATION / REUSE
    if (existingWorktree) {
      if (hasOrigin) {
        await git(state.worktree, "fetch", "origin", branch).catch(() => {});
        await git(state.worktree, "fetch", "origin", baseBranch).catch(() => {});
        await git(
          state.worktree,
          "checkout",
          "-B",
          branch,
          `origin/${branch}`,
          "--ignore-other-worktrees",
        );
        await git(state.worktree, "reset", "--hard", `origin/${branch}`);
      } else {
        await git(
          state.worktree,
          "checkout",
          "-B",
          branch,
          branch,
          "--ignore-other-worktrees",
        ).catch(() => {});
      }
      await git(state.worktree, "clean", "-fd");
    } else {
      await mkdir(dirname(state.worktree), { recursive: true });
      if (route === "continue") {
        if (hasOrigin) {
          await git(root, "fetch", "origin", branch);
          await git(root, "fetch", "origin", baseBranch).catch(() => {});
        }
        await git(root, "worktree", "add", "--no-checkout", state.worktree, `origin/${branch}`);
        await git(
          state.worktree,
          "sparse-checkout",
          "set",
          "--no-cone",
          "/*",
          "!/.factory/holdout/",
        );
        await git(
          state.worktree,
          "checkout",
          "-B",
          branch,
          `origin/${branch}`,
          "--ignore-other-worktrees",
        );
      } else {
        await git(root, "worktree", "add", "--no-checkout", "-b", branch, state.worktree, base);
        await git(
          state.worktree,
          "sparse-checkout",
          "set",
          "--no-cone",
          "/*",
          "!/.factory/holdout/",
        );
        await git(state.worktree, "checkout", "--ignore-other-worktrees", branch);
      }
    }

    const assertCandidate = async (expectedCandidate?: string) => {
      await inspectLocalLoop(root);
      await inspectLocalLoop(state.worktree);
      if (await git(state.worktree, "status", "--porcelain", "--untracked-files=all"))
        throw new Error("Candidate has uncommitted or untracked changes");
      const head = await git(state.worktree, "rev-parse", "HEAD");
      if (expectedCandidate && expectedCandidate !== head)
        throw new Error("Candidate changed during verification");
      await git(state.worktree, "merge-base", "--is-ancestor", base, head);
      const changed = (await git(state.worktree, "diff", "--name-only", "--no-renames", base, head))
        .split("\n")
        .filter(Boolean);
      if (changed.some((p) => protectedPaths.some((pattern) => new Bun.Glob(pattern).match(p))))
        throw new Error("Candidate changed protected paths");

      // Deterministic codebase rules enforcement across all harnesses (Pi, Claude, Codex, OpenCode)
      for (const relPath of changed) {
        const fullPath = join(state.worktree, relPath);
        if (existsSync(fullPath)) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            const ruleCheck = evaluateCodebaseRulesOnEdit(state.worktree, relPath, content);
            if (ruleCheck.blocked) {
              throw new Error(`Candidate violated codebase rules: ${ruleCheck.reasons.join("; ")}`);
            }
          } catch (err: any) {
            if (err.message.includes("Candidate violated codebase rules")) throw err;
          }
        }
      }

      return head;
    };

    // Dynamic prompt loading with modular fallback
    const builderTemplate = loadPrompt("loop-work", root);
    const qaTemplate = loadPrompt("loop-check-app", root);
    const reviewerTemplate = loadPrompt("loop-review", root);

    const targetBaseTip = (await git(root, "rev-parse", base)).trim();
    const currentHead = (await git(state.worktree, "rev-parse", "HEAD")).trim();
    const mergeBase = (await git(state.worktree, "merge-base", base, currentHead)).trim();

    state.identities = {
      targetBaseTip,
      mergeBase,
      prHead: currentHead,
      testedHead: currentHead,
      environment: `Darwin ${process.arch} Bun ${Bun.version}`,
    };

    const holdoutPath = existsSync(join(root, ".factory/holdout/HOLDOUT.md"))
      ? join(root, ".factory/holdout/HOLDOUT.md")
      : "";

    const scheduleCfg = loadScheduleConfig(root);
    const maxLaps = scheduleCfg.max_laps ?? 3;
    const maxRejections = Math.max(1, maxLaps - 1);
    const invoke = async (
      role: LoopRole,
      candidate?: string,
      extraVars: Record<string, string> = {},
      cwdOverride?: string,
      optionsOverride?: { requiredAcIds?: string[] },
    ) => {
      await inspectLocalLoop(root);
      state.status = role === "builder" ? "building" : role === "qa" ? "qa" : "reviewing";
      await save();

      const activeCwd = cwdOverride ?? state.worktree;
      const changedFilesList = candidate
        ? (await git(activeCwd, "diff", "--name-only", "--no-renames", base, candidate)).trim()
        : "";

      const currentFiles = changedFilesList
        ? changedFilesList
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const effectiveProfile = candidate
        ? resolveVerificationProfile(
            { ...issue, verificationProfile: issue.verificationProfile },
            currentFiles,
          )
        : initialProfile;
      state.verificationProfile = effectiveProfile;
      const profileInstructions = getProfileInstructions(effectiveProfile, root);

      const template =
        role === "builder" ? builderTemplate : role === "qa" ? qaTemplate : reviewerTemplate;

      let blastRadius = "";
      if (role === "qa" || role === "reviewer") {
        blastRadius = await computeExternalBlastRadius(activeCwd, currentFiles);
      }

      let diffStat = "";
      let boundedDiff = "";
      if (role === "reviewer" && candidate) {
        try {
          diffStat = (await git(activeCwd, "diff", "--stat", base, candidate)).trim();
          const rawDiff = await git(activeCwd, "diff", "--no-renames", base, candidate);
          boundedDiff = rawDiff.split("\n").slice(0, 400).join("\n");
        } catch {
          diffStat = "(Unavailable)";
          boundedDiff = "(Unavailable)";
        }
      }

      const formattedComments = (issue.comments ?? []).join("\n\n---\n\n");
      const promptVars: Record<string, string> = {
        route,
        target: issue.url,
        pr: state.pr ?? "",
        reason: `Autonomous delivery for issue #${issue.number}: ${issue.title} [profile: ${effectiveProfile}]`,
        runtime: profileInstructions.runtimeInstructions,
        head: candidate ?? "HEAD",
        base,
        files: changedFilesList || "(all files in commit)",
        depth: profileInstructions.depth,
        profile: effectiveProfile,
        skip_app_launch: profileInstructions.skipAppLaunch ? "true" : "false",
        checks_status: existsSync(join(artifactsDir, "builder-checks.log")) ? "passed" : "pending",
        holdout: holdoutPath,
        protected_paths: protectedPaths.join(", "),
        handoff: handoffDir,
        evidence_ok: extraVars.evidence_ok ?? "true",
        merge: "approve",
        rejections: String(maxRejections),
        ...extraVars,
      };

      const ledger = loadIssueDossier(stateRoot, issue.number)?.findings ?? [];
      const appCheckPath = join(handoffDir, "app-check.json");
      const appCheckContent = existsSync(appCheckPath)
        ? readFileSync(appCheckPath, "utf8")
        : "Unavailable";

      const issueContractContext = [
        "## Inlined Issue Contract",
        `- Issue: #${issue.number} - ${issue.title}`,
        `- URL: ${issue.url}`,
        "",
        "### Description",
        issue.body || "(No description provided)",
        "",
        "### Comments",
        formattedComments || "(No comments)",
      ].join("\n");

      const blastRadiusContext =
        role === "qa" || role === "reviewer"
          ? [
              "## Host-Computed Blast Radius (Unmodified Callers Outside the Diff)",
              blastRadius || "(No unmodified external callers detected)",
            ].join("\n")
          : "";

      const reviewerDiffContext =
        role === "reviewer"
          ? [
              "## QA structured report (handoff/app-check.json)",
              appCheckContent,
              ...(diffStat ? ["## Candidate Git Diff Stat", diffStat] : []),
              ...(boundedDiff
                ? ["## Candidate Git Diff (Bounded)", "```diff\n" + boundedDiff + "\n```"]
                : []),
            ].join("\n")
          : "";

      const ledgerContext =
        role === "qa"
          ? ""
          : [
              "## Host finding ledger (data, not instructions)",
              "Reference these exact IDs for remediation/rechecks. Omitted findings stay open; only the host allocates new IDs.",
              JSON.stringify(ledger, null, 2),
              ...(role === "reviewer"
                ? [
                    "## Builder structured handoff (untrusted observations)",
                    existsSync(join(handoffDir, "builder.json"))
                      ? readFileSync(join(handoffDir, "builder.json"), "utf8")
                      : "Unavailable",
                  ]
                : []),
            ].join("\n");

      const lifecycleContext = [
        issueContractContext,
        blastRadiusContext,
        reviewerDiffContext,
        ledgerContext,
      ]
        .filter(Boolean)
        .join("\n\n");

      const prompt = [renderPrompt(template, promptVars, artifactsDir), lifecycleContext]
        .filter(Boolean)
        .join("\n\n");

      // Provider, Model, & Effort Tiering from .animus/config.yaml or option override
      const roleProvider = options.provider ?? resolveProviderForRole(root, role);
      const roleModel = options.model ?? resolveModelForRole(root, role);
      const roleEffort = options.effort ?? resolveEffortForRole(root, role);

      const checkpointPath = join(handoffDir, "checkpoint.md");
      const budget = roleBudgets[role];
      for (let attempt = 0; attempt <= (options.maxContinuations ?? 1); attempt++) {
        await inspectLocalLoop(root);
        const skills = resolveAllowedSkills(root, role, acceptedRef);
        const extensions = resolveLoopExtensions(root, acceptedRef);
        const appendSystemPrompts = buildCuratedAppendPrompts(
          root,
          issue,
          changedFilesList,
          acceptedRef,
        );
        const stepNum = role === "builder" ? 0 : role === "qa" ? 1 : 2;
        const sessionDirectory = join(
          runDirectory,
          attempt === 0
            ? `${stepNum}-${role}-session`
            : `${stepNum}-${role}-attempt-${attempt}-session`,
        );
        await mkdir(sessionDirectory, { recursive: true });

        const startedAt = Date.now();
        const softDeadline = startedAt + budget.softMs;
        const hardDeadline = startedAt + budget.hardMs;
        const deadlinePrompt = [
          prompt,
          "",
          "## Bounded role execution (overrides completion instructions above)",
          `Soft deadline (absolute Unix milliseconds): ${softDeadline} (${new Date(softDeadline).toISOString()}).`,
          `Hard deadline (absolute Unix milliseconds): ${hardDeadline}; the host terminates the owned process group then.`,
          `Write a durable checkpoint to ${checkpointPath} before the soft deadline: completed work, HEAD, dirty files, evidence, failed approaches/disproved assumptions (with probe evidence so they are never repeated), blockers, and exact next steps. Preserve this worktree.`,
          "After soft deadline the Pi guard permits only write/edit of that exact checkpoint path and simple read-only git status/diff/rev-parse. No git add/commit, publication, or other work is allowed.",
          "Bash defaults to 90 seconds; explicitly longer budgets are clipped to remaining hard time. Do not start work that cannot finish before the deadline.",
          'If incomplete, return {"verdict":"interrupted"}; never report pass for incomplete work.',
          ...(attempt
            ? [
                `Continuation ${attempt}: resume the SAME role in the SAME worktree. Read ${checkpointPath} and prior attempt artifacts first, run the baseline check yourself before editing, skip any failed approaches recorded in the checkpoint, and retain all verified work.`,
              ]
            : []),
        ].join("\n");
        const argv = buildProviderArgv(roleProvider, {
          model: roleModel,
          effort: roleEffort,
          prompt: deadlinePrompt,
          sessionDir: sessionDirectory,
          skills,
          extensions,
          appendSystemPrompts,
        });
        const result = await transport({
          argv,
          cwd: activeCwd,
          role,
          provider: roleProvider,
          timeoutMs: Math.max(1, hardDeadline - Date.now()),
          env: {
            FACTORY_LOOP_SOFT_DEADLINE_MS: String(softDeadline),
            FACTORY_LOOP_HARD_DEADLINE_MS: String(hardDeadline),
            FACTORY_LOOP_CHECKPOINT_PATH: checkpointPath,
          },
        });
        const finishedAt = Date.now();
        const artifact = join(runDirectory, `${role}-attempt-${attempt}.json`);
        await Bun.write(
          artifact,
          JSON.stringify({ ...result, attempt, softDeadline, hardDeadline, finishedAt }),
        );
        const head = (await git(activeCwd, "rev-parse", "HEAD")).trim();
        state.evidence.push({
          kind: roleProvider === "pi" ? "pi" : (roleProvider as any),
          role,
          round: attempt,
          candidate: head,
          artifact,
          exitCode: result.exitCode,
          provider: roleProvider,
          effort: roleEffort,
        });
        await save();
        const timedOut =
          result.timedOut === true || result.exitCode === 124 || finishedAt >= hardDeadline;
        if (timedOut || interruptionReport(result.stdout)) {
          const reason = timedOut
            ? "hard deadline exceeded"
            : "agent checkpoint/interrupted report";
          const dirty = await git(activeCwd, "status", "--porcelain", "--untracked-files=all");
          const facts = `\n\n## Host checkpoint: ${role} attempt ${attempt}\nReason: ${reason}\nHEAD: ${head}\nStage: ${state.status}\nArtifact: ${artifact}\nWorktree: ${activeCwd}\nDirty status:\n\`\`\`\n${dirty || "(clean)"}\n\`\`\`\n`;
          const previous = existsSync(checkpointPath)
            ? readFileSync(checkpointPath, "utf8")
            : "# Interrupted role checkpoint";
          await Bun.write(checkpointPath, previous + facts);
          await Bun.write(
            join(handoffDir, `${role}-attempt-${attempt}-checkpoint.md`),
            previous + facts,
          );
          if (attempt < (options.maxContinuations ?? 1)) {
            recoveries.push({ role, artifact, reason });
            continue;
          }
          throw new RoleInterrupted(
            `${role} interrupted: ${reason}; continuation budget exhausted; see ${checkpointPath}`,
          );
        }
        if (result.exitCode !== 0)
          throw new Error(`${roleProvider} ${role} process failed; see ${artifact}`);
        const expectedIdentity = candidate ?? head;
        return extractReport(result.stdout, expectedIdentity, role, artifactsDir, optionsOverride);
      }
      throw new RoleInterrupted(`${role} continuation budget exhausted`);
    };

    // -------------------------------------------------------------
    // STAGE 1: BUILDER (loop-work)
    // -------------------------------------------------------------
    const builderReport = await invoke("builder");
    state.candidate = await assertCandidate(builderReport.candidate);
    state.builderReport = builderReport;
    state.identities.prHead = state.candidate;
    state.identities.testedHead = state.candidate;

    await Bun.write(join(handoffDir, "builder.json"), JSON.stringify(builderReport, null, 2));
    await Bun.write(
      join(handoffDir, "builder.md"),
      `# Builder Report\n\nCandidate: ${state.candidate}\nVerdict: ${builderReport.verdict}\n\n` +
        (builderReport.checks
          ?.map((c: any) => `- ${c.criterion}: ${c.result} (${c.evidence})`)
          .join("\n") || "No explicit checks"),
    );

    if (options.push !== false) {
      try {
        await git(state.worktree, "push", "-u", "origin", branch);
        if (!state.pr) {
          const prView = await processRun(
            ["gh", "pr", "view", branch, "--json", "url"],
            state.worktree,
            15_000,
          );
          if (prView.exitCode === 0) {
            try {
              const parsed = JSON.parse(prView.stdout);
              if (parsed.url) state.pr = parsed.url;
            } catch {}
          }
        }
        if (!state.pr) {
          const body = renderCanonicalPrBody({
            issue,
            identities: state.identities,
            builderReport,
          });

          const prCreate = await processRun(
            [
              "gh",
              "pr",
              "create",
              ...(integrationBranch ? ["--base", integrationBranch] : []),
              "--head",
              branch,
              "--title",
              issue.title,
              "--body",
              body,
            ],
            state.worktree,
            30_000,
          );
          if (prCreate.exitCode === 0) {
            state.pr = prCreate.stdout.trim();
          } else {
            console.error(
              "Warning: gh pr create failed:",
              prCreate.stderr || "exit " + prCreate.exitCode,
            );
          }
        } else if (state.pr && route === "continue") {
          const builderComment = formatBuilderComment(builderReport, lap, route, state.candidate);
          try {
            await publishComment({
              repoRoot: state.worktree,
              target: { kind: "pr", idOrUrl: state.pr },
              commentType: "builder",
              commentBody: builderComment,
              candidate: state.candidate,
              runDirectory,
            });
          } catch (comErr: unknown) {
            const msg = comErr instanceof Error ? comErr.message : String(comErr);
            console.error("Warning: Builder comment publication error:", msg);
          }
          try {
            const syncedCaptures = syncExistingEvidenceBindings(
              builderReport?.captures || [],
              artifactsDir,
              state.candidate,
            );
            const newEvContent = renderEvidenceContent({
              identities: state.identities,
              builderReport,
              captures: syncedCaptures,
            });
            await publishPrEvidenceUpdate({
              repoRoot: state.worktree,
              pr: state.pr,
              candidate: state.candidate,
              newEvidenceContent: newEvContent,
              runDirectory,
            });
          } catch (pubErr: unknown) {
            const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
            console.error("Warning: Continue stage PR evidence synchronization error:", msg);
          }
        }
      } catch (pushErr: unknown) {
        const message = pushErr instanceof Error ? pushErr.message : String(pushErr);
        console.error("Warning: Git push / PR synchronization error:", message);
      }
    }

    // -------------------------------------------------------------
    // STAGE 2: ORDINARY CHECKS
    // -------------------------------------------------------------
    state.status = "checking";
    await save();
    const checkOutputs: string[] = [];
    for (let i = 0; i < checks.length; i++) {
      await inspectLocalLoop(root);
      const startedAt = new Date().toISOString();
      const result = await processRun(["sh", "-c", checks[i]!], state.worktree, timeout);
      const completedAt = new Date().toISOString();
      const artifact = join(runDirectory, `check-${i}.json`);
      const recordPath = `command-${i}.json`;
      const recordContent = JSON.stringify({ command: checks[i], ...result });
      await Bun.write(artifact, recordContent);
      await Bun.write(join(artifactsDir, recordPath), recordContent);
      commandRecords.push({
        executionId: `${runId}:check-${i}`,
        runId,
        candidate: state.candidate!,
        command: checks[i]!,
        cwd: state.worktree,
        exitCode: result.exitCode,
        startedAt,
        completedAt,
        artifact: {
          runId,
          candidate: state.candidate!,
          path: recordPath,
          lineStart: 1,
          lineEnd: 1,
          quote: recordContent,
        },
      });
      await Bun.write(
        join(artifactsDir, "host-command-records.json"),
        JSON.stringify(commandRecords, null, 2),
      );
      checkOutputs.push(
        `Check [${checks[i]}]: exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`,
      );
      state.evidence.push({
        kind: "check",
        round: 0,
        candidate: state.candidate,
        artifact,
        exitCode: result.exitCode,
      });
      if (result.exitCode !== 0) {
        throw new Error(`Ordinary project check failed: ${checks[i]}`);
      }
    }
    await Bun.write(join(artifactsDir, "builder-checks.log"), checkOutputs.join("\n\n"));
    await assertCandidate(state.candidate);

    // -------------------------------------------------------------
    // STAGE 3: BLACK-BOX QA (loop-check-app)
    // -------------------------------------------------------------
    const qaWorktreeDir = join(runDirectory, "qa-worktree");
    let testedIntegrationHead = state.candidate;
    let mergeConflictOccurred = false;

    try {
      await git(root, "worktree", "add", "--detach", qaWorktreeDir, state.candidate);
      if (
        state.identities.targetBaseTip &&
        state.identities.mergeBase &&
        state.identities.targetBaseTip !== state.identities.mergeBase
      ) {
        try {
          await git(qaWorktreeDir, "merge", "--no-edit", state.identities.targetBaseTip);
          testedIntegrationHead = (await git(qaWorktreeDir, "rev-parse", "HEAD")).trim();
        } catch (mergeErr) {
          mergeConflictOccurred = true;
          console.error(
            "Warning: Merge conflict with base branch during host integration merge:",
            mergeErr,
          );
        }
      }
    } catch (worktreeErr) {
      console.error(
        "Warning: Could not create isolated QA worktree, falling back to delivery worktree:",
        worktreeErr,
      );
    }
    state.identities.testedHead = testedIntegrationHead;

    let qaReport: any;
    if (mergeConflictOccurred) {
      qaReport = {
        head: testedIntegrationHead,
        overall: "FAIL",
        summary: "Merge conflict encountered integrating candidate with default base branch",
        lines: [
          {
            id: "C0",
            kind: "criterion",
            verdict: "FAIL",
            text: "Merge conflict with base branch",
            evidence: [],
          },
        ],
        noticed: [],
        captures: [],
        passed: false,
      };
    } else {
      const requiredAcIds = extractRequiredAcIds(issue);
      const activeQaCwd = existsSync(qaWorktreeDir) ? qaWorktreeDir : state.worktree;
      qaReport = await invoke(
        "qa",
        testedIntegrationHead,
        {
          tested_head: testedIntegrationHead,
          base_tip: state.identities.targetBaseTip,
          merge_base: state.identities.mergeBase,
          merged_with: state.identities.targetBaseTip,
        },
        activeQaCwd,
        { requiredAcIds },
      );
    }
    state.qaReport = qaReport;

    if (existsSync(qaWorktreeDir)) {
      try {
        const qaHeadAfter = (await git(qaWorktreeDir, "rev-parse", "HEAD")).trim();
        const qaDirty = (await git(qaWorktreeDir, "status", "--porcelain")).trim();
        if (!qaDirty && qaHeadAfter === testedIntegrationHead) {
          await git(root, "worktree", "remove", "--force", qaWorktreeDir).catch(() => {});
        } else {
          console.log(`Preserving QA worktree at ${qaWorktreeDir} for diagnosis`);
        }
      } catch {}
    }

    await assertCandidate(state.candidate);

    await Bun.write(join(handoffDir, "app-check.json"), JSON.stringify(qaReport, null, 2));
    await Bun.write(join(artifactsDir, "app-check.json"), JSON.stringify(qaReport, null, 2));

    const { ok: evidenceOkBool, problems: evidenceProblems } = validateEvidenceCitations(
      qaReport,
      artifactsDir,
    );
    await Bun.write(join(handoffDir, "evidence-problems.txt"), evidenceProblems.join("\n"));
    const evidenceOk = evidenceOkBool ? "true" : "false";

    if (state.pr && options.push !== false) {
      try {
        const syncedCaptures = syncExistingEvidenceBindings(
          qaReport?.captures || [],
          artifactsDir,
          state.candidate,
        );
        const newEvContent = renderEvidenceContent({
          identities: state.identities,
          qaReport,
          builderReport,
          captures: syncedCaptures,
        });
        await publishPrEvidenceUpdate({
          repoRoot: state.worktree,
          pr: state.pr,
          candidate: state.candidate,
          newEvidenceContent: newEvContent,
          runDirectory,
        });
      } catch (pubErr: unknown) {
        const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
        console.error("Warning: QA stage PR evidence synchronization error:", msg);
      }
    }

    // -------------------------------------------------------------
    // STAGE 3.5: PR CI CHECK GATE (Fail-fast if remote CI already failed)
    // -------------------------------------------------------------
    const prTarget = state.pr ?? (options.checkPrCi ? "mock-pr" : undefined);
    if (prTarget && (options.push !== false || options.checkPrCi)) {
      if (!state.pr && options.checkPrCi) {
        state.pr = prTarget;
      }
      const ciTimeoutSeconds = options.ciWaitSeconds ?? 15;
      const ciAssessment = options.checkPrCi
        ? await options.checkPrCi(prTarget, { cwd: state.worktree })
        : await pollPrCiStatus(prTarget, {
            maxWaitSeconds: ciTimeoutSeconds,
            pollIntervalSeconds: 5,
            cwd: state.worktree,
          });

      await Bun.write(join(artifactsDir, "pr-ci.json"), JSON.stringify(ciAssessment, null, 2));

      if (ciAssessment.status === "fail") {
        const isMaxLapsExceeded = lap >= maxLaps;
        const ciStatus: LocalLoopStatus = isMaxLapsExceeded ? "needs_owner" : "sent_back";
        state.status = ciStatus;

        if (ciStatus === "needs_owner") {
          try {
            await processRun(
              [
                "gh",
                "issue",
                "edit",
                String(issue.number),
                "--add-label",
                "ready-for-human",
                "--remove-label",
                "ready-for-agent",
              ],
              state.worktree,
              15_000,
            );
          } catch (lblErr: unknown) {
            const msg = lblErr instanceof Error ? lblErr.message : String(lblErr);
            console.error("Warning: Failed to update GitHub issue labels on CI escalation:", msg);
          }
        }

        const changedFilesFinal = (
          await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
        )
          .split("\n")
          .filter(Boolean);

        const dossier = recordLapAttempt(
          stateRoot,
          {
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueUrl: issue.url,
            branch,
            prUrl: state.pr,
          },
          {
            runId,
            timestamp: new Date().toISOString(),
            status: ciStatus,
            candidateHead: state.candidate,
            artifactsDir,
            evidence: [...state.evidence],
            commandRecords: [...commandRecords],
            recoveries: [...recoveries],
            changedFiles: changedFilesFinal,
            failedStage: "ci",
            reviewFindings: ciAssessment.failedChecks.map(
              (c: any) =>
                `CI Check [${c.workflow ? c.workflow + " / " : ""}${c.name}] failed: ${c.link || c.state}`,
            ),
            qaFailures: [],
          },
        );

        await reflectTerminal(dossier);

        const ciComment = formatCiCheckComment({
          route,
          candidate: state.candidate,
          failedChecks: ciAssessment.failedChecks,
          isMaxLapsExceeded,
        });

        if (state.pr) {
          try {
            await publishComment({
              repoRoot: state.worktree,
              target: { kind: "pr", idOrUrl: state.pr },
              commentType: "ci_check",
              commentBody: ciComment,
              candidate: state.candidate,
              runDirectory,
            });
          } catch (ciErr: unknown) {
            const msg = ciErr instanceof Error ? ciErr.message : String(ciErr);
            console.error("Warning: Failed to publish CI check comment on PR:", msg);
          }

          if (options.push !== false) {
            try {
              const syncedCaptures = syncExistingEvidenceBindings(
                qaReport?.captures || [],
                artifactsDir,
                state.candidate,
              );
              const newEvContent = renderEvidenceContent({
                identities: state.identities,
                qaReport,
                builderReport,
                captures: syncedCaptures,
                outstanding: ciAssessment.failedChecks.map(
                  (c: any) => `CI Check [${c.name}] failed`,
                ),
              });
              await publishPrEvidenceUpdate({
                repoRoot: state.worktree,
                pr: state.pr,
                candidate: state.candidate,
                newEvidenceContent: newEvContent,
                runDirectory,
              });
            } catch (pubErr: unknown) {
              const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
              console.error("Warning: CI stage PR evidence synchronization error:", msg);
            }
          }
        } else if (options.push !== false) {
          try {
            await publishComment({
              repoRoot: state.worktree,
              target: { kind: "issue", idOrUrl: issue.number },
              commentType: "ci_check",
              commentBody: ciComment,
              candidate: state.candidate,
              runDirectory,
            });
          } catch (issueComErr: unknown) {
            const msg = issueComErr instanceof Error ? issueComErr.message : String(issueComErr);
            console.error("Warning: Failed to publish CI check comment on issue:", msg);
          }
        }

        await save();
        return state;
      }
    }

    // -------------------------------------------------------------
    // STAGE 4: CODE REVIEW (loop-review)
    // -------------------------------------------------------------
    const reviewReport = await invoke("reviewer", state.candidate, { evidence_ok: evidenceOk });
    state.reviewerReport = reviewReport;
    await assertCandidate(state.candidate);
    await Bun.write(join(artifactsDir, "review.json"), JSON.stringify(reviewReport, null, 2));

    const initialDossier = loadIssueDossier(stateRoot, issue.number) ?? {
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.url,
      branch,
      prUrl: state.pr,
      attempts: [],
    };
    const syncedFindings = syncDossierFindings(
      initialDossier,
      Array.isArray(reviewReport.findings) ? reviewReport.findings : [],
      Array.isArray(reviewReport.dispositions) ? reviewReport.dispositions : [],
      Array.isArray(reviewReport.rechecks) ? reviewReport.rechecks : [],
      lap,
      { candidate: state.candidate, artifactsDir },
    );

    const readiness = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport,
      reviewerReport: reviewReport,
      ciPassed: true,
      lap,
      maxLaps,
      expectedCandidate: state.candidate,
      outstandingFindings: syncedFindings,
    });

    const isApproved = Boolean(qaReport.passed && reviewReport.passed && readiness.ready);
    const isExplicitNeedsOwner =
      reviewReport.outcome === "needs-owner" || reviewReport.verdict === "needs_owner";
    const isMaxLapsExceeded = !isApproved && lap >= maxLaps;
    const isNeedsOwner = !isApproved && (isExplicitNeedsOwner || isMaxLapsExceeded);

    let reviewOutcome = isApproved ? "approved" : isNeedsOwner ? "needs owner" : "sent back";
    let finalStatus: LocalLoopStatus = isApproved
      ? "waiting_approval"
      : isNeedsOwner
        ? "needs_owner"
        : "sent_back";
    state.findings = syncedFindings;

    const changedFilesFinal = (
      await git(state.worktree, "diff", "--name-only", "--no-renames", base, state.candidate)
    )
      .split("\n")
      .filter(Boolean);

    const diffContentFinal = await git(
      state.worktree,
      "diff",
      "--no-renames",
      base,
      state.candidate,
    );

    const autoMergeEval = evaluateSubticketAutoMerge({
      isSubticket: partOf !== undefined,
      targetBranch: baseBranch,
      baseBranch: defaultBaseBranch,
      readinessReady: isApproved,
      reviewerReport: reviewReport,
      changedFiles: changedFilesFinal,
      diffContent: diffContentFinal,
      protectedPaths,
    });
    state.autoMerge = autoMergeEval;
    await Bun.write(
      join(artifactsDir, "auto-merge-judgement.json"),
      JSON.stringify(autoMergeEval, null, 2),
    );

    if (isApproved && autoMergeEval.authorized && integrationBranch) {
      try {
        await assertCandidate(state.candidate);
        const currentIntTip = (
          await git(root, "rev-parse", `refs/heads/${integrationBranch}`)
        ).trim();
        if (currentIntTip !== state.identities.targetBaseTip) {
          throw new Error(
            `Integration branch '${integrationBranch}' drifted from '${state.identities.targetBaseTip}' to '${currentIntTip}' during verification; holding for human merge.`,
          );
        }

        const rootHeadBranch = await git(root, "symbolic-ref", "--short", "HEAD").catch(() => "");
        if (rootHeadBranch === integrationBranch) {
          await git(root, "merge", "--ff-only", state.candidate);
        } else {
          await git(
            root,
            "update-ref",
            `refs/heads/${integrationBranch}`,
            state.candidate,
            state.identities.targetBaseTip,
          );
        }

        if (options.push !== false) {
          if (state.pr) {
            await processRun(
              ["gh", "pr", "merge", state.pr, "--squash", "--match-head-commit", state.candidate],
              state.worktree,
              30_000,
            ).catch(() => {});
          }
          if (hasOrigin) {
            await git(
              root,
              "push",
              "origin",
              `refs/heads/${integrationBranch}:refs/heads/${integrationBranch}`,
            ).catch(() => {});
          }
          await processRun(
            [
              "gh",
              "issue",
              "close",
              String(issue.number),
              "--comment",
              `Auto-merged into integration branch \`${integrationBranch}\` at commit \`${state.candidate}\`.`,
            ],
            state.worktree,
            15_000,
          ).catch(() => {});

          if (partOf !== undefined) {
            try {
              const openIssuesRes = await processRun(
                ["gh", "issue", "list", "--state", "open", "--json", "number,body"],
                root,
                15_000,
              );
              if (openIssuesRes.exitCode === 0) {
                const openIssues = JSON.parse(openIssuesRes.stdout) as Array<{
                  number: number;
                  body?: string;
                }>;
                const remainingSiblings = openIssues.filter(
                  (i) =>
                    i.number !== issue.number &&
                    i.number !== partOf &&
                    parsePartOf(i.body ?? "") === partOf,
                );
                if (remainingSiblings.length === 0) {
                  const existingFinalPr = await processRun(
                    [
                      "gh",
                      "pr",
                      "list",
                      "--state",
                      "open",
                      "--head",
                      integrationBranch,
                      "--base",
                      defaultBaseBranch,
                      "--json",
                      "url",
                    ],
                    root,
                    15_000,
                  );
                  let finalPrUrl: string | undefined;
                  if (existingFinalPr.exitCode === 0) {
                    const parsedPrs = JSON.parse(existingFinalPr.stdout) as Array<{ url?: string }>;
                    finalPrUrl = parsedPrs[0]?.url;
                  }
                  if (!finalPrUrl) {
                    const createFinal = await processRun(
                      [
                        "gh",
                        "pr",
                        "create",
                        "--base",
                        defaultBaseBranch,
                        "--head",
                        integrationBranch,
                        "--title",
                        `feat(spec-${partOf}): integrated delivery for spec #${partOf}`,
                        "--body",
                        `Closes #${partOf}\n\nAll subticket PRs for spec #${partOf} have been verified and integrated into \`${integrationBranch}\`. Ready for human review.`,
                      ],
                      root,
                      30_000,
                    );
                    if (createFinal.exitCode === 0) {
                      finalPrUrl = createFinal.stdout.trim();
                    }
                  }
                  if (finalPrUrl) {
                    state.finalIntegrationPr = finalPrUrl;
                  }
                }
              }
            } catch {}
          }
        }

        finalStatus = "merged";
        reviewOutcome = "merged";
      } catch (mergeErr: unknown) {
        const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        autoMergeEval.authorized = false;
        autoMergeEval.decision = "hold_for_human";
        autoMergeEval.reasons.push(msg);
        state.autoMerge = autoMergeEval;
        await Bun.write(
          join(artifactsDir, "auto-merge-judgement.json"),
          JSON.stringify(autoMergeEval, null, 2),
        );
      }
    }

    if (finalStatus === "needs_owner") {
      try {
        await processRun(
          [
            "gh",
            "issue",
            "edit",
            String(issue.number),
            "--add-label",
            "ready-for-human",
            "--remove-label",
            "ready-for-agent",
          ],
          state.worktree,
          15_000,
        );
      } catch (lblErr: unknown) {
        const msg = lblErr instanceof Error ? lblErr.message : String(lblErr);
        console.error("Warning: Failed to update GitHub issue labels on escalation:", msg);
      }
    }

    const dossier = recordLapAttempt(
      stateRoot,
      {
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.url,
        branch,
        prUrl: state.pr,
      },
      {
        runId,
        timestamp: new Date().toISOString(),
        status: finalStatus,
        candidateHead: state.candidate,
        artifactsDir,
        evidence: [...state.evidence],
        commandRecords: [...commandRecords],
        recoveries: [...recoveries],
        changedFiles: changedFilesFinal,
        failedStage: isApproved ? undefined : !qaReport.passed ? "qa" : "reviewer",
        reviewFindings: syncedFindings.map((f) =>
          typeof f === "string" ? f : `[${f.id}] ${f.title}`,
        ),
        structuredFindings: syncedFindings,
        qaFailures: Array.isArray(qaReport.checks)
          ? qaReport.checks
              .filter((c: any) => c.result !== "pass")
              .map((c: any) => `${c.criterion}: ${c.evidence}`)
          : [],
      },
    );

    state.status = finalStatus;
    await reflectTerminal(dossier);

    const reviewComment = formatReviewComment({
      outcome: reviewOutcome,
      route,
      candidate: state.candidate,
      blastRadiusCount: changedFilesFinal.length,
      qaReport,
      reviewerReport: reviewReport,
      dossierFindings: syncedFindings,
      isNeedsOwner,
      handoffProse: isNeedsOwner
        ? formatEscalationHandoff(issue, lap, maxLaps, branch, isMaxLapsExceeded, reviewReport)
        : undefined,
      autoMerge: state.autoMerge,
    });

    if (state.pr) {
      try {
        const commentResult = await publishComment({
          repoRoot: state.worktree,
          target: { kind: "pr", idOrUrl: state.pr },
          commentType: "review",
          commentBody: reviewComment,
          candidate: state.candidate,
          runDirectory,
        });
        if (commentResult.commentUrl) {
          state.reviewCommentUrl = commentResult.commentUrl;
        }
      } catch (comErr: unknown) {
        const msg = comErr instanceof Error ? comErr.message : String(comErr);
        console.error("Warning: Review comment publication error:", msg);
      }

      if (options.push !== false) {
        try {
          const syncedCaptures = syncExistingEvidenceBindings(
            qaReport?.captures || [],
            artifactsDir,
            state.candidate,
          );
          const judgeAlterations =
            Array.isArray(reviewReport.judge_changes) && reviewReport.judge_changes.length > 0
              ? reviewReport.judge_changes.map(
                  (jc: any) => `${jc.file || jc.path || ""}: ${jc.description || jc.reason || ""}`,
                )
              : undefined;
          const outstanding = !readiness.ready ? readiness.reasons : [];
          const newEvContent = renderEvidenceContent({
            identities: state.identities,
            qaReport,
            builderReport,
            captures: syncedCaptures,
            outstanding,
            judgeAlterations,
            autoMerge: state.autoMerge,
          });
          await publishPrEvidenceUpdate({
            repoRoot: state.worktree,
            pr: state.pr,
            candidate: state.candidate,
            newEvidenceContent: newEvContent,
            runDirectory,
          });
        } catch (pubErr: unknown) {
          const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
          console.error("Warning: Review stage PR evidence synchronization error:", msg);
        }
      }
    } else if (options.push !== false) {
      try {
        await publishComment({
          repoRoot: state.worktree,
          target: { kind: "issue", idOrUrl: issue.number },
          commentType: isNeedsOwner ? "escalation" : "review",
          commentBody: reviewComment,
          candidate: state.candidate,
          runDirectory,
        });
      } catch (issueComErr: unknown) {
        const msg = issueComErr instanceof Error ? issueComErr.message : String(issueComErr);
        console.error("Warning: Issue review/escalation comment publication error:", msg);
      }
    }

    await save();
    return state;
  } catch (error) {
    const isInterrupted = error instanceof RoleInterrupted;
    state.error = error instanceof Error ? error.message : String(error);
    if (isInterrupted) {
      state.status = "interrupted";
      await save();
      return state;
    }

    const scheduleCfg = loadScheduleConfig(root);
    const maxLaps = scheduleCfg.max_laps ?? 3;
    const isExceeded = lap >= maxLaps;
    const finalErrorStatus: LocalLoopStatus = isExceeded ? "needs_owner" : "failed";
    state.status = finalErrorStatus;

    if (isExceeded) {
      try {
        await processRun(
          [
            "gh",
            "issue",
            "edit",
            String(issue.number),
            "--add-label",
            "ready-for-human",
            "--remove-label",
            "ready-for-agent",
          ],
          root,
          15_000,
        );
      } catch (lblErr: unknown) {
        const msg = lblErr instanceof Error ? lblErr.message : String(lblErr);
        console.error("Warning: Failed to update GitHub issue labels on error escalation:", msg);
      }
    }

    try {
      const dossier = recordLapAttempt(
        stateRoot,
        {
          issueNumber: issue.number,
          issueTitle: issue.title,
          issueUrl: issue.url,
          branch,
          prUrl: state.pr,
        },
        {
          runId,
          timestamp: new Date().toISOString(),
          status: finalErrorStatus,
          candidateHead: state.candidate,
          artifactsDir,
          evidence: [...state.evidence],
          commandRecords: [...commandRecords],
          recoveries: [...recoveries],
          changedFiles: [],
          failedStage: state.evidence.some((e) => e.kind === "check" && e.exitCode !== 0)
            ? "ordinary_checks"
            : "builder",
          errorExcerpt: state.error,
          reviewFindings: [],
          qaFailures: [],
        },
      );
      await reflectTerminal(dossier);
    } catch (reflectionError: unknown) {
      if (reflectionError instanceof RoleInterrupted) {
        state.status = "interrupted";
        state.error = reflectionError.message;
      }
    }
    await save();
    return state;
  } finally {
    try {
      await Bun.spawn(["rm", "-rf", lock]).exited;
    } catch {}
  }
}
