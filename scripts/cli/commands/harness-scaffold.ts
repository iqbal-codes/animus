import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAnimusSkillsHome } from "@animus/contracts/paths";
import type { DetectedRepoCommands } from "./setup";

export interface AgentsMdAudit {
  exists: boolean;
  path: string;
  lineCount: number;
  status: "missing" | "present";
  hasCanonicalPointers: boolean;
  missingSections: string[];
  issues: string[];
}

export interface HarnessAuditReport {
  repoRoot: string;
  projectMode: "greenfield" | "brownfield";
  agentsMd: AgentsMdAudit;
  claudeMdSymlink: boolean;
  skillsInstalled: string[];
  learnedSkills: string[];
  claudeSkillsSymlink: boolean;
  skillsMode?: "external" | "repo";
  machineSkillsAvailable?: string[];
  hooksInstalled: {
    loopGuard: boolean;
    holdoutFence: boolean;
    claudeSettings: boolean;
    piSettings: boolean;
    ompSettings: boolean;
  };
  governanceFiles: {
    lessonsJsonl: boolean;
    toolGuidanceJson: boolean;
    codebaseRulesJson: boolean;
    holdoutMd: boolean;
    ignoreFile: boolean;
    harnessCiRunner: boolean;
  };
}

export interface ScaffoldHarnessOptions {
  targetRepoRoot: string;
  factorySourceRoot?: string;
  detectedCommands: DetectedRepoCommands;
  agentsMdAction?: "keep" | "overwrite";
  skillsMode?: "external" | "repo";
}

export interface ScaffoldHarnessResult {
  auditBefore: HarnessAuditReport;
  agentsMdActionTaken: "created" | "overwritten" | "kept";
  agentsMdBackupPath?: string;
  createdOrUpdatedPaths: string[];
  skillsCopied: string[];
  skillsMode: "external" | "repo";
}

const REQUIRED_SKILL_POINTERS = [
  { key: ".agents/skills/", label: "Repository skills directory (.agents/skills/)" },
  { key: "tool-guidance.json", label: "Verified tool guidance (.animus/tool-guidance.json)" },
  { key: "lessons.jsonl", label: "Evidence-backed lessons (.animus/lessons.jsonl)" },
  { key: "tdd", label: "TDD / Red-Green execution rule (.agents/skills/tdd)" },
];

export function auditAgentsMd(repoRoot: string): AgentsMdAudit {
  const path = join(repoRoot, "AGENTS.md");
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      lineCount: 0,
      status: "missing",
      hasCanonicalPointers: false,
      missingSections: REQUIRED_SKILL_POINTERS.map((r) => r.label),
      issues: ["AGENTS.md does not exist in this repository."],
    };
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const lineCount = lines.length;
  const issues: string[] = [];
  const missingSections: string[] = [];

  for (const req of REQUIRED_SKILL_POINTERS) {
    if (!content.includes(req.key)) {
      missingSections.push(req.label);
    }
  }

  if (lineCount > 150) {
    issues.push(
      `AGENTS.md exceeds the 150-line context budget (${lineCount} lines); progressive disclosure is needed.`,
    );
  }

  if (missingSections.length > 0) {
    issues.push(`Missing factory harness pointers: ${missingSections.join(", ")}`);
  }

  return {
    exists: true,
    path,
    lineCount,
    status: "present",
    hasCanonicalPointers: missingSections.length === 0,
    missingSections,
    issues,
  };
}

export const CANONICAL_SKILL_CATALOG = [
  ["animus-triage", "Repository-grounded issue triage and executable-brief playbook."],
  ["animus-ask", "Repository skill router and interactive assistance playbook."],
  ["animus-setup", "Repository setup, onboarding, and environment readiness playbook."],
  ["tdd", "Test-driven development red-green-refactor playbook."],
  ["diagnosing-bugs", "Systematic root-cause bug diagnosis playbook."],
  ["unstick", "Two-strike failure recovery and premise probing playbook."],
  ["blueprint", "Type-first architecture and Level 4 blast-radius verification playbook."],
  ["ui-quality", "Intentional frontend design, 7-state coverage, and viewport audit playbook."],
  ["animus-implement", "Autonomous builder implementation playbook."],
  ["animus-implement-spec", "Multi-ticket spec implementation coordinator playbook."],
  ["animus-review", "Independent code review and evidence verification playbook."],
  ["animus-harness", "Interactive repository harness setup, toolchain verification, and self-check playbook."],
  ["animus-learn", "Post-lap memory, tool guidance, and lesson synthesis playbook."],
  ["animus-brainstorm", "Shape a broad product or initiative idea into an ordered slice map."],
  ["animus-grill", "Stress-test a single product slice top-down across altitude gates."],
  ["animus-spec", "Synthesize agreed discussion into a software factory specification."],
  ["animus-architecture", "Derive tech stack, module topology, and reusable components from product specs."],
  ["animus-tickets", "Split an agreed spec into vertical tickets with parser-readable dependencies."],
  ["pr", "Autonomous and operator pull request authoring and evidence contract playbook."],
  ["retro", "Autonomous retrospective and post-lap reflection synthesis playbook."],
  ["policy-verifier-regressions", "Learned repository policy verifier regression playbook."],
  ["security-hardening", "Harden software against vulnerabilities, validate trust boundaries, enforce least privilege, and prevent OWASP Top 10 defects."],
  ["writing-for-agents", "Authoring concise, positive imperative agent instructions."],
  ["skill-creator", "Creating structured procedural skills with completion criteria."],
] as const;

export const CANONICAL_SKILL_NAMES = CANONICAL_SKILL_CATALOG.map(([name]) => name);

export function auditRepositoryHarness(repoRoot: string): HarnessAuditReport {
  const root = resolve(repoRoot);
  const agentsMd = auditAgentsMd(root);

  const hasExistingCode =
    existsSync(join(root, "package.json")) ||
    existsSync(join(root, "Cargo.toml")) ||
    existsSync(join(root, "go.mod")) ||
    existsSync(join(root, "pyproject.toml")) ||
    existsSync(join(root, "requirements.txt")) ||
    existsSync(join(root, "src"));

  const projectMode: "greenfield" | "brownfield" =
    hasExistingCode || agentsMd.exists ? "brownfield" : "greenfield";

  const claudeMdPath = join(root, "CLAUDE.md");
  let claudeMdSymlink = false;
  try {
    claudeMdSymlink = lstatSync(claudeMdPath).isSymbolicLink() || existsSync(claudeMdPath);
  } catch {}

  const claudeSkillsPath = join(root, ".claude/skills");
  let claudeSkillsSymlink = false;
  try {
    claudeSkillsSymlink =
      lstatSync(claudeSkillsPath).isSymbolicLink() || existsSync(claudeSkillsPath);
  } catch {}

  const canonicalSet = new Set<string>(CANONICAL_SKILL_NAMES);
  const skillsInstalled = CANONICAL_SKILL_NAMES.filter((name) =>
    existsSync(join(root, ".agents/skills", name, "SKILL.md")),
  );

  const learnedSkills: string[] = [];
  const skillsDir = join(root, ".agents/skills");
  if (existsSync(skillsDir)) {
    try {
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || canonicalSet.has(entry.name)) continue;
        if (existsSync(join(skillsDir, entry.name, "SKILL.md"))) {
          learnedSkills.push(entry.name);
        }
      }
    } catch {}
  }

  const machineSkillsDir = resolveAnimusSkillsHome();
  const machineSkillsAvailable: string[] = [];
  if (existsSync(machineSkillsDir)) {
    try {
      for (const name of CANONICAL_SKILL_NAMES) {
        if (existsSync(join(machineSkillsDir, name, "SKILL.md"))) {
          machineSkillsAvailable.push(name);
        }
      }
    } catch {}
  }
  const skillsMode: "external" | "repo" = skillsInstalled.length > 0 ? "repo" : "external";

  return {
    repoRoot: root,
    projectMode,
    agentsMd,
    claudeMdSymlink,
    skillsInstalled,
    learnedSkills,
    claudeSkillsSymlink,
    skillsMode,
    machineSkillsAvailable,
    hooksInstalled: {
      loopGuard:
        existsSync(join(root, ".animus/hooks/loop-guard.ts")) ||
        existsSync(join(root, ".factory/hooks/loop-guard.ts")),
      holdoutFence:
        existsSync(join(root, ".animus/hooks/holdout_fence.py")) ||
        existsSync(join(root, ".factory/hooks/holdout_fence.py")),
      claudeSettings: existsSync(join(root, ".claude/settings.json")),
      piSettings: existsSync(join(root, ".pi/settings.json")),
      ompSettings: existsSync(join(root, ".omp/settings.json")),
    },
    governanceFiles: {
      lessonsJsonl:
        existsSync(join(root, ".animus/lessons.jsonl")) ||
        existsSync(join(root, ".factory/lessons.jsonl")),
      toolGuidanceJson:
        existsSync(join(root, ".animus/tool-guidance.json")) ||
        existsSync(join(root, ".factory/tool-guidance.json")),
      codebaseRulesJson:
        existsSync(join(root, ".animus/codebase-rules.json")) ||
        existsSync(join(root, ".factory/codebase-rules.json")),
      holdoutMd:
        existsSync(join(root, ".animus/holdout/HOLDOUT.md")) ||
        existsSync(join(root, ".factory/holdout/HOLDOUT.md")),
      ignoreFile: existsSync(join(root, ".ignore")),
      harnessCiRunner: existsSync(join(root, "harness/ci.ts")),
    },
  };
}

export function generateCanonicalAgentsMd(
  repoRoot: string,
  commands: DetectedRepoCommands,
): string {
  const projectName = basename(resolve(repoRoot)) || "Repository";
  const sourceRoot = resolveFactorySourceRoot();
  const templatePath = sourceRoot
    ? existsSync(join(sourceRoot, "templates/AGENTS.template.md"))
      ? join(sourceRoot, "templates/AGENTS.template.md")
      : existsSync(join(sourceRoot, "factory/templates/AGENTS.template.md"))
        ? join(sourceRoot, "factory/templates/AGENTS.template.md")
        : null
    : null;

  if (templatePath && existsSync(templatePath)) {
    const rawTemplate = readFileSync(templatePath, "utf-8");
    const rendered = rawTemplate
      .replaceAll("$PROJECT_NAME", projectName)
      .replaceAll("$STATIC_CHECK", commands.staticCheck)
      .replaceAll("$UNIT_TEST", commands.unitTest)
      .trimEnd();
    return rendered + "\n";
  }

  const lines: string[] = [
    `# ${projectName} — Autonomous Software Factory Agent Instructions`,
    "",
    "## Core Philosophy",
    "",
    "- **Effective > cheap**: Ship production-grade solutions with complete edge-case coverage.",
    "- **Fail closed**: Unverified or unlabeled work is held; errors fail closed to preserve execution safety.",
    "- **Progressive disclosure**: Keep base instructions lean (<= 150 lines); consult specialized context pointers below when triggered.",
    "",
    "## Repository Knowledge, Skills & Memory",
    "",
    "- **Canonical Configuration**: \`AGENTS.md\` and \`.agents/skills/\` are authoritative sources of truth (\`CLAUDE.md -> AGENTS.md\`, \`.claude/skills -> ../.agents/skills\`).",
    "- **Stage & Workflow Boundary**: Stage playbooks in \`.agents/skills/\` are strictly user- or engine-invoked (\`disable-model-invocation: true\`). Never self-invoke, chain, or combine stage playbooks unless explicitly requested for the current turn.",
    "- **Verified Tool Guidance**: Inspect \`.animus/tool-guidance.json\` for validated CLI recipes (\`static\`: \`" +
      commands.staticCheck +
      "\`, \`unit\`: \`" +
      commands.unitTest +
      "\`).",
    "- **Evidence-Backed Lessons**: Inspect \`.animus/lessons.jsonl\` for repository-specific gotchas matching target files before editing.",
    "- **Harness Authoring Standard**: Adhere to \`docs/agents/harness-authoring-standard.md\` when curating lessons, rules, or skills.",
    "- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when \`.animus/NO_HARNESS_MEMORY\` is present.",
    "",
    "## Domain & Workflow Documentation",
    "",
    "- **PR & Evidence Contract**: Read \`docs/agents/pr-evidence-contract.md\` for canonical PR bodies, evidence matrices, Before/After captures, and finding rechecks.",
    "- **Issue Tracker, Dependencies & Triage Labels**: Read \`docs/agents/issue-tracker.md\` for \`gh\` conventions, \`Depends on:\` rules, and canonical triage labels. Labels are visibility hints; admission is frozen at import and dependency release requires verified lineage, never issue closure.",
    "- **Domain Models & ADRs**: Read \`docs/agents/domain.md\`, \`GLOSSARY.md\`, and \`docs/adr/\` before modifying domain models or architectural boundaries.",
    "- **Document Lifecycle**: \`docs/README.md\` indexes every document with \`Status: Active|Draft|Historical|Superseded\`. Implement only from \`Active\`; treat \`Historical\` and \`Superseded\` as provenance, follow the named replacement for superseded work, and never add an unindexed file under \`docs/\`.",
    "",
    "## Execution Rules",
    "",
    "- **Red -> Green Loop**: Write failing tests first at public seams using \`.agents/skills/tdd/SKILL.md\`, then implement minimal passing code.",
    "- **Protected Governance Paths**: Keep \`harness/**\`, \`.animus/holdout/**\`, and \`.animus/hooks/**\` untouched during delivery laps.",
    "- **Clean Cutover**: Migrate all callers when modifying contracts; keep one canonical implementation without dead shims.",
  ];

  return lines.join("\n") + "\n";
}

function defaultLoopGuardTs(): string {
  return `/**
 * Pi Extension Hook (-e .animus/hooks/loop-guard.ts)
 * Enforces protected path invariants and appends verified CLI guidance on tool failures.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const DEFAULT_PROTECTED_PATTERNS = [
  /^\\.animus\\/holdout(\\/|$)/,
  /^\\.animus\\/hooks(\\/|$)/,
  /^\\.factory\\/holdout(\\/|$)/,
  /^\\.factory\\/hooks(\\/|$)/,
  /^\\.claude\\/settings(?:\\.local)?\\.json$/,
  /^\\.ignore$/,
  /^harness(\\/|$)/,
];

function globMatchesPath(globPattern: string, targetPath: string): boolean {
  const normPath = targetPath.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  try {
    const rxStr =
      "^" +
      globPattern
        .replace(/[.+^$\${}()|[\\]\\\\]/g, "\\\\$&")
        .replace(/\\*\\*/g, ".*")
        .replace(/(?<!\\.)\\*/g, "[^/]*") +
      "$";
    if (new RegExp(rxStr, "i").test(normPath)) return true;
  } catch {}
  const cleanToken = globPattern.replace(/\\*+/g, "").toLowerCase();
  return cleanToken.length >= 3 && normPath.toLowerCase().includes(cleanToken);
}

function isProtectedPath(targetPath: string, cwd: string = process.cwd()): boolean {
  if (!targetPath || typeof targetPath !== "string") return false;
  const rawClean = targetPath.trim().replace(/^["']|["']$/g, "");
  const norm = isAbsolute(rawClean) ? relative(cwd, rawClean) : rawClean;
  const normalized = norm.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  if (DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized))) return true;

  const configPath = join(cwd, "harness/harness.config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      const rawPaths = cfg?.protected_paths;
      if (typeof rawPaths === "string" && rawPaths.trim()) {
        const globs = rawPaths.split(",").map((s: string) => s.trim()).filter(Boolean);
        for (const g of globs) {
          if (globMatchesPath(g, normalized)) return true;
        }
      }
    } catch {}
  }
  return false;
}

function loadToolGuidance(cwd: string): Record<string, string> {
  const primaryPath = join(cwd, ".animus/tool-guidance.json");
  const fallbackPath = join(cwd, ".factory/tool-guidance.json");
  const p = existsSync(primaryPath) ? primaryPath : fallbackPath;
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

export default function registerLoopGuard(api: any) {
  if (!api || typeof api.on !== "function") return;

  api.on("tool_call", async (event: any) => {
    const toolName = String(event?.toolName ?? "").toLowerCase().trim();
    const args = (event?.input ?? event?.args ?? {}) as Record<string, any>;

    if (toolName === "bash" && typeof args.command === "string") {
      const cmd = args.command;
      if (
        /(?:^|[;&|\\n]\\s*)\\bgit\\s+(?:[^;&|\\n]*?\\s+)?(?:commit|push|merge)\\s+[^;&|\\n]*?(?:--no-verify|-n\\b)/i.test(cmd) ||
        /(?:^|[;&|\\n]\\s*)\\bgit\\s+[^;&|\\n]*?(?:--no-verify|-n\\b)[^;&|\\n]*?\\s+(?:commit|push|merge)\\b/i.test(cmd) ||
        /\\bgit\\b.*-c\\s+core\\.hooksPath=(?:\\/dev\\/null|""|'')/i.test(cmd)
      ) {
        return {
          block: true,
          reason:
            "HARNESS GUARD: Bypassing git hooks with --no-verify, -n, or overriding core.hooksPath is strictly prohibited. All commits must pass deterministic pre-commit CI gates.",
        };
      }

      const hasMutation =
        /(?:>|>>|\\btee\\b|\\b(?:sed|perl)\\s+-[a-zA-Z]*i|\\b(?:rm|mv|cp|chmod|truncate|ln|install)\\b|\\bgit\\s+(?:checkout|restore|rm|mv|reset|stash)\\b)/i.test(
          cmd,
        );
      if (hasMutation) {
        const protectedTokens = [
          ".animus/holdout",
          ".animus/hooks",
          ".factory/holdout",
          ".factory/hooks",
          ".claude/settings",
          "harness/",
          ".ignore",
        ];
        for (const tok of protectedTokens) {
          if (cmd.includes(tok)) {
            return {
              block: true,
              reason: \`HARNESS GUARD: Modifying protected path '\${tok}' via shell command is forbidden.\`,
            };
          }
        }
      }
    }

    const isWriteTool =
      toolName === "write" ||
      toolName === "edit" ||
      toolName === "write_file" ||
      toolName === "edit_file" ||
      toolName === "multiedit" ||
      toolName === "strreplace" ||
      toolName === "str_replace_editor";

    const targetPath =
      typeof args.path === "string"
        ? args.path
        : typeof args.Path === "string"
          ? args.Path
          : typeof args.file_path === "string"
            ? args.file_path
            : typeof args.filePath === "string"
              ? args.filePath
              : typeof args.target_file === "string"
                ? args.target_file
                : typeof args.file === "string"
                  ? args.file
                  : null;

    if (isWriteTool && targetPath) {
      if (isProtectedPath(targetPath, process.cwd())) {
        return {
          block: true,
          reason: \`HARNESS GUARD: Modifying protected path '\${targetPath}' inside a delivery lap is forbidden.\`,
        };
      }
    }
    return undefined;
  });

  api.on("tool_result", async (event: any) => {
    if (event?.toolName === "bash" && event?.isError) {
      const guidance = loadToolGuidance(process.cwd());
      const entries = Object.entries(guidance);
      if (entries.length > 0) {
        const hint = entries.map(([k, v]) => \`\${k}: \\\`\${v}\\\`\`).join(", ");
        return {
          appendText: \`\\n[HARNESS TOOL GUIDANCE HINT] Verified repository commands -> \${hint}\`,
        };
      }
    }
    return undefined;
  });
}
`;
}

function defaultHoldoutMd(): string {
  return `# Fenced Acceptance Holdouts

> **STRICT ACCESS POLICY**: Only holdout-writer and holdout-verifier agents may read this file.
> Builders and general agents are prohibited from reading this document.
`;
}

function defaultHarnessCiTs(): string {
  return `import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

export interface HarnessConfig {
  static?: string;
  unit?: string;
  unit_count_pattern?: string;
  required_checks?: string;
  protected_paths?: string;
}

export function runChecks(repoRoot: string): { success: boolean; output: string } {
  const configPath = join(repoRoot, "harness/harness.config.json");
  if (!existsSync(configPath)) {
    throw new Error("harness.config.json not found");
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as HarnessConfig;
  const logs: string[] = ["HARNESS_START mode=ordinary"];

  if (config.static && config.static !== "true") {
    const res = spawnSync(config.static, { cwd: repoRoot, shell: true, encoding: "utf-8" });
    if (res.status !== 0) {
      logs.push(res.stdout || "", res.stderr || "", "GATE_FAILED: static");
      return { success: false, output: logs.join("\n") };
    }
    logs.push("STATIC_OK");
  }

  if (config.unit && config.unit !== "true") {
    const res = spawnSync(config.unit, { cwd: repoRoot, shell: true, encoding: "utf-8" });
    if (res.status !== 0) {
      logs.push(res.stdout || "", res.stderr || "", "GATE_FAILED: unit");
      return { success: false, output: logs.join("\n") };
    }
    logs.push("UNIT_PASSED");
  }

  logs.push("CHECKS_OK mode=ordinary");
  return { success: true, output: logs.join("\n") };
}

if (import.meta.main || process.argv[1]?.endsWith("ci.ts")) {
  const res = runChecks(process.cwd());
  console.log(res.output);
  process.exit(res.success ? 0 : 1);
}
`;
}

function ensureSymlinkOrCopy(targetRel: string, linkPath: string, fallbackCopyPath?: string): void {
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink() || st.isFile() || st.isDirectory()) return;
  } catch {}
  mkdirSync(dirname(linkPath), { recursive: true });
  try {
    symlinkSync(targetRel, linkPath);
  } catch {
    if (fallbackCopyPath && existsSync(fallbackCopyPath)) {
      cpSync(fallbackCopyPath, linkPath, { recursive: true });
    }
  }
}

function resolveFactorySourceRoot(explicit?: string): string | null {
  if (explicit && existsSync(join(explicit, ".agents/skills"))) return resolve(explicit);

  const envSource = process.env.ANIMUS_SOURCE_ROOT || process.env.FACTORY_SOURCE_ROOT;
  if (envSource && existsSync(join(envSource, ".agents/skills"))) return resolve(envSource);

  for (const rel of ["../../../", "../../", "../", "../../../../"]) {
    try {
      const candidate = fileURLToPath(new URL(rel, import.meta.url));
      if (!candidate.includes("/$bunfs/") && existsSync(join(candidate, ".agents/skills"))) {
        return resolve(candidate);
      }
    } catch {}
  }

  try {
    if (process.argv[1]) {
      const realScript = realpathSync(process.argv[1]);
      for (const rel of [".", "..", "../..", "../../.."]) {
        const candidate = resolve(dirname(realScript), rel);
        if (existsSync(join(candidate, ".agents/skills"))) {
          return candidate;
        }
      }
    }
  } catch {}

  try {
    const home = homedir();
    const wellKnown = [
      join(home, ".animus/source"),
      join(home, "Documents/workspace/projects/animus"),
    ];
    for (const p of wellKnown) {
      if (existsSync(join(p, ".agents/skills"))) {
        return resolve(p);
      }
    }
  } catch {}

  if (existsSync(join(process.cwd(), ".agents/skills"))) {
    return resolve(process.cwd());
  }
  return null;
}

/**
 * Synchronizes machine-level canonical agent skills into ~/.animus/skills/.
 * Sourced from the local repository checkout or canonical catalog templates.
 */
export function syncMachineCanonicalSkills(
  animusHome?: string,
  factorySourceRoot?: string,
): { installed: string[]; dir: string } {
  const targetDir = resolveAnimusSkillsHome(animusHome);
  mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  const sourceRoot = resolveFactorySourceRoot(factorySourceRoot);
  const installed: string[] = [];

  if (sourceRoot) {
    const sourceSkillsDir = join(sourceRoot, ".agents/skills");
    if (existsSync(sourceSkillsDir)) {
      const sourceSkillDirs = readdirSync(sourceSkillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(sourceSkillsDir, d.name, "SKILL.md")))
        .map((d) => d.name);
      const allSkills = new Set([...CANONICAL_SKILL_NAMES, ...sourceSkillDirs]);
      for (const skillName of allSkills) {
        const srcSkill = join(sourceSkillsDir, skillName);
        const dstSkill = join(targetDir, skillName);
        if (existsSync(srcSkill)) {
          mkdirSync(dstSkill, { recursive: true, mode: 0o700 });
          cpSync(srcSkill, dstSkill, { recursive: true });
          installed.push(skillName);
        }
      }
      return { installed, dir: targetDir };
    }
  }

  for (const [skillName, desc] of CANONICAL_SKILL_CATALOG) {
    const dstSkillDir = join(targetDir, skillName);
    const dstSkillFile = join(dstSkillDir, "SKILL.md");
    mkdirSync(dstSkillDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      dstSkillFile,
      [
        "---",
        `name: ${skillName}`,
        `description: ${desc}`,
        "---",
        "",
        `# ${skillName}`,
        "",
        "## Steps",
        "1. Execute verification-first workflow.",
        "   *Completion Criterion*: All checks pass with concrete evidence.",
        "",
      ].join("\n"),
      "utf-8",
    );
    installed.push(skillName);
  }

  return { installed, dir: targetDir };
}

export function scaffoldRepositoryHarness(opts: ScaffoldHarnessOptions): ScaffoldHarnessResult {
  const targetRoot = resolve(opts.targetRepoRoot);
  const sourceRoot = resolveFactorySourceRoot(opts.factorySourceRoot);
  const auditBefore = auditRepositoryHarness(targetRoot);
  const createdOrUpdatedPaths: string[] = [];
  const skillsCopied: string[] = [];
  const skillsMode: "external" | "repo" = opts.skillsMode ?? "external";

  // 1. Handle AGENTS.md (Greenfield missing, or Brownfield overwrite/keep)
  const agentsPath = join(targetRoot, "AGENTS.md");
  let agentsMdActionTaken: ScaffoldHarnessResult["agentsMdActionTaken"] = "kept";
  let agentsMdBackupPath: string | undefined;

  const desiredAction =
    opts.agentsMdAction ??
    (!auditBefore.agentsMd.exists ? "overwrite" : "keep");

  if (!auditBefore.agentsMd.exists) {
    writeFileSync(
      agentsPath,
      generateCanonicalAgentsMd(targetRoot, opts.detectedCommands),
      "utf-8",
    );
    agentsMdActionTaken = "created";
    createdOrUpdatedPaths.push(agentsPath);
  } else if (desiredAction === "overwrite") {
    const existingText = readFileSync(agentsPath, "utf-8");
    agentsMdBackupPath = join(targetRoot, ".animus/AGENTS.md.bak");
    mkdirSync(dirname(agentsMdBackupPath), { recursive: true });
    writeFileSync(agentsMdBackupPath, existingText, "utf-8");

    writeFileSync(
      agentsPath,
      generateCanonicalAgentsMd(targetRoot, opts.detectedCommands),
      "utf-8",
    );
    agentsMdActionTaken = "overwritten";
    createdOrUpdatedPaths.push(agentsPath);
  } else {
    agentsMdActionTaken = "kept";
  }

  // 2. Ensure CLAUDE.md -> AGENTS.md symlink
  const claudeMdPath = join(targetRoot, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    ensureSymlinkOrCopy("AGENTS.md", claudeMdPath, agentsPath);
    createdOrUpdatedPaths.push(claudeMdPath);
  }

  // 3. Install skills (external mode relies on machine store ~/.animus/skills/, repo mode copies locally)
  const targetSkillsDir = join(targetRoot, ".agents/skills");
  if (skillsMode === "external") {
    // In external mode, populate/refresh machine canonical skills
    try {
      syncMachineCanonicalSkills(undefined, opts.factorySourceRoot);
    } catch {}

    // Ensure docs/agents are available in repo
    if (sourceRoot && resolve(sourceRoot) !== targetRoot) {
      const sourceAgentDocsDir = join(sourceRoot, "docs/agents");
      if (existsSync(sourceAgentDocsDir)) {
        const targetAgentDocsDir = join(targetRoot, "docs/agents");
        mkdirSync(targetAgentDocsDir, { recursive: true });
        for (const entry of readdirSync(sourceAgentDocsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const srcDoc = join(sourceAgentDocsDir, entry.name);
          const dstDoc = join(targetAgentDocsDir, entry.name);
          if (!existsSync(dstDoc)) {
            cpSync(srcDoc, dstDoc);
            createdOrUpdatedPaths.push(dstDoc);
          }
        }
      }
    }
  } else {
    // Repo mode: install canonical skills directly into .agents/skills/
    mkdirSync(targetSkillsDir, { recursive: true });

    if (sourceRoot && resolve(sourceRoot) !== targetRoot) {
      const sourceSkillsDir = join(sourceRoot, ".agents/skills");
      if (existsSync(sourceSkillsDir)) {
        const sourceSkillDirs = readdirSync(sourceSkillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(sourceSkillsDir, d.name, "SKILL.md")))
          .map((d) => d.name);
        const allSkillsToCopy = new Set([...CANONICAL_SKILL_NAMES, ...sourceSkillDirs]);
        for (const skillName of allSkillsToCopy) {
          const srcSkill = join(sourceSkillsDir, skillName);
          const dstSkill = join(targetSkillsDir, skillName);
          if (existsSync(srcSkill) && !existsSync(dstSkill)) {
            cpSync(srcSkill, dstSkill, { recursive: true });
            skillsCopied.push(skillName);
            createdOrUpdatedPaths.push(dstSkill);
          }
        }
      }

      const sourceAgentDocsDir = join(sourceRoot, "docs/agents");
      if (existsSync(sourceAgentDocsDir)) {
        const targetAgentDocsDir = join(targetRoot, "docs/agents");
        mkdirSync(targetAgentDocsDir, { recursive: true });
        for (const entry of readdirSync(sourceAgentDocsDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const srcDoc = join(sourceAgentDocsDir, entry.name);
          const dstDoc = join(targetAgentDocsDir, entry.name);
          if (!existsSync(dstDoc)) {
            cpSync(srcDoc, dstDoc);
            createdOrUpdatedPaths.push(dstDoc);
          }
        }
      }
    } else {
      // Minimal embedded fallback skills if running from standalone binary outside source tree
      for (const [skillName, desc] of CANONICAL_SKILL_CATALOG) {
        const dstSkillFile = join(targetSkillsDir, skillName, "SKILL.md");
        if (!existsSync(dstSkillFile)) {
          mkdirSync(dirname(dstSkillFile), { recursive: true });
          writeFileSync(
            dstSkillFile,
            [
              "---",
              `name: ${skillName}`,
              `description: ${desc}`,
              "---",
              "",
              `# ${skillName}`,
              "",
              "## Steps",
              "1. Execute verification-first workflow.",
              "   *Completion Criterion*: All checks pass with concrete evidence.",
              "",
            ].join("\n"),
            "utf-8",
          );
          skillsCopied.push(skillName);
          createdOrUpdatedPaths.push(dstSkillFile);
        }
      }
    }
  }

  // 4. Ensure .claude/skills -> ../.agents/skills symlink (in repo mode or if repo skills exist) & .claude/settings.json
  const claudeSkillsLink = join(targetRoot, ".claude/skills");
  if (skillsMode === "repo" || existsSync(targetSkillsDir)) {
    if (!existsSync(claudeSkillsLink)) {
      try {
        const st = lstatSync(claudeSkillsLink);
        if (st.isSymbolicLink()) unlinkSync(claudeSkillsLink);
      } catch {}
      ensureSymlinkOrCopy("../.agents/skills", claudeSkillsLink, targetSkillsDir);
      createdOrUpdatedPaths.push(claudeSkillsLink);
    }
  }

  const claudeSettingsPath = join(targetRoot, ".claude/settings.json");
  if (!existsSync(claudeSettingsPath)) {
    mkdirSync(dirname(claudeSettingsPath), { recursive: true });
    writeFileSync(
      claudeSettingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher:
                  "Bash|PowerShell|Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|NotebookRead|Agent|Task",
                hooks: [
                  {
                    type: "command",
                    command: 'python "$CLAUDE_PROJECT_DIR/.animus/hooks/holdout_fence.py" pre',
                  },
                ],
              },
            ],
            PostToolUse: [
              {
                matcher: "Bash|PowerShell|Read|Grep|Glob|Agent|Task",
                hooks: [
                  {
                    type: "command",
                    command: 'python "$CLAUDE_PROJECT_DIR/.animus/hooks/holdout_fence.py" post',
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(claudeSettingsPath);
  }

  // 4b. Ensure .pi/settings.json and .omp/settings.json for repository-level extension hooks
  const piSettingsPath = join(targetRoot, ".pi/settings.json");
  if (!existsSync(piSettingsPath)) {
    mkdirSync(dirname(piSettingsPath), { recursive: true });
    writeFileSync(
      piSettingsPath,
      JSON.stringify(
        {
          extensions: ["./.animus/hooks/loop-guard.ts"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(piSettingsPath);
  }

  const ompSettingsPath = join(targetRoot, ".omp/settings.json");
  if (!existsSync(ompSettingsPath)) {
    mkdirSync(dirname(ompSettingsPath), { recursive: true });
    writeFileSync(
      ompSettingsPath,
      JSON.stringify(
        {
          extensions: ["./.animus/hooks/loop-guard.ts"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(ompSettingsPath);
  }

  // 5. Ensure .animus/hooks/loop-guard.ts & holdout_fence.py
  const loopGuardPath = join(targetRoot, ".animus/hooks/loop-guard.ts");
  if (!existsSync(loopGuardPath)) {
    mkdirSync(dirname(loopGuardPath), { recursive: true });
    const srcGuard = sourceRoot
      ? existsSync(join(sourceRoot, ".animus/hooks/loop-guard.ts"))
        ? join(sourceRoot, ".animus/hooks/loop-guard.ts")
        : existsSync(join(sourceRoot, ".factory/hooks/loop-guard.ts"))
          ? join(sourceRoot, ".factory/hooks/loop-guard.ts")
          : null
      : null;
    if (srcGuard && existsSync(srcGuard)) {
      cpSync(srcGuard, loopGuardPath);
    } else {
      writeFileSync(loopGuardPath, defaultLoopGuardTs(), "utf-8");
    }
    createdOrUpdatedPaths.push(loopGuardPath);
  }

  const holdoutFencePath = join(targetRoot, ".animus/hooks/holdout_fence.py");
  if (!existsSync(holdoutFencePath)) {
    mkdirSync(dirname(holdoutFencePath), { recursive: true });
    const srcFence = sourceRoot
      ? existsSync(join(sourceRoot, ".animus/hooks/holdout_fence.py"))
        ? join(sourceRoot, ".animus/hooks/holdout_fence.py")
        : existsSync(join(sourceRoot, ".factory/hooks/holdout_fence.py"))
          ? join(sourceRoot, ".factory/hooks/holdout_fence.py")
          : null
      : null;
    if (srcFence && existsSync(srcFence)) {
      cpSync(srcFence, holdoutFencePath);
    } else {
      writeFileSync(
        holdoutFencePath,
        '#!/usr/bin/env python3\nimport sys\nsys.exit(0)\n',
        "utf-8",
      );
    }
    createdOrUpdatedPaths.push(holdoutFencePath);
  }

  // 6. Ensure .animus/lessons.jsonl, .animus/codebase-rules.json, .animus/holdout/HOLDOUT.md, .ignore
  const lessonsPath = join(targetRoot, ".animus/lessons.jsonl");
  if (!existsSync(lessonsPath)) {
    mkdirSync(dirname(lessonsPath), { recursive: true });
    writeFileSync(lessonsPath, "", "utf-8");
    createdOrUpdatedPaths.push(lessonsPath);
  }

  const codebaseRulesPath = join(targetRoot, ".animus/codebase-rules.json");
  if (!existsSync(codebaseRulesPath)) {
    mkdirSync(dirname(codebaseRulesPath), { recursive: true });
    writeFileSync(
      codebaseRulesPath,
      JSON.stringify(
        {
          schema_version: 1,
          rules: [],
          pattern_registry: {},
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(codebaseRulesPath);
  }

  const holdoutMdPath = join(targetRoot, ".animus/holdout/HOLDOUT.md");
  if (!existsSync(holdoutMdPath)) {
    mkdirSync(dirname(holdoutMdPath), { recursive: true });
    writeFileSync(holdoutMdPath, defaultHoldoutMd(), "utf-8");
    createdOrUpdatedPaths.push(holdoutMdPath);
  }

  const ignorePath = join(targetRoot, ".ignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, ".animus/holdout/\n", "utf-8");
    createdOrUpdatedPaths.push(ignorePath);
  } else {
    const igContent = readFileSync(ignorePath, "utf-8");
    if (!igContent.includes(".animus/holdout")) {
      writeFileSync(ignorePath, igContent.trimEnd() + "\n.animus/holdout/\n", "utf-8");
      createdOrUpdatedPaths.push(ignorePath);
    }
  }

  // 7. Ensure harness/ci.ts
  const isNodeOrBun =
    opts.detectedCommands.projectType === "typescript-bun" ||
    opts.detectedCommands.projectType === "node";
  if (isNodeOrBun) {
    const harnessCiPath = join(targetRoot, "harness/ci.ts");
    if (!existsSync(harnessCiPath)) {
      mkdirSync(dirname(harnessCiPath), { recursive: true });
      writeFileSync(harnessCiPath, defaultHarnessCiTs(), "utf-8");
      createdOrUpdatedPaths.push(harnessCiPath);
    }
  }

  return {
    auditBefore,
    agentsMdActionTaken,
    agentsMdBackupPath,
    createdOrUpdatedPaths,
    skillsCopied,
    skillsMode,
  };
}
