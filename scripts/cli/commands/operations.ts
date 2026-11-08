import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyControlAction, readControlState } from "../../../apps/engine-host/src/native";
import { PromotionService } from "../../../apps/engine-host/src/promotion";
import { IntakeService } from "../../../apps/backend/src/intake";
import { initializeDatabase } from "../../../apps/backend/src/registry";
import { ProjectRegistryService } from "../../../apps/backend/src/registry/service";
import { BrakeService } from "../../../apps/backend/src/command/brakes";
import { resolveAnimusStateDir, resolveProjectWorkspace, evaluateWorkspacePreflight, resolveTriageStateRoot } from "../../../packages/contracts/src/paths";
import type { RunTriagePassOptions, TriagePassResult } from "../../loop/triage";
import {
  createRegistrationClient,
  registerRepository,
  registrationErrorMessage,
  type FactoryConnectionOptions,
} from "./onboarding-registration";
import { CommandService } from "../../../apps/backend/src/command";
import type { ControlAction, DraftAnswerInput, DraftRecord, Project, WorkRecord } from "@animus/contracts/operator";

export async function runControlCommand(opts: {
  subcommand?: string;
  repoRoot: string;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "status";
  try {
    if (sub === "status") {
      const state = readControlState(opts.repoRoot);
      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        console.log(`Launch Brakes: ${state.active_brake.toUpperCase()}`);
        console.log(`  Halted (STOP):  ${state.halted}`);
        console.log(`  Paused (PAUSE): ${state.paused}`);
      }
      return 0;
    }

    if (["halt", "unhalt", "pause", "unpause"].includes(sub)) {
      const state = applyControlAction(opts.repoRoot, sub as ControlAction);
      if (opts.json) {
        console.log(JSON.stringify(state, null, 2));
      } else {
        console.log(
          `Applied '${sub}' -> active_brake=${state.active_brake} (halted=${state.halted}, paused=${state.paused})`,
        );
      }
      return 0;
    }

    throw new Error(
      `Unknown control subcommand: ${sub}. Expected status, halt, unhalt, pause, or unpause.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runPromotionCommand(opts: {
  subcommand?: string;
  repoRoot: string;
  title?: string;
  body?: string;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "status";
  const service = new PromotionService(opts.repoRoot);

  try {
    if (sub === "status") {
      const status = service.getStatus();
      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`Promotion Status (${status.develop_branch} -> ${status.main_branch}):`);
        console.log(`  Unpromoted Commits: ${status.unpromoted_count}`);
        console.log(
          `  Delivered Tickets:  ${status.delivered_tickets.map((t) => `#${t}`).join(", ") || "none"}`,
        );
        console.log(`  Candidate Freeze:   ${status.candidate_freeze}`);
        console.log(`  Ready to Promote:   ${status.ready_to_promote}`);
        if (status.existing_pr) {
          console.log(
            `  Existing PR:        #${status.existing_pr.number} (${status.existing_pr.url})`,
          );
        }
      }
      return 0;
    }

    if (sub === "prepare") {
      const res = service.preparePromotion({
        title: opts.title,
        summary: opts.body,
      });
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`Prepared promotion PR #${res.pr_number}: ${res.pr_url}`);
        console.log(`Candidate freeze active: ${res.candidate_freeze}`);
      }
      return 0;
    }

    throw new Error(`Unknown promotion subcommand: ${sub}. Expected status or prepare.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export interface IntakeCommandOptions {
  subcommand?: string;
  positionals: string[];
  repoRoot?: string;
  issue?: string;
  dryRun?: boolean;
  stateDir?: string;
  refresh?: boolean;
  json?: boolean;
  triageRunner?: (options: RunTriagePassOptions) => Promise<TriagePassResult>;
}

function findConsoleDb(
  repoRoot: string,
  stateDir?: string,
): { path: string | null; explicit: boolean } {
  if (stateDir) {
    const candidate = join(stateDir, "console.db");
    if (existsSync(candidate)) return { path: candidate, explicit: true };
    throw new Error(`Explicit state directory '${stateDir}' does not contain console.db`);
  }
  const inRepo = join(repoRoot, ".factory/state/console.db");
  if (existsSync(inRepo)) return { path: inRepo, explicit: false };

  const inAnimusState = join(resolveAnimusStateDir(), "console.db");
  if (existsSync(inAnimusState)) return { path: inAnimusState, explicit: false };

  try {
    const gitRes = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: repoRoot });
    if (gitRes.exitCode === 0) {
      const common = resolve(repoRoot, gitRes.stdout.toString().trim());
      const inCommon = join(common, "factory-local-loop", "console.db");
      if (existsSync(inCommon)) return { path: inCommon, explicit: false };
      const inCommonState = join(common, "state", "console.db");
      if (existsSync(inCommonState)) return { path: inCommonState, explicit: false };
    }
  } catch {}

  const inParentState = join(resolve(repoRoot, ".."), ".factory/state/console.db");
  if (existsSync(inParentState)) return { path: inParentState, explicit: false };

  return { path: null, explicit: false };
}

async function handleIntakeTriage(opts: IntakeCommandOptions): Promise<number> {
  const root = resolve(opts.repoRoot ?? process.cwd());
  const stateRoot = resolveTriageStateRoot(root, opts.stateDir);

  let db: ReturnType<typeof initializeDatabase> | null = null;
  let project: Project | null = null;

  try {
    const dbInfo = findConsoleDb(root, opts.stateDir);
    if (dbInfo.path) {
      try {
        db = initializeDatabase(dbInfo.path);
      } catch (err: any) {
        throw new Error(
          `Failed to initialize registry database at '${dbInfo.path}': ${err?.message || String(err)}`,
        );
      }

      const registry = new ProjectRegistryService(db);
      let realRoot = root;
      try {
        realRoot = realpathSync(root);
      } catch {}
      for (const p of registry.listProjects()) {
        try {
          if (realpathSync(p.checkout_path) === realRoot || resolve(p.checkout_path) === root) {
            project = p;
            break;
          }
        } catch {}
      }

      if (project) {
        // Identity verify project actual origin against registry; held/disabled project don't run
        if (project.status !== "active") {
          const reason = project.status_reason ? ` (${project.status_reason})` : "";
          throw new Error(
            `Registered project '${project.repo_name}' is not active (status: ${project.status}${reason})`,
          );
        }

        let actualOrigin: string | null = null;
        try {
          const originRes = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
            cwd: root,
          });
          if (originRes.exitCode === 0) {
            const url = originRes.stdout.toString().trim();
            const match = /(?:github\.com[:/]|git@github\.com:)([^/]+)\/([^/.]+)(?:\.git)?$/.exec(
              url,
            );
            if (match && match[1] && match[2]) {
              actualOrigin = `${match[1]}/${match[2]}`;
            }
          }
        } catch {}

        if (actualOrigin && actualOrigin.toLowerCase() !== project.repo_name.toLowerCase()) {
          throw new Error(
            `Project origin mismatch: registry expects '${project.repo_name}' but checkout origin is '${actualOrigin}'`,
          );
        }
      }
    }

    // Evaluate preflight checks (relational brakes, filesystem brakes, cascaded schedule, work window)
    let preflight;
    try {
      preflight = evaluateWorkspacePreflight(root, {
        brakes: db ? new BrakeService(db) : null,
        projectId: project ? project.id : null,
        mode: "schedule",
        ignoreCapacity: true,
      });
    } catch (schedErr: any) {
      const error = schedErr instanceof Error ? schedErr.message : String(schedErr);
      const reason = error.includes("timezone")
        ? "invalid_work_window_timezone"
        : "invalid_schedule_config";
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, action: "skipped", reason, error },
            null,
            2,
          ),
        );
      } else {
        console.error(`Error: ${error}`);
      }
      return 1;
    }

    if (!preflight.ok) {
      const reason = preflight.reason ?? "preflight_failed";
      let error = preflight.detail ?? reason;
      if (preflight.brakes.filesystem.active) {
        const brakeType = (preflight.brakes.filesystem.type ?? "brake").toUpperCase();
        const stopP = preflight.brakes.filesystem.paths.stop;
        const pauseP = preflight.brakes.filesystem.paths.pause;
        const activePath = stopP ?? pauseP ?? "";
        const isPrimary =
          activePath.startsWith(preflight.workspace.primaryRoot) && !activePath.startsWith(root);
        error = `${brakeType} brake is active${isPrimary ? " in primary checkout" : ""}`;
      } else if (preflight.brakes.relational && !preflight.brakes.relational.permitted) {
        error = `Triage blocked by brake: ${reason}`;
      } else if (!preflight.workWindow.withinWindow) {
        error = `Outside work window (${preflight.schedule.work_window?.start_time}-${preflight.schedule.work_window?.end_time} in ${preflight.schedule.work_window?.timezone})`;
      }

      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, action: "skipped", reason, error },
            null,
            2,
          ),
        );
      } else {
        console.error(`Error: ${error}`);
      }
      return 1;
    }

    // Resolve repository identity
    let repo = project?.repo_name;
    if (!repo) {
      try {
        const originRes = Bun.spawnSync(["git", "config", "--get", "remote.origin.url"], {
          cwd: root,
        });
        if (originRes.exitCode === 0) {
          const url = originRes.stdout.toString().trim();
          const match = /(?:github\.com[:/]|git@github\.com:)([^/]+)\/([^/.]+)(?:\.git)?$/.exec(
            url,
          );
          if (match && match[1] && match[2]) {
            repo = `${match[1]}/${match[2]}`;
          }
        }
      } catch {}
    }
    if (!repo) {
      try {
        const ghRes = Bun.spawnSync(["gh", "repo", "view", "--json", "nameWithOwner"], {
          cwd: root,
        });
        if (ghRes.exitCode === 0) {
          const data = JSON.parse(ghRes.stdout.toString()) as { nameWithOwner?: string };
          if (data.nameWithOwner) repo = data.nameWithOwner;
        }
      } catch {}
    }
    if (!repo) {
      throw new Error(
        "Unable to identify GitHub repository from registered projects, git remote, or gh CLI",
      );
    }

    // Parse issue number if provided
    const rawIssue =
      opts.issue ??
      (opts.positionals[2] && !opts.positionals[2].startsWith("-")
        ? opts.positionals[2]
        : undefined);
    let issueNumber: number | undefined;
    if (rawIssue) {
      const parsed = Number(rawIssue);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid issue number: ${rawIssue}`);
      }
      issueNumber = parsed;
    }

    const runner =
      opts.triageRunner ??
      (async (triageOpts: RunTriagePassOptions) => {
        const { runTriagePass } = await import("../../loop/triage");
        return runTriagePass(triageOpts);
      });

    const result = await runner({
      root,
      repo,
      stateRoot,
      issueNumber,
      dryRun: Boolean(opts.dryRun),
    });

    if (opts.json) {
      console.log(JSON.stringify({ ok: result.failureCount === 0, ...result }, null, 2));
    } else {
      console.log(
        `Triage pass complete for ${repo}: ${result.successCount} succeeded, ${result.heldCount} held, ${result.skippedCount} skipped, ${result.failureCount} failed`,
      );
      for (const item of result.processed) {
        const detail = item.action
          ? `action=${item.action}`
          : item.reason
            ? `reason=${item.reason}`
            : "";
        const err = item.error ? ` [ERROR: ${item.error}]` : "";
        console.log(
          `  #${String(item.issueNumber).padEnd(5)} [${item.status.padEnd(8)}] ${detail}${err}`,
        );
      }
    }
    return result.failureCount > 0 ? 1 : 0;
  } catch (err: any) {
    const error = err instanceof Error ? err.message : String(err);
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error }, null, 2));
    } else {
      console.error(`Error: ${error}`);
    }
    return 1;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {}
    }
  }
}

export async function runIntakeCommand(opts: IntakeCommandOptions): Promise<number> {
  const sub = opts.subcommand ?? "list";
  const intake = new IntakeService();

  try {
    if (sub === "triage") {
      return await handleIntakeTriage(opts);
    }

    if (sub === "list") {
      const backlog = await intake.evaluateBacklog(Boolean(opts.refresh));
      if (opts.json) {
        console.log(JSON.stringify(backlog, null, 2));
      } else {
        console.log(
          `Backlog Intake (${backlog.repo}): total=${backlog.total_count}, admitted=${backlog.admitted_count}, held=${backlog.held_count}, excluded=${backlog.excluded_count}`,
        );
        for (const item of backlog.issues) {
          console.log(
            `  #${String(item.number).padEnd(5)} [${item.admission_status.padEnd(8)}] ${item.title}`,
          );
        }
      }
      return 0;
    }

    if (sub === "get" || /^\d+$/.test(sub)) {
      const rawIssue = sub === "get" ? (opts.issue ?? opts.positionals[2]) : sub;
      const issueNum = Number(rawIssue);
      if (!rawIssue || !Number.isInteger(issueNum) || issueNum <= 0) {
        throw new Error("Usage: factory intake get <issue-number>");
      }
      const found = await intake.getIssue(issueNum);
      if (!found) {
        throw new Error(`Issue #${issueNum} not found in intake backlog`);
      }
      if (opts.json) {
        console.log(JSON.stringify(found, null, 2));
      } else {
        console.log(`Issue #${found.number}: ${found.title}`);
        console.log(`  Status:       ${found.admission_status}`);
        console.log(`  Reason:       ${found.reason}`);
        console.log(
          `  Dependencies: ${found.dependencies.map((d) => `#${d}`).join(", ") || "none"}`,
        );
      }
      return 0;
    }

    throw new Error(`Unknown intake subcommand: ${sub}. Expected list or get.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runWorkCommand(
  opts: FactoryConnectionOptions & {
    subcommand?: string;
    positionals: string[];
    projectId?: string;
    json?: boolean;
  },
): Promise<number> {
  const sub = opts.subcommand ?? "list";
  try {
    if (!opts.projectId) {
      throw new Error("Usage: factory work <list|get> --project <project-id>");
    }
    const scoped = createRegistrationClient(opts).forProject(opts.projectId);

    if (sub === "list") {
      const items = await scoped.work();
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else if (items.length === 0) {
        console.log("No imported work.");
      } else {
        console.log(`Imported Work (${items.length}):`);
        for (const item of items) {
          console.log(
            `  ${item.id}  #${item.issue_number}  rev=${item.revision.revision_number}  ${item.revision.source.title}`,
          );
        }
      }
      return 0;
    }

    if (sub === "get") {
      const workId = opts.positionals[2];
      if (!workId) throw new Error("Usage: factory work get <work-id> --project <project-id>");
      const record = await scoped.workItem(workId);
      if (opts.json) {
        console.log(JSON.stringify(record, null, 2));
      } else {
        printWork(record);
      }
      return 0;
    }

    throw new Error(`Unknown work subcommand: ${sub}. Expected list or get.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runDraftCommand(
  opts: FactoryConnectionOptions & {
    subcommand?: string;
    positionals: string[];
    projectId?: string;
    answers?: string;
    instructions?: string;
    revision?: string;
    reason?: string;
    json?: boolean;
  },
): Promise<number> {
  const sub = opts.subcommand ?? "list";
  try {
    if (!opts.projectId) {
      throw new Error(
        "Usage: factory draft <list|get|refine|revise|approve|reject|request-changes> --project <project-id>",
      );
    }
    const scoped = createRegistrationClient(opts).forProject(opts.projectId);

    if (sub === "list") {
      const items = await scoped.drafts();
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
      } else if (items.length === 0) {
        console.log("No drafts.");
      } else {
        console.log(`Drafts (${items.length}):`);
        for (const item of items) {
          console.log(
            `  ${item.id}  ${item.status.padEnd(19)} kind=${item.latest_revision.kind} rev=${item.latest_revision.revision_number}  ${item.source.title}`,
          );
        }
      }
      return 0;
    }

    if (sub === "get") {
      const draftId = opts.positionals[2];
      if (!draftId) throw new Error("Usage: factory draft get <draft-id> --project <project-id>");
      const record = await scoped.draft(draftId);
      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printDraft(record);
      return 0;
    }

    if (sub === "refine") {
      const workId = opts.positionals[2];
      if (!workId)
        throw new Error("Usage: factory draft refine <work-id> --project <project-id>");
      const record = await scoped.refineDraft({
        work_id: workId,
        answers: parseDraftAnswers(opts.answers),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printDraft(record);
      return 0;
    }

    if (sub === "revise") {
      const draftId = opts.positionals[2];
      if (!draftId)
        throw new Error("Usage: factory draft revise <draft-id> --project <project-id>");
      const record = await scoped.reviseDraft(draftId, {
        answers: parseDraftAnswers(opts.answers),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printDraft(record);
      return 0;
    }

    if (sub === "approve" || sub === "reject" || sub === "request-changes") {
      const draftId = opts.positionals[2];
      if (!draftId)
        throw new Error(`Usage: factory draft ${sub} <draft-id> --project <project-id>`);
      const revisionNumber = Number(opts.revision);
      if (!Number.isInteger(revisionNumber) || revisionNumber <= 0) {
        throw new Error("A positive --revision <number> is required for a draft decision");
      }
      const reason = opts.reason?.trim();
      if (!reason) throw new Error("A --reason is required for a draft decision");
      const decision = sub === "approve" ? "approve" : sub === "reject" ? "reject" : "revise";
      const record = await scoped.decideDraft(draftId, {
        revision_number: revisionNumber,
        decision,
        reason,
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      });
      if (opts.json) console.log(JSON.stringify(record, null, 2));
      else printDraft(record);
      return 0;
    }

    throw new Error(
      `Unknown draft subcommand: ${sub}. Expected list, get, refine, revise, approve, reject, or request-changes.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

function parseDraftAnswers(raw?: string): DraftAnswerInput[] {
  if (!raw) return [];
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf-8") : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("--answers must be a JSON array or @file containing one");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("--answers must be a JSON array");
  }
  return parsed as DraftAnswerInput[];
}

function printDraft(record: DraftRecord): void {
  console.log(`Draft ${record.id} (${record.status})`);
  console.log(
    `  Work:        ${record.work_id} (${record.source_provenance.repo_name}#${record.source_provenance.issue_number})`,
  );
  console.log(`  Source:      ${record.source_provenance.source_url}`);
  console.log(`  Source hash: ${record.source_content_hash}`);
  console.log(`  Revision:    ${record.latest_revision.revision_number} (${record.latest_revision.id})`);
  console.log(`  Kind:        ${record.latest_revision.kind}`);
  console.log(`  Publishable: ${record.authorization.can_publish}`);
  console.log(`  Dispatchable:${record.authorization.can_dispatch}`);
  console.log(`  Title:       ${record.source.title}`);
  const plan = record.latest_revision.plan;
  if (plan.kind === "clarification") {
    console.log("  Questions:");
    for (const question of plan.questions) {
      console.log(`    ${question.id}: ${question.question}`);
      console.log(`      reason: ${question.reason}`);
    }
    console.log(`  Reason:      ${plan.reason}`);
  } else {
    console.log(`  Plan title:  ${plan.title}`);
    console.log(`  Scope:       ${plan.scope}`);
    console.log(`  Outcome:     ${plan.outcome}`);
    console.log("  Acceptance criteria:");
    for (const criterion of plan.acceptance_criteria) {
      console.log(`    ${criterion.id}: ${criterion.description} (${criterion.verification})`);
    }
    console.log("  Verification requirements:");
    for (const requirement of plan.verification_requirements) {
      console.log(`    - ${requirement}`);
    }
    if (plan.kind === "spec") {
      console.log(`  Children (${plan.children.length}):`);
      plan.children.forEach((child) => {
        const deps = child.depends_on_indices.map((dep) => plan.children[dep]?.id ?? String(dep));
        console.log(
          `    ${child.id}: ${child.title}${deps.length ? ` (depends on ${deps.join(", ")})` : ""} covers ${child.covers_parent_ac_ids.join(", ")}`,
        );
      });
    }
  }
  if (record.latest_revision.questions.length > 0) {
    console.log("  Unresolved questions:");
    for (const question of record.latest_revision.questions) {
      console.log(`    ${question.id}: ${question.question}`);
    }
  }
  if (record.latest_revision.answers.length > 0) {
    console.log("  Answers:");
    for (const answer of record.latest_revision.answers) {
      console.log(`    ${answer.question_id}: ${answer.answer}`);
    }
  }
  if (record.latest_decision) {
    console.log(
      `  Decision:    ${record.latest_decision.decision} rev=${record.latest_decision.revision_number} (${record.latest_decision.reason})`,
    );
  }
}

function printWork(record: WorkRecord): void {
  console.log(`Work ${record.id} (${record.repo_name}#${record.issue_number})`);
  console.log(`  Revision:  ${record.revision.revision_number} (${record.revision.id})`);
  console.log(`  Hash:      ${record.revision.content_hash}`);
  console.log(`  Imported:  ${new Date(record.revision.imported_at).toISOString()}`);
  console.log(`  State:     ${record.revision.source.state}`);
  console.log(`  Labels:    ${record.revision.source.labels.join(", ") || "none"}`);
  console.log(`  Source:    ${record.revision.provenance.source_url}`);
  console.log(`  Title:     ${record.revision.source.title}`);
  console.log("  Body:");
  console.log(record.revision.source.body || "(empty)");
  if (record.revision.source.comments.length > 0) {
    console.log(`  Comments (${record.revision.source.comments.length}):`);
    for (const comment of record.revision.source.comments) {
      console.log(`    ${comment.author ?? "unknown"}: ${comment.body}`);
    }
  }
}

export async function runProjectCommand(
  opts: FactoryConnectionOptions & {
    subcommand?: string;
    positionals: string[];
    repoRoot: string;
    stateDir?: string;
    name?: string;
    path?: string;
    repo?: string;
    json?: boolean;
  },
): Promise<number> {
  const sub = opts.subcommand ?? "list";

  try {
    const service = createRegistrationClient(opts);
    if (sub === "monitoring") {
      const status = await service.monitoring();
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(
          `Factory monitoring: ${status.enabled ? "enabled" : "disabled"}${status.stopping ? " (stopping)" : ""}`,
        );
        if (status.error) console.log(`  Error: ${status.error}`);
        for (const project of status.projects) {
          console.log(`  ${project.project_id} [${project.state}] ${project.reason}`);
          if (project.error) console.log(`    Error: ${project.error}`);
          if (project.next_check_at) console.log(`    Next check: ${project.next_check_at}`);
        }
      }
      return 0;
    }
    if (sub === "list") {
      const projects = await service.projects();
      if (opts.json) {
        console.log(JSON.stringify(projects, null, 2));
      } else if (projects.length === 0) {
        console.log("No projects registered.");
      } else {
        console.log(`Registered Projects (${projects.length}):`);
        for (const p of projects) {
          console.log(`  ${p.id}  ${p.name.padEnd(20)} [${p.status}]  ${p.checkout_path}`);
        }
      }
      return 0;
    }

    if (sub === "get") {
      const id = opts.positionals[2];
      if (!id) throw new Error("Usage: factory project get <project-id>");
      const proj = await service.project(id);
      if (opts.json) {
        console.log(JSON.stringify(proj, null, 2));
      } else {
        console.log(`Project ${proj.id} (${proj.name}):`);
        console.log(`  Repository: ${proj.repo_name} (#${proj.repo_id})`);
        console.log(`  Checkout:   ${proj.checkout_path}`);
        console.log(
          `  Status:     ${proj.status}${proj.status_reason ? ` (${proj.status_reason})` : ""}`,
        );
      }
      return 0;
    }

    if (sub === "register") {
      if (opts.repo && opts.positionals[2]) {
        throw new Error("Do not combine --repo with a positional local checkout path.");
      }
      const { project: created, status } = await registerRepository({
        ...opts,
        path: opts.path ?? opts.positionals[2],
      });
      if (opts.json) {
        console.log(JSON.stringify(created, null, 2));
      } else {
        console.log(
          `${status === "existing" ? "Already registered" : "Registered"} project ${created.id} (${created.name}) -> ${created.checkout_path}`,
        );
      }
      return 0;
    }

    if (sub === "remove" || sub === "deregister") {
      const id = opts.positionals[2];
      if (!id) throw new Error("Usage: factory project remove <project-id>");
      const res = await service.deregisterProject(id);
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`Deregistered project ${res.id} (status=${res.status})`);
      }
      return 0;
    }

    throw new Error(
      `Unknown project subcommand: ${sub}. Expected list, get, register, remove, or monitoring.`,
    );
  } catch (err: unknown) {
    const msg = registrationErrorMessage(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

export async function runCommandLedgerCli(opts: {
  subcommand?: string;
  positionals: string[];
  repoRoot: string;
  stateDir?: string;
  state?: string;
  limit?: string;
  destination?: string;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "list";
  const stateDir = opts.stateDir ?? join(opts.repoRoot, ".factory/state");
  const dbPath = join(stateDir, "console.db");
  const db = initializeDatabase(dbPath);
  const service = new CommandService(db);

  try {
    if (sub === "list") {
      const limit = opts.limit ? Number(opts.limit) : undefined;
      const cmds = service.listCommands({
        state: opts.state as any,
        limit,
      });
      if (opts.json) {
        console.log(JSON.stringify(cmds, null, 2));
      } else if (cmds.length === 0) {
        console.log("No operator commands recorded.");
      } else {
        console.log(`Operator Commands (${cmds.length}):`);
        for (const c of cmds) {
          console.log(`  ${c.requestId}  [${c.state.padEnd(12)}]  ${c.action}  (${c.actor})`);
        }
      }
      return 0;
    }

    if (sub === "get") {
      const reqId = opts.positionals[2];
      if (!reqId) throw new Error("Usage: factory command get <request-id>");
      const cmd = service.getCommand(reqId);
      if (!cmd) throw new Error(`Command not found: ${reqId}`);
      if (opts.json) {
        console.log(JSON.stringify(cmd, null, 2));
      } else {
        console.log(`Command ${cmd.requestId}:`);
        console.log(`  Action: ${cmd.action}`);
        console.log(`  State:  ${cmd.state}`);
        console.log(`  Actor:  ${cmd.actor}`);
      }
      return 0;
    }

    if (sub === "reconcile") {
      const res = await service.reconcile();
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`Reconciled ${res.reconciledCount} in-flight command(s).`);
      }
      return 0;
    }

    if (sub === "backup") {
      const dest = opts.destination ?? opts.positionals[2];
      if (!dest) throw new Error("Usage: factory command backup <destination-path>");
      const res = service.backupDatabase(resolve(dest));
      if (opts.json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        console.log(`Backed up console database to ${res.destinationPath}`);
      }
      return 0;
    }

    throw new Error(
      `Unknown command subcommand: ${sub}. Expected list, get, reconcile, or backup.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {}
  }
}
