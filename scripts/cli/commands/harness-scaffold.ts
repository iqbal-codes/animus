import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DetectedRepoCommands } from "./setup";

export interface AgentsMdAudit {
  exists: boolean;
  path: string;
  lineCount: number;
  score: number; // 0..100
  status: "missing" | "poor" | "good";
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
    factoryMd: boolean;
    factoryRulesMd: boolean;
    harnessCiRunner: boolean;
  };
}

export interface ScaffoldHarnessOptions {
  targetRepoRoot: string;
  factorySourceRoot?: string;
  detectedCommands: DetectedRepoCommands;
  agentsMdAction?: "keep" | "upgrade" | "overwrite";
}

export interface ScaffoldHarnessResult {
  auditBefore: HarnessAuditReport;
  agentsMdActionTaken: "created" | "upgraded" | "overwritten" | "kept";
  agentsMdBackupPath?: string;
  createdOrUpdatedPaths: string[];
  skillsCopied: string[];
}

const REQUIRED_SKILL_POINTERS = [
  { key: ".agents/skills/", label: "Repository skills directory (.agents/skills/)" },
  { key: ".factory/tool-guidance.json", label: "Verified tool guidance (.factory/tool-guidance.json)" },
  { key: ".factory/lessons.jsonl", label: "Evidence-backed lessons (.factory/lessons.jsonl)" },
  { key: "tdd", label: "TDD / Red-Green execution rule (.agents/skills/tdd)" },
];

export function auditAgentsMd(repoRoot: string): AgentsMdAudit {
  const path = join(repoRoot, "AGENTS.md");
  if (!existsSync(path)) {
    return {
      exists: false,
      path,
      lineCount: 0,
      score: 0,
      status: "missing",
      missingSections: REQUIRED_SKILL_POINTERS.map((r) => r.label),
      issues: ["AGENTS.md does not exist in this repository."],
    };
  }

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");
  const lineCount = lines.length;
  const issues: string[] = [];
  const missingSections: string[] = [];

  let score = 100;

  if (content.trim().length < 120) {
    score -= 40;
    issues.push("AGENTS.md is too sparse (< 120 characters) and lacks actionable context pointers.");
  }

  if (lineCount > 150) {
    score -= 25;
    issues.push(`AGENTS.md exceeds the 150-line context budget (${lineCount} lines); progressive disclosure is needed.`);
  }

  for (const req of REQUIRED_SKILL_POINTERS) {
    if (!content.includes(req.key)) {
      missingSections.push(req.label);
      score -= 15;
    }
  }

  // Check for excessive negative proverbs ("don't", "do not", "never")
  const negMatches = content.match(/\b(do not|don't|avoid)\b/gi) ?? [];
  if (negMatches.length > 6) {
    score -= 10;
    issues.push(
      `Contains ${negMatches.length} negative prohibitions; prefer positive imperative instructions.`,
    );
  }

  score = Math.max(0, Math.min(100, score));
  const status: AgentsMdAudit["status"] = score >= 75 ? "good" : "poor";
  if (missingSections.length > 0) {
    issues.push(`Missing factory harness pointers: ${missingSections.join(", ")}`);
  }

  return {
    exists: true,
    path,
    lineCount,
    score,
    status,
    missingSections,
    issues,
  };
}

export const CANONICAL_SKILL_CATALOG = [
  ["tdd", "Test-driven development red-green-refactor playbook."],
  ["diagnosing-bugs", "Systematic root-cause bug diagnosis playbook."],
  ["unstick", "Two-strike failure recovery and premise probing playbook."],
  ["blueprint", "Type-first architecture and Level 4 blast-radius verification playbook."],
  ["ui-quality", "Intentional frontend design, 7-state coverage, and viewport audit playbook."],
  ["animus-implement", "Autonomous builder implementation playbook."],
  ["animus-review", "Independent code review and evidence verification playbook."],
  ["animus-harness", "Post-lap memory, tool guidance, and lesson synthesis playbook."],
  ["animus-brainstorm", "Shape a broad product or initiative idea into an ordered slice map."],
  ["animus-grill", "Stress-test a single product slice top-down across altitude gates."],
  ["animus-spec", "Synthesize agreed discussion into a software factory specification."],
  ["animus-architecture", "Derive tech stack, module topology, and reusable components from product specs."],
  ["animus-tickets", "Split an agreed spec into vertical tickets with parser-readable dependencies."],
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

  return {
    repoRoot: root,
    projectMode,
    agentsMd,
    claudeMdSymlink,
    skillsInstalled,
    learnedSkills,
    claudeSkillsSymlink,
    hooksInstalled: {
      loopGuard: existsSync(join(root, ".factory/hooks/loop-guard.ts")),
      holdoutFence: existsSync(join(root, ".factory/hooks/holdout_fence.py")),
      claudeSettings: existsSync(join(root, ".claude/settings.json")),
      piSettings: existsSync(join(root, ".pi/settings.json")),
      ompSettings: existsSync(join(root, ".omp/settings.json")),
    },
    governanceFiles: {
      lessonsJsonl: existsSync(join(root, ".factory/lessons.jsonl")),
      toolGuidanceJson: existsSync(join(root, ".factory/tool-guidance.json")),
      codebaseRulesJson: existsSync(join(root, ".factory/codebase-rules.json")),
      holdoutMd: existsSync(join(root, ".factory/holdout/HOLDOUT.md")),
      ignoreFile: existsSync(join(root, ".ignore")),
      factoryMd: existsSync(join(root, "FACTORY.md")),
      factoryRulesMd: existsSync(join(root, "FACTORY_RULES.md")),
      harnessCiRunner: existsSync(join(root, "harness/ci.ts")),
    },
  };
}

export function generateCanonicalAgentsMd(
  repoRoot: string,
  commands: DetectedRepoCommands,
  preservedNotes?: string,
): string {
  const projectName = basename(resolve(repoRoot)) || "Repository";
  const sourceRoot = resolveFactorySourceRoot();
  const templatePath = sourceRoot ? join(sourceRoot, "factory/templates/AGENTS.template.md") : null;

  if (templatePath && existsSync(templatePath)) {
    const rawTemplate = readFileSync(templatePath, "utf-8");
    const rendered = rawTemplate
      .replaceAll("$PROJECT_NAME", projectName)
      .replaceAll("$STATIC_CHECK", commands.staticCheck)
      .replaceAll("$UNIT_TEST", commands.unitTest)
      .trimEnd();
    const lines = rendered.split("\n");
    if (preservedNotes && preservedNotes.trim()) {
      const trimmedNotes = preservedNotes.trim().split("\n").slice(0, 60);
      lines.push("", "## Project-Specific Conventions", "", ...trimmedNotes);
    }
    return lines.slice(0, 148).join("\n") + "\n";
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
    "- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`).",
    "- **Repository Skills**: Consult playbooks in `.agents/skills/` when triggered:",
    "  - Spec drafting, product shaping & architecture: `/animus-brainstorm`, `/animus-grill`, `/animus-spec`, `/animus-architecture`, `/animus-tickets`",
    "  - Implementation & verification: `/animus-implement`, `.agents/skills/tdd/SKILL.md`",
    "  - Code review & standards: `/animus-review`",
    "  - Defect root-causing: `/diagnosing-bugs`",
    "  - Post-lap memory & lesson synthesis: `/animus-harness`, `.agents/skills/writing-for-agents/SKILL.md`, `.agents/skills/skill-creator/SKILL.md`",
    "- **Verified Tool Guidance**: Inspect `.factory/tool-guidance.json` for validated CLI recipes (`static`: `" +
      commands.staticCheck +
      "`, `unit`: `" +
      commands.unitTest +
      "`).",
    "- **Evidence-Backed Lessons**: Inspect `.factory/lessons.jsonl` for repository-specific gotchas matching target files before editing.",
    "- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons, rules, or skills.",
    "- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.factory/NO_HARNESS_MEMORY` is present.",
    "",
    "## Domain & Workflow Documentation",
    "",
    "- **PR & Evidence Contract**: Read `docs/agents/pr-evidence-contract.md` for canonical PR bodies, evidence matrices, Before/After captures, and finding rechecks.",
    "- **Issue Tracker, Dependencies & Triage Labels**: Read `docs/agents/issue-tracker.md` for `gh` conventions, `Depends on:` rules, and canonical triage labels.",
    "- **Domain Models & ADRs**: Read `docs/agents/domain.md`, `GLOSSARY.md`, and `docs/adr/` before modifying domain models or architectural boundaries.",
    "",
    "## Execution Rules",
    "",
    "- **Red -> Green Loop**: Write failing tests first at public seams using `.agents/skills/tdd/SKILL.md`, then implement minimal passing code.",
    "- **Protected Governance Paths**: Keep `MISSION.md`, `FACTORY.md`, `FACTORY_RULES.md`, `harness/**`, `.factory/holdout/**`, and `.factory/hooks/**` untouched during delivery laps.",
    "- **Clean Cutover**: Migrate all callers when modifying contracts; keep one canonical implementation without dead shims.",
  ];

  if (preservedNotes && preservedNotes.trim()) {
    const trimmedNotes = preservedNotes
      .trim()
      .split("\n")
      .slice(0, 60);
    lines.push("", "## Project-Specific Conventions", "", ...trimmedNotes);
  }

  return lines.slice(0, 148).join("\n") + "\n";
}

function defaultLoopGuardTs(): string {
  return `/**
 * Pi Extension Hook (-e .factory/hooks/loop-guard.ts)
 * Enforces protected path invariants and appends verified CLI guidance on tool failures.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PROTECTED_PATTERNS = [
  /^\\.factory\\/holdout(\\/|$)/,
  /^\\.factory\\/hooks(\\/|$)/,
  /^\\.claude\\/settings\\.json$/,
  /^harness(\\/|$)/,
  /^MISSION\\.md$/,
  /^FACTORY\\.md$/,
  /^FACTORY_RULES\\.md$/,
];

function isProtectedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\\\/g, "/").replace(/^\\.\\//, "");
  return DEFAULT_PROTECTED_PATTERNS.some((rx) => rx.test(normalized));
}

function loadToolGuidance(cwd: string): Record<string, string> {
  const p = join(cwd, ".factory/tool-guidance.json");
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
    const toolName = String(event?.toolName ?? "");
    const args = event?.args ?? {};

    if ((toolName === "write" || toolName === "edit") && typeof args.path === "string") {
      if (isProtectedPath(args.path)) {
        return {
          block: true,
          reason: \`HARNESS GUARD: Modifying protected path '\${args.path}' inside a delivery lap is forbidden.\`,
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
  return `# Holdout scenarios

Acceptance checks the agents building the code never see. Written from the product document,
they test end-to-end invariants across issues.

\`\`\`
## H-01 Core application health and primary user journey
Protects: Core application startup and primary user workflow
Touches: apps/**, packages/**, src/**
Setup: Start the application with a clean state directory
Steps: Exercise the primary user or API entrypoint
Expect: Service responds cleanly without unhandled errors
Author: owner
\`\`\`
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
  try {
    const candidate = fileURLToPath(new URL("../../../", import.meta.url));
    if (!candidate.includes("/$bunfs/") && existsSync(join(candidate, ".agents/skills"))) {
      return resolve(candidate);
    }
  } catch {}
  if (existsSync(join(process.cwd(), ".agents/skills"))) {
    return resolve(process.cwd());
  }
  return null;
}

export function scaffoldRepositoryHarness(opts: ScaffoldHarnessOptions): ScaffoldHarnessResult {
  const targetRoot = resolve(opts.targetRepoRoot);
  const sourceRoot = resolveFactorySourceRoot(opts.factorySourceRoot);
  const auditBefore = auditRepositoryHarness(targetRoot);
  const createdOrUpdatedPaths: string[] = [];
  const skillsCopied: string[] = [];

  // 1. Handle AGENTS.md (Greenfield missing, or Brownfield poor/upgrade/overwrite)
  const agentsPath = join(targetRoot, "AGENTS.md");
  let agentsMdActionTaken: ScaffoldHarnessResult["agentsMdActionTaken"] = "kept";
  let agentsMdBackupPath: string | undefined;

  const desiredAction =
    opts.agentsMdAction ??
    (!auditBefore.agentsMd.exists
      ? "overwrite"
      : auditBefore.agentsMd.status === "poor"
        ? "upgrade"
        : "keep");

  if (!auditBefore.agentsMd.exists) {
    writeFileSync(
      agentsPath,
      generateCanonicalAgentsMd(targetRoot, opts.detectedCommands),
      "utf-8",
    );
    agentsMdActionTaken = "created";
    createdOrUpdatedPaths.push(agentsPath);
  } else if (desiredAction === "upgrade" || desiredAction === "overwrite") {
    const existingText = readFileSync(agentsPath, "utf-8");
    agentsMdBackupPath = join(targetRoot, ".factory/AGENTS.md.bak");
    mkdirSync(dirname(agentsMdBackupPath), { recursive: true });
    writeFileSync(agentsMdBackupPath, existingText, "utf-8");

    const preserved = desiredAction === "upgrade" ? existingText : undefined;
    writeFileSync(
      agentsPath,
      generateCanonicalAgentsMd(targetRoot, opts.detectedCommands, preserved),
      "utf-8",
    );
    agentsMdActionTaken = desiredAction === "upgrade" ? "upgraded" : "overwritten";
    createdOrUpdatedPaths.push(agentsPath);
  }

  // 2. Ensure CLAUDE.md -> AGENTS.md symlink
  const claudeMdPath = join(targetRoot, "CLAUDE.md");
  if (!existsSync(claudeMdPath)) {
    ensureSymlinkOrCopy("AGENTS.md", claudeMdPath, agentsPath);
    createdOrUpdatedPaths.push(claudeMdPath);
  }

  // 3. Install canonical skills into .agents/skills/
  const targetSkillsDir = join(targetRoot, ".agents/skills");
  mkdirSync(targetSkillsDir, { recursive: true });

  if (sourceRoot && resolve(sourceRoot) !== targetRoot) {
    const sourceSkillsDir = join(sourceRoot, ".agents/skills");
    if (existsSync(sourceSkillsDir)) {
      for (const skillName of CANONICAL_SKILL_NAMES) {
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

  // 4. Ensure .claude/skills -> ../.agents/skills symlink & .claude/settings.json
  const claudeSkillsLink = join(targetRoot, ".claude/skills");
  if (!existsSync(claudeSkillsLink)) {
    try {
      const st = lstatSync(claudeSkillsLink);
      if (st.isSymbolicLink()) unlinkSync(claudeSkillsLink);
    } catch {}
    ensureSymlinkOrCopy("../.agents/skills", claudeSkillsLink, targetSkillsDir);
    createdOrUpdatedPaths.push(claudeSkillsLink);
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
                    command: 'python "$CLAUDE_PROJECT_DIR/.factory/hooks/holdout_fence.py" pre',
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
                    command: 'python "$CLAUDE_PROJECT_DIR/.factory/hooks/holdout_fence.py" post',
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
          extensions: ["./.factory/hooks/loop-guard.ts"],
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
          extensions: ["./.factory/hooks/loop-guard.ts"],
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(ompSettingsPath);
  }

  // 5. Ensure .factory/hooks/loop-guard.ts & holdout_fence.py
  const loopGuardPath = join(targetRoot, ".factory/hooks/loop-guard.ts");
  if (!existsSync(loopGuardPath)) {
    mkdirSync(dirname(loopGuardPath), { recursive: true });
    const srcGuard = sourceRoot ? join(sourceRoot, ".factory/hooks/loop-guard.ts") : null;
    if (srcGuard && existsSync(srcGuard)) {
      cpSync(srcGuard, loopGuardPath);
    } else {
      writeFileSync(loopGuardPath, defaultLoopGuardTs(), "utf-8");
    }
    createdOrUpdatedPaths.push(loopGuardPath);
  }

  const holdoutFencePath = join(targetRoot, ".factory/hooks/holdout_fence.py");
  if (!existsSync(holdoutFencePath)) {
    mkdirSync(dirname(holdoutFencePath), { recursive: true });
    const srcFence = sourceRoot ? join(sourceRoot, ".factory/hooks/holdout_fence.py") : null;
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

  // 6. Ensure .factory/lessons.jsonl, .factory/codebase-rules.json, .factory/holdout/HOLDOUT.md, .ignore
  const lessonsPath = join(targetRoot, ".factory/lessons.jsonl");
  if (!existsSync(lessonsPath)) {
    mkdirSync(dirname(lessonsPath), { recursive: true });
    writeFileSync(lessonsPath, "", "utf-8");
    createdOrUpdatedPaths.push(lessonsPath);
  }

  const codebaseRulesPath = join(targetRoot, ".factory/codebase-rules.json");
  if (!existsSync(codebaseRulesPath)) {
    mkdirSync(dirname(codebaseRulesPath), { recursive: true });
    writeFileSync(
      codebaseRulesPath,
      JSON.stringify(
        {
          schema_version: 1,
          description:
            "Domain-agnostic codebase conventions & shared pattern registry (Backend, Frontend, Mobile, CLI, Database) enforced by loop-guard.ts",
          rules: [],
          pattern_registry: {
            contracts:
              "Define shared schemas, DTOs, and domain types in dedicated contract/type modules with zero explicit 'any'.",
            persistence:
              "Execute database and external storage operations through repository/service abstractions and transactional migration helpers.",
            error_handling:
              "Return typed domain errors and structured status codes rather than silent catch blocks or raw exception strings.",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    createdOrUpdatedPaths.push(codebaseRulesPath);
  }

  const holdoutMdPath = join(targetRoot, ".factory/holdout/HOLDOUT.md");
  if (!existsSync(holdoutMdPath)) {
    mkdirSync(dirname(holdoutMdPath), { recursive: true });
    writeFileSync(holdoutMdPath, defaultHoldoutMd(), "utf-8");
    createdOrUpdatedPaths.push(holdoutMdPath);
  }

  const ignorePath = join(targetRoot, ".ignore");
  if (!existsSync(ignorePath)) {
    writeFileSync(ignorePath, ".factory/holdout/\n", "utf-8");
    createdOrUpdatedPaths.push(ignorePath);
  } else {
    const igContent = readFileSync(ignorePath, "utf-8");
    if (!igContent.includes(".factory/holdout")) {
      writeFileSync(ignorePath, igContent.trimEnd() + "\n.factory/holdout/\n", "utf-8");
      createdOrUpdatedPaths.push(ignorePath);
    }
  }

  // 7. Ensure FACTORY.md, FACTORY_RULES.md, and harness/ci.ts
  const factoryMdPath = join(targetRoot, "FACTORY.md");
  if (!existsSync(factoryMdPath)) {
    writeFileSync(
      factoryMdPath,
      [
        "# Factory Operations",
        "",
        "Managed by Animus CLI (`animus`).",
        "- Holdout scenarios: `.factory/holdout/HOLDOUT.md`",
        "- Ordinary checks: `bun harness/ci.ts`",
        "",
      ].join("\n"),
      "utf-8",
    );
    createdOrUpdatedPaths.push(factoryMdPath);
  }

  const factoryRulesPath = join(targetRoot, "FACTORY_RULES.md");
  if (!existsSync(factoryRulesPath)) {
    writeFileSync(
      factoryRulesPath,
      [
        "# Project Workflow Guidance",
        "",
        "Preserve scope, tests, security invariants, and secrets.",
        "Irreversible actions (auth changes, destructive migrations) require human approval.",
        "",
      ].join("\n"),
      "utf-8",
    );
    createdOrUpdatedPaths.push(factoryRulesPath);
  }

  const harnessCiPath = join(targetRoot, "harness/ci.ts");
  if (!existsSync(harnessCiPath)) {
    mkdirSync(dirname(harnessCiPath), { recursive: true });
    writeFileSync(harnessCiPath, defaultHarnessCiTs(), "utf-8");
    createdOrUpdatedPaths.push(harnessCiPath);
  }

  return {
    auditBefore,
    agentsMdActionTaken,
    agentsMdBackupPath,
    createdOrUpdatedPaths,
    skillsCopied,
  };
}
