import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { IssueDossier } from "./dossier";
import { learningMutationSchema, learningVerdictSchema, type LearningCommandRecord, type LearningEvaluator, type LearningMutation } from "./learning-schema";
import { evaluateLearningWithHarness, resolveLearningEvidence, validateLearningMutation } from "./learning-gates";
import { processRun } from "./process";
import type { AgentTransport } from "./types";

export interface LearningDeliveryRequest {
  root: string; proposalPath: string; verifiedCandidate: string; baseBranch: string;
  dossier: IssueDossier; evidenceRoots: Record<string, string>; commandRecords?: LearningCommandRecord[];
  proposalEvaluator?: LearningEvaluator; publish?: boolean;
  acceptedBase?: string;
  sourceDeliveryPr?: string;
  category?: "lightweight" | "structural";
  checks?: string[][];
  transport?: LearningDeliveryTransport;
  agentTransport?: AgentTransport;
}
export type LearningDeliveryTransport = (request: { argv: string[]; cwd: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export interface LearningDeliveryOutcome {
  status: "proposed" | "held" | "error"; kind?: "lightweight" | "structural";
  reviewRequired: true; worktree?: string; branch?: string; deliveryHead?: string; prUrl?: string; reasons: string[];
}
const execute = promisify(execFile);
const productionTransport: LearningDeliveryTransport = async ({ argv, cwd }) => {
  try { const result = await execute(argv[0]!, argv.slice(1), { cwd, timeout: 120000, maxBuffer: 4_000_000 }); return { exitCode: 0, ...result }; }
  catch (error) { const failure = error as { code?: number; stdout?: string; stderr?: string }; return { exitCode: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "command_failed" }; }
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const provenanceSchema = z.strictObject({ runId: z.string().min(1), candidate: z.string().min(1), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) });
const memoryLessonSchema = z.object({ id: z.string().min(1), topic: z.string().min(1), rule: z.string().min(1), trigger_patterns: z.array(z.string()), evidence: z.string(), vetoed: z.boolean(), created_at: z.string(), occurrence_count: z.number().int().nonnegative().optional(), revision_id: z.string().optional(), provenance: z.array(provenanceSchema).optional(), superseded_by: z.string().optional() }).strict();
const rulesMemorySchema = z.strictObject({ schema_version: z.literal(1), description: z.string().optional(), rules: z.array(z.strictObject({ id: z.string(), description: z.string(), file_glob: z.string(), forbid_regex: z.string().optional(), require_regex: z.string().optional(), replacement_hint: z.string(), mode: z.enum(["warn", "block"]).optional() })), pattern_registry: z.record(z.string(), z.union([z.string(), z.strictObject({ file_glob: z.string(), guidance: z.string() })])).optional(), component_registry: z.record(z.string(), z.string()).optional() });

function readMemory(worktree: string, path: string): string {
  let current = worktree;
  for (const part of path.split("/")) {
    current = join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("symlink_memory_target");
  }
  if (!existsSync(current)) return "";
  if (!lstatSync(current).isFile()) throw new Error("invalid_memory_target");
  return readFileSync(current, "utf8");
}
function writeMemory(worktree: string, path: string, content: string): void {
  readMemory(worktree, path); mkdirSync(dirname(join(worktree, path)), { recursive: true }); writeFileSync(join(worktree, path), content);
}

function resolveMemoryPath(worktree: string, animusRel: string, factoryRel: string): string {
  if (existsSync(join(worktree, animusRel)) || !existsSync(join(worktree, factoryRel))) {
    return animusRel;
  }
  return factoryRel;
}

function applyMutation(worktree: string, mutation: LearningMutation): string[] {
  if (mutation.category === "lesson") {
    const path = resolveMemoryPath(worktree, ".animus/lessons.jsonl", ".factory/lessons.jsonl");
    const entries = readMemory(worktree, path).split("\n").filter(Boolean).map(line => memoryLessonSchema.parse(JSON.parse(line)));
    const topic = mutation.value.topic.toLowerCase();
    if (entries.some(e => typeof e.topic === "string" && e.topic.toLowerCase() === topic && e.vetoed === true)) throw new Error("operator_veto_topic");
    const revision = digest(JSON.stringify({ topic, rule: mutation.value.rule.trim(), trigger_patterns: [...mutation.value.trigger_patterns].sort() }));
    const provenance = mutation.evidence.map(e => ({ runId: e.runId, candidate: e.candidate, evidenceHash: digest(JSON.stringify(e)) }));
    const existing = entries.find(e => e.topic.toLowerCase() === topic && e.revision_id === revision && !e.superseded_by);
    const supports = new Map<string, (typeof provenance)[number]>();
    if (existing && Array.isArray(existing.provenance)) for (const item of existing.provenance) {
      if (typeof item.runId === "string" && typeof item.candidate === "string" && typeof item.evidenceHash === "string") supports.set(`${item.runId}:${item.evidenceHash}`, item);
    }
    for (const item of provenance) supports.set(`${item.runId}:${item.evidenceHash}`, item);
    const support = [...supports.values()];
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const seq = String(entries.length + 1).padStart(2, "0");
    const entry = { id: existing?.id ?? `lsn-${date}-${seq}`, ...mutation.value, topic, revision_id: revision, provenance: support, occurrence_count: new Set(support.map(p => p.runId)).size, vetoed: false, created_at: existing?.created_at ?? new Date().toISOString() };
    if (existing) entries[entries.indexOf(existing)] = entry;
    else {
      // Retain prior revisions for audit without lending their support to changed meaning.
      for (const previous of entries) if (previous.topic.toLowerCase() === topic && !previous.superseded_by) previous.superseded_by = revision;
      entries.push(entry);
    }
    writeMemory(worktree, path, entries.map(e => JSON.stringify(e)).join("\n") + "\n"); return [path];
  }
  if (mutation.category === "tool") {
    const path = resolveMemoryPath(worktree, ".animus/tool-guidance.json", ".factory/tool-guidance.json"); const current = z.record(z.string(), z.string()).parse(JSON.parse(readMemory(worktree, path) || "{}"));
    current[mutation.key] = mutation.value.command; writeMemory(worktree, path, JSON.stringify(current, null, 2) + "\n"); return [path];
  }
  if (mutation.category === "pattern" || mutation.category === "guard") {
    const path = resolveMemoryPath(worktree, ".animus/codebase-rules.json", ".factory/codebase-rules.json"); const current = rulesMemorySchema.parse(JSON.parse(readMemory(worktree, path) || '{"schema_version":1,"rules":[],"pattern_registry":{}}'));
    if (mutation.category === "pattern") { current.pattern_registry ??= {}; current.pattern_registry[mutation.key] = mutation.value; }
    else { current.rules ??= []; current.rules = current.rules.filter((r: { id: string }) => r.id !== mutation.value.id); const { fixtures: _, ...rule } = mutation.value; current.rules.push(rule); }
    writeMemory(worktree, path, JSON.stringify(current, null, 2) + "\n"); return [path];
  }
  const skill = mutation.value; const path = `.agents/skills/${skill.skill_name}/SKILL.md`;
  writeMemory(worktree, path, skill.skill_markdown + "\n");
  const agents = readMemory(worktree, "AGENTS.md"); const pointer = skill.agents_md_pointer;
  const updated = agents.includes(pointer) ? agents : agents.trimEnd() + "\n" + pointer + "\n";
  if (updated.trimEnd().split("\n").length > 150) throw new Error("agents_line_budget");
  writeMemory(worktree, "AGENTS.md", updated); return [path, "AGENTS.md"];
}

export const LEARNING_LEDGER_PATH = ".animus/learning-history/ledger.jsonl";
export const HARNESS_CHANGELOG_PATH = ".animus/learning-history/HARNESS-CHANGELOG.md";

const ledgerEntrySchema = z.strictObject({
  at: z.string().min(1),
  issueNumber: z.number().int(),
  branch: z.string().min(1),
  sourceCandidate: z.string().regex(/^[a-f0-9]{40,64}$/),
  receipt: z.string().regex(/^[a-f0-9]{64}$/),
  mutations: z.array(z.strictObject({ category: z.string().min(1), key: z.string().min(1) })).min(1),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** The one readable answer to "what changed in the harness", newest first. */
export function renderHarnessChangelog(entries: LedgerEntry[]): string {
  const lines = [
    "# Harness changelog",
    "",
    "Generated from `.animus/learning-history/ledger.jsonl`; do not edit by hand.",
    "",
  ];
  if (!entries.length) {
    lines.push("_No learning deliveries recorded yet._", "");
    return lines.join("\n");
  }
  const byDate = new Map<string, LedgerEntry[]>();
  for (const entry of entries) {
    const date = entry.at.slice(0, 10);
    const bucket = byDate.get(date);
    if (bucket) bucket.push(entry);
    else byDate.set(date, [entry]);
  }
  for (const date of [...byDate.keys()].sort().reverse()) {
    lines.push(`## ${date}`, "");
    for (const entry of [...byDate.get(date)!].reverse()) {
      const summary = entry.mutations.map(m => `\`${m.category}:${m.key}\``).join(", ");
      lines.push(`- #${entry.issueNumber} — ${summary} — \`${entry.branch}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Append one delivery to the ledger and regenerate the changelog from every readable line. */
function appendLedgerEntry(worktree: string, entry: LedgerEntry): void {
  const appended = JSON.stringify(ledgerEntrySchema.parse(entry));
  const kept = readMemory(worktree, LEARNING_LEDGER_PATH)
    .split("\n")
    .filter(Boolean);
  writeMemory(worktree, LEARNING_LEDGER_PATH, [...kept, appended].join("\n") + "\n");
  const readable = [...kept, appended].flatMap(line => {
    try {
      return [ledgerEntrySchema.parse(JSON.parse(line))];
    } catch {
      return [];
    }
  });
  writeMemory(worktree, HARNESS_CHANGELOG_PATH, renderHarnessChangelog(readable));
}

/** Creates a reviewed delivery candidate, never merges or activates memory. */
export async function deliverLearningProposal(options: LearningDeliveryRequest): Promise<LearningDeliveryOutcome> {
  const result: LearningDeliveryOutcome = { status: "held", reviewRequired: true, reasons: [] };
  const transport = options.transport ?? productionTransport;
  async function run(cwd: string, ...argv: string[]): Promise<string> {
    const output = await transport({ cwd, argv }); if (output.exitCode !== 0) throw new Error(`delivery_command_failed:${argv[0]}:${argv[1]}`); return output.stdout.trim();
  }
  try {
    if (!/^[a-f0-9]{40,64}$/.test(options.verifiedCandidate) || !options.baseBranch || options.baseBranch.startsWith("-")) throw new Error("invalid_delivery_ref");
    if (lstatSync(options.proposalPath).isSymbolicLink() || !lstatSync(options.proposalPath).isFile() || lstatSync(options.proposalPath).size > 4_000_000) throw new Error("invalid_proposal_artifact");
    const raw: unknown = JSON.parse(readFileSync(options.proposalPath, "utf8"));
    const artifact = raw as { schema_version?: unknown; status?: unknown; issueNumber?: unknown; accepted?: unknown[] };
    if (artifact.schema_version !== 1 || artifact.status !== "proposed" || artifact.issueNumber !== options.dossier.issueNumber || !Array.isArray(artifact.accepted) || !artifact.accepted.length || artifact.accepted.length > 50) throw new Error("invalid_delivery_proposal");
    const agentTransport: AgentTransport =
      options.agentTransport ??
      (options.transport
        ? async (req) => {
            const res = await options.transport!({ argv: req.argv, cwd: req.cwd });
            return { ...res, timedOut: false };
          }
        : (req) => processRun(req.argv, req.cwd, req.timeoutMs, req.env));
    const defaultEvaluator: LearningEvaluator = (m, ev) =>
      evaluateLearningWithHarness(m, ev, {
        root: options.root,
        cwd: options.root,
        transport: agentTransport,
      });
    const evaluator = options.proposalEvaluator ?? defaultEvaluator;
    const mutations: LearningMutation[] = [];
    for (const item of artifact.accepted) {
      const mutation = learningMutationSchema.parse((item as { mutation?: unknown })?.mutation);
      const evidence = mutation.evidence.map(e => resolveLearningEvidence(e, options.dossier, options.evidenceRoots));
      const stored = (item as { evidence?: Array<{ sha256?: string }> }).evidence;
      if (!stored || stored.length !== evidence.length || evidence.some((e, i) => e.sha256 !== stored[i]?.sha256)) throw new Error("evidence_changed_since_reflection");
      validateLearningMutation(mutation, options.commandRecords ?? [], options.dossier, options.evidenceRoots);
      const verdict = learningVerdictSchema.parse(await evaluator(mutation, evidence));
      if (!verdict.grounding.approved || verdict.grounding.confidence < .7 || !verdict.quality.approved || verdict.quality.confidence < .7 || verdict.hallucinationRisk !== "grounded_in_logs") throw new Error("delivery_evaluation_rejected");
      mutations.push(mutation);
    }
    const structural = (m: LearningMutation) => ["pattern", "guard", "skill"].includes(m.category);
    const kinds = new Set(mutations.map(m => structural(m) ? "structural" : "lightweight"));
    if (kinds.size > 1 && !options.category) throw new Error("mixed_proposal_select_delivery_category");
    result.kind = options.category ?? (structural(mutations[0]!) ? "structural" : "lightweight");
    const selected = mutations.filter(m => (structural(m) ? "structural" : "lightweight") === result.kind);
    if (!selected.length) throw new Error("no_mutations_for_delivery_category");
    const root = realpathSync(options.root);
    // Pin the source commit, but never check out or modify the verified checkout.
    if (await run(root, "git", "rev-parse", `${options.verifiedCandidate}^{commit}`) !== options.verifiedCandidate) throw new Error("candidate_not_commit");
    const acceptedBase = options.acceptedBase ?? await run(root, "git", "rev-parse", `refs/heads/${options.baseBranch}^{commit}`);
    if (!/^[a-f0-9]{40,64}$/.test(acceptedBase) || await run(root, "git", "rev-parse", `${acceptedBase}^{commit}`) !== acceptedBase) throw new Error("invalid_accepted_base");
    const branch = `learning/${options.dossier.issueNumber}-${randomUUID()}`;
    const parent = mkdtempSync(join(tmpdir(), "animus-learning-delivery-")); const worktree = join(parent, "checkout");
    const deliveryBase = options.acceptedBase ?? (result.kind === "structural" ? acceptedBase : options.verifiedCandidate);
    await run(root, "git", "worktree", "add", "-b", branch, worktree, deliveryBase);
    result.worktree = worktree; result.branch = branch;
    const paths = [...new Set(selected.flatMap(m => applyMutation(worktree, m)))];
    const receipt = {
      schema_version: 1, sourceCandidate: options.verifiedCandidate, acceptedBase,
      issueNumber: options.dossier.issueNumber, category: result.kind,
      accepted: artifact.accepted.filter(item => selected.some(m => JSON.stringify(m) === JSON.stringify((item as { mutation?: unknown }).mutation))),
      commandRecords: (options.commandRecords ?? []).filter(record => selected.some(m => m.category === "tool" && m.value.executionId === record.executionId)),
    };
    const receiptContent = JSON.stringify(receipt, null, 2) + "\n";
    const receiptPath = `.animus/learning-history/${digest(receiptContent)}.json`;
    // Preserve a versioned evidence/verdict receipt with the reviewed mutation.
    // A replay that changes no memory is held below rather than creating audit-only churn.
    const changedMemory = (await run(worktree, "git", "status", "--porcelain", "--", ...paths)).length > 0;
    if (changedMemory) {
      writeMemory(worktree, receiptPath, receiptContent);
      paths.push(receiptPath);
      appendLedgerEntry(worktree, {
        at: new Date().toISOString(),
        issueNumber: options.dossier.issueNumber,
        branch,
        sourceCandidate: options.verifiedCandidate,
        receipt: digest(receiptContent),
        mutations: selected.map(m => ({ category: m.category, key: m.key })),
      });
      paths.push(LEARNING_LEDGER_PATH, HARNESS_CHANGELOG_PATH);
    }
    await run(worktree, "git", "add", "--", ...paths);
    const staged = (await run(worktree, "git", "diff", "--cached", "--name-only")).split("\n").filter(Boolean);
    if (!staged.length) { result.reasons.push("no_new_learning"); return result; }
    if (staged.some(p => !paths.includes(p))) throw new Error("unexpected_delivery_change");
    const checks = options.checks ?? [
      ["git", "diff", "--cached", "--check"],
      ...(existsSync(join(worktree, "tests/integration/learning-reflection.bun.test.ts")) && existsSync(join(worktree, "tests/integration/learning-delivery.bun.test.ts"))
        ? [["bun", "test", "tests/integration/learning-reflection.bun.test.ts", "tests/integration/learning-delivery.bun.test.ts"]] : []),
    ];
    const stagedBeforeChecks = await run(worktree, "git", "diff", "--cached", "--binary");
    if (!checks.length || checks.some(argv => !argv.length)) throw new Error("delivery_checks_required");
    for (const argv of checks) await run(worktree, ...argv);
    if (await run(worktree, "git", "diff", "--cached", "--binary") !== stagedBeforeChecks || await run(worktree, "git", "diff", "--binary")) throw new Error("delivery_checks_changed_candidate");
    const reviewedTree = await run(worktree, "git", "write-tree");
    await run(worktree, "git", "commit", "-m", `Propose ${result.kind} learning for issue #${options.dossier.issueNumber}`);
    result.deliveryHead = await run(worktree, "git", "rev-parse", "HEAD");
    if (await run(worktree, "git", "rev-parse", "HEAD^{tree}") !== reviewedTree || await run(worktree, "git", "status", "--porcelain")) throw new Error("delivery_hook_changed_candidate");
    if (options.publish !== false) {
      await run(worktree, "git", "push", "--set-upstream", "origin", branch);
      const prBodyLines = [
        `Learning proposal only; independent review and candidate-bound checks required before merge.`,
        options.sourceDeliveryPr ? `Source delivery PR: ${options.sourceDeliveryPr}` : undefined,
        `Verified source candidate: ${options.verifiedCandidate}`,
        `Delivery candidate: ${result.deliveryHead}`,
        `Mutations: ${mutations.map(m => `${m.category}:${m.key}`).join(", ")}`,
        `No automatic activation or merge.`,
      ].filter(Boolean);
      const url = await run(worktree, "gh", "pr", "create", "--draft", "--base", options.baseBranch, "--head", branch, "--title", `Review ${result.kind} learning for #${options.dossier.issueNumber}`, "--body", prBodyLines.join("\n"));
      if (!/^https:\/\/[^\s]+\/pull\/\d+$/.test(url)) throw new Error("invalid_delivery_pr_url");
      result.prUrl = url;
    }
    result.status = "proposed"; return result;
  } catch (error) { result.reasons.push(error instanceof Error ? error.message : "delivery_failed"); return result; }
}
