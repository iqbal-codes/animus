import { existsSync, realpathSync } from "node:fs";
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
import type {
  ControlAction,
  DispatchRunDetail,
  ExecutionObservationRecord,
  FactoryFindingRecord,
  PlanDispatchRun,
  PlanKind,
  PlanRecord,
  Project,
  RunEvidenceReport,
  WorkRecord,
} from "@animus/contracts/operator";

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

export async function runPlanCommand(
  opts: FactoryConnectionOptions & {
    subcommand?: string;
    positionals: string[];
    projectId?: string;
    issue?: string;
    kind?: string;
    deliveryBranch?: string;
    reason?: string;
    actor?: string;
    expectedSequence?: string;
    amount?: string;
    idempotencyKey?: string;
    signal?: string;
    json?: boolean;
  },
): Promise<number> {
  const sub = opts.subcommand ?? "list";
  try {
    if (!opts.projectId) {
      throw new Error(
        "Usage: factory plan <list|get|import|approve|revoke|dispatch|runs|run|detail|evidence|findings|grants|grant|hold|resume|stop|takeover|reconcile> --project <project-id>",
      );
    }
    const scoped = createRegistrationClient(opts).forProject(opts.projectId);

    if (sub === "list") {
      const plans = await scoped.plans();
      if (opts.json) {
        console.log(JSON.stringify(plans, null, 2));
      } else if (plans.length === 0) {
        console.log("No admitted plans.");
      } else {
        console.log(`Plans (${plans.length}):`);
        for (const plan of plans) {
          console.log(
            `  ${plan.id}  ${plan.kind}  #${plan.root_issue_number}  ${plan.authority}  tickets=${plan.ticket_count}  holds=${plan.hold_count}`,
          );
        }
      }
      return 0;
    }

    if (sub === "get") {
      const planId = opts.positionals[2];
      if (!planId) throw new Error("Usage: factory plan get <plan-id> --project <project-id>");
      const plan = await scoped.plan(planId);
      if (opts.json) console.log(JSON.stringify(plan, null, 2));
      else printPlan(plan);
      return 0;
    }

    if (sub === "import") {
      const kind = opts.kind;
      if (kind !== "standalone" && kind !== "spec") {
        throw new Error("Usage: factory plan import <work-id> --kind <standalone|spec>");
      }
      const workId = opts.positionals[2];
      const issueNumber = opts.issue ? Number(opts.issue) : undefined;
      if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)) {
        throw new Error(`--issue must be a positive integer, got: ${opts.issue}`);
      }
      if (Boolean(workId) === Boolean(issueNumber)) {
        throw new Error(
          "Provide exactly one work id positional or --issue <number> when importing a plan.",
        );
      }
      const plan = await scoped.importPlan({
        ...(workId ? { work_id: workId } : { issue_number: issueNumber }),
        kind: kind as PlanKind,
        ...(opts.deliveryBranch ? { delivery_branch: opts.deliveryBranch } : {}),
      });
      if (opts.json) console.log(JSON.stringify(plan, null, 2));
      else printPlan(plan);
      return 0;
    }

    if (sub === "approve" || sub === "revoke") {
      const planId = opts.positionals[2];
      if (!planId) {
        throw new Error(
          `Usage: factory plan ${sub} <plan-id> --project <project-id> [--reason <text>] [--expected-sequence <n>]`,
        );
      }
      const expectedSequence = opts.expectedSequence
        ? Number(opts.expectedSequence)
        : undefined;
      if (
        expectedSequence !== undefined &&
        (!Number.isSafeInteger(expectedSequence) || expectedSequence <= 0)
      ) {
        throw new Error(
          `--expected-sequence must be a positive integer, got: ${opts.expectedSequence}`,
        );
      }
      const submission = {
        ...(opts.actor ? { actor: opts.actor } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(expectedSequence !== undefined ? { expected_sequence: expectedSequence } : {}),
      };
      const plan =
        sub === "approve"
          ? await scoped.approvePlan(planId, submission)
          : await scoped.revokePlan(planId, submission);
      if (opts.json) console.log(JSON.stringify(plan, null, 2));
      else printPlan(plan);
      return 0;
    }

    if (sub === "dispatch") {
      const planId = opts.positionals[2];
      const workId = opts.positionals[3];
      const issueNumber = opts.issue ? Number(opts.issue) : undefined;
      if (!planId) {
        throw new Error(
          "Usage: factory plan dispatch <plan-id> [work-id] [--issue <n>] --project <project-id>",
        );
      }
      if (issueNumber !== undefined && (!Number.isSafeInteger(issueNumber) || issueNumber <= 0)) {
        throw new Error(`--issue must be a positive integer, got: ${opts.issue}`);
      }
      if (workId && issueNumber !== undefined) {
        throw new Error("Provide either a work id positional or --issue, not both.");
      }
      const run = await scoped.dispatchPlan({
        plan_id: planId,
        ...(workId ? { work_id: workId } : {}),
        ...(issueNumber !== undefined ? { issue_number: issueNumber } : {}),
        ...(opts.actor ? { actor: opts.actor } : {}),
      });
      if (opts.json) console.log(JSON.stringify(run, null, 2));
      else printRun(run);
      return 0;
    }

    if (sub === "runs") {
      const planId = opts.positionals[2];
      const runs = await scoped.dispatchRuns(planId ? { planId } : undefined);
      if (opts.json) {
        console.log(JSON.stringify(runs, null, 2));
      } else if (runs.length === 0) {
        console.log("No dispatch runs.");
      } else {
        console.log(`Dispatch runs (${runs.length}):`);
        for (const run of runs) printRun(run, "  ");
      }
      return 0;
    }

    if (sub === "run") {
      const runId = opts.positionals[2];
      if (!runId) throw new Error("Usage: factory plan run <run-id> --project <project-id>");
      const run = await scoped.dispatchRun(runId);
      if (opts.json) {
        console.log(JSON.stringify(run, null, 2));
      } else {
        printRun(run);
        printEvidence(await scoped.runEvidence(runId));
      }
      return 0;
    }

    if (sub === "evidence") {
      const runId = opts.positionals[2];
      if (!runId) throw new Error("Usage: factory plan evidence <run-id> --project <project-id>");
      const report = await scoped.runEvidence(runId);
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else printEvidence(report);
      return 0;
    }

    if (sub === "findings") {
      const runId = opts.positionals[2];
      const findings = await scoped.findings(runId ? { runId } : undefined);
      if (opts.json) {
        console.log(JSON.stringify(findings, null, 2));
      } else if (findings.length === 0) {
        console.log("No findings.");
      } else {
        console.log(`Findings (${findings.length}):`);
        for (const finding of findings) printFinding(finding, "  ");
      }
      return 0;
    }

    if (sub === "reconcile") {
      const runId = opts.positionals[2];
      if (runId) {
        const run = await scoped.reconcileDispatchRun(runId);
        if (opts.json) console.log(JSON.stringify(run, null, 2));
        else printRun(run);
        return 0;
      }
      const result = await scoped.reconcileDispatch();
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `Dispatch reconciliation: retained=${result.retained.length} terminal=${result.reconciled.length}`,
        );
        for (const run of result.retained) printRun(run, "  ");
      }
      return 0;
    }

    if (sub === "detail") {
      const runId = opts.positionals[2];
      if (!runId) throw new Error("Usage: factory plan detail <run-id> --project <project-id>");
      const detail = await scoped.dispatchRunDetail(runId);
      if (opts.json) console.log(JSON.stringify(detail, null, 2));
      else printRunDetail(detail);
      return 0;
    }

    if (sub === "grants") {
      const runId = opts.positionals[2];
      const grants = await scoped.dispatchGrants(runId ? { runId } : undefined);
      if (opts.json) {
        console.log(JSON.stringify(grants, null, 2));
      } else if (grants.length === 0) {
        console.log("No budget grants.");
      } else {
        console.log(`Budget grants (${grants.length}):`);
        for (const grant of grants) printGrant(grant, "  ");
      }
      return 0;
    }

    if (sub === "grant") {
      const runId = opts.positionals[2];
      if (!runId) {
        throw new Error(
          "Usage: factory plan grant <run-id> --amount <n> --reason <text> [--actor <name>] [--idempotency-key <key>]",
        );
      }
      const amount = opts.amount ? Number(opts.amount) : NaN;
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        throw new Error(`--amount must be a positive integer, got: ${opts.amount ?? "(missing)"}`);
      }
      if (!opts.reason) throw new Error("A budget grant requires --reason");
      const result = await scoped.grantDispatchBudget(runId, {
        amount,
        reason: opts.reason,
        actor: opts.actor ?? "operator",
        ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(
          `Grant ${result.grant.id} +${result.grant.amount} (${result.replayed ? "replayed" : "new"}) `,
        );
        printBudget(result.budget, "  ");
      }
      return 0;
    }

    if (["hold", "resume", "stop", "takeover"].includes(sub)) {
      const runId = opts.positionals[2];
      if (!runId) {
        throw new Error(
          `Usage: factory plan ${sub} <run-id> --project <project-id> [--reason <text>] [--actor <name>] [--signal SIGTERM|SIGKILL]`,
        );
      }
      const result = await scoped.controlDispatchRun(runId, {
        action: sub as "hold" | "resume" | "stop" | "takeover",
        actor: opts.actor ?? "operator",
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.signal ? { signal: opts.signal as "SIGTERM" | "SIGKILL" } : {}),
      });
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`Control ${sub} -> ${result.control.status} (${result.detail})`);
        console.log(`  confirmed=${result.confirmed} command=${result.commandRequestId}`);
        printRun(result.run, "  ");
        if (result.budget) printBudget(result.budget, "  ");
      }
      return 0;
    }

    throw new Error(
      `Unknown plan subcommand: ${sub}. Expected list, get, import, approve, revoke, dispatch, runs, run, detail, evidence, findings, grants, grant, hold, resume, stop, takeover, reconcile.`,
    );
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}

function printRun(run: PlanDispatchRun, indent = ""): void {
  console.log(
    `${indent}${run.id}  #${run.issue_number}  ${run.gate_profile}  ${run.state}  lap=${run.lap}  gen=${run.ownership_generation}`,
  );
  console.log(
    `${indent}  Plan:      ${run.plan_id}  delivery=${run.delivery_id}`,
  );
  console.log(
    `${indent}  Revision:  ${run.revision_id} (${run.content_hash})`,
  );
  console.log(
    `${indent}  Owner:     ${run.owner_pid ?? "none"}  target=${run.target_branch}  merge=${run.merge_policy}`,
  );
  console.log(`${indent}  Worktree:  ${run.worktree_path}  branch=${run.branch}`);
  if (run.head_sha) console.log(`${indent}  Head:      ${run.head_sha}`);
  if (run.error) console.log(`${indent}  Error:     ${run.error}`);
}

function printRunDetail(detail: DispatchRunDetail): void {
  printRun(detail.run);
  printBudget(detail.budget, "  ");
  const control = detail.control;
  console.log(
    `  Control:   ${control ? `${control.status} (${control.reason ?? "no reason"}, by ${control.actor ?? "unknown"})` : "none"}`,
  );
  console.log(
    `  Process:   owner_pid=${detail.process.ownerPid ?? "none"} alive=${detail.process.ownerAlive} worker=${detail.process.workerPid ?? "none"}/${detail.process.workerPgid ?? "none"} alive=${detail.process.workerAlive} lock=${detail.process.worktreeLockPid ?? "none"} alive=${detail.process.worktreeLockAlive}`,
  );
  console.log(`  Attempts (${detail.attempts.length}):`);
  for (const attempt of detail.attempts) {
    console.log(
      `    lap ${attempt.lap} ${attempt.state} #${attempt.issueNumber} gen=${attempt.ownershipGeneration} head=${attempt.headSha ?? "none"}${attempt.error ? ` error=${attempt.error}` : ""}`,
    );
  }
  console.log(`  Acceptance criteria (${detail.acceptanceCriteria.length}):`);
  for (const criterion of detail.acceptanceCriteria) {
    console.log(
      `    ${criterion.acKey}${criterion.openFindingIds.length > 0 ? ` OPEN findings=${criterion.openFindingIds.length}` : ""}: ${criterion.text}`,
    );
  }
  console.log(`  Open findings (${detail.openFindings.length}):`);
  for (const finding of detail.openFindings) printFinding(finding, "    ");
  console.log(
    `  Acceptance: ${detail.acceptance.authorized ? "AUTHORIZED" : "BLOCKED"}${detail.acceptance.reasons.length > 0 ? ` (${detail.acceptance.reasons.join(", ")})` : ""}`,
  );
  if (detail.grants.length > 0) {
    console.log(`  Grants (${detail.grants.length}):`);
    for (const grant of detail.grants) printGrant(grant, "    ");
  }
}

function printBudget(budget: DispatchRunDetail["budget"], indent: string): void {
  if (!budget) {
    console.log(`${indent}Budget:    none (no attempt allocated yet)`);
    return;
  }
  console.log(
    `${indent}Budget:    ${budget.status.toUpperCase()} laps ${budget.consumedAttempts}/${budget.allowedAttempts} (base=${budget.baseLimit}, granted=${budget.grantedAttempts}, remaining=${budget.remainingAttempts})`,
  );
  if (budget.lastRejection) console.log(`${indent}  Last rejection: ${budget.lastRejection}`);
  if (budget.retainedWorktreePath) {
    console.log(`${indent}  Retained:  ${budget.retainedWorktreePath} branch=${budget.retainedBranch}`);
  }
}

function printGrant(grant: DispatchRunDetail["grants"][number], indent: string): void {
  console.log(
    `${indent}${grant.id} +${grant.amount} by ${grant.actor} (${grant.reason}) key=${grant.idempotencyKey} cmd=${grant.commandRequestId}`,
  );
}

function printEvidence(report: RunEvidenceReport): void {
  console.log("  Checks & findings:");
  console.log(`  Observations (${report.observations.length}):`);
  for (const observation of report.observations) printObservation(observation, "    ");
  console.log(`  Findings (${report.findings.length}):`);
  for (const finding of report.findings) printFinding(finding, "    ");
  const acceptance = report.acceptance;
  console.log(
    `  Acceptance: ${acceptance.authorized ? "AUTHORIZED" : "BLOCKED"}  candidate=${acceptance.candidateHeadSha ?? "none"} target=${acceptance.targetTipSha ?? "none"}`,
  );
  for (const reason of acceptance.reasons) console.log(`    blocked: ${reason}`);
}

function printObservation(observation: ExecutionObservationRecord, indent: string): void {
  console.log(
    `${indent}${observation.stage} [${observation.status}] lap=${observation.lap} producer=${observation.producer.id}(${observation.producer.role}) profile=${observation.gateProfile}@v${observation.gateProfileVersion}`,
  );
  console.log(
    `${indent}  candidate=${observation.candidateHeadSha} target=${observation.targetTipSha} merge-base=${observation.mergeBaseSha}`,
  );
  console.log(
    `${indent}  tested=${observation.testedIdentity} lineage=${observation.integrationLineage}`,
  );
  for (const check of observation.checks) {
    console.log(`${indent}  check ${check.result} ${check.name}: ${check.command}`);
    if (check.detail) console.log(`${indent}    ${check.detail}`);
  }
  for (const artifact of observation.artifacts) {
    console.log(
      `${indent}  artifact ${artifact.ownerType}:${artifact.ownerId} ${artifact.relativePath} ${artifact.sizeBytes}B sha256=${artifact.digestSha256}`,
    );
  }
}

function printFinding(finding: FactoryFindingRecord, indent: string): void {
  console.log(
    `${indent}${finding.id} [${finding.severity}/${finding.status}] #${finding.issueNumber}${finding.acKey ? ` ${finding.acKey}` : ""} ${finding.fileContext}`,
  );
  console.log(`${indent}  ${finding.summary}`);
  for (const event of finding.events) {
    console.log(
      `${indent}  ${event.sequence}. ${event.action} by ${event.actor} (${event.actorRole})${event.observationId ? ` obs=${event.observationId}` : ""}${event.detail ? `: ${event.detail}` : ""}`,
    );
  }
}

function printPlan(plan: PlanRecord): void {
  console.log(`Plan ${plan.id} (${plan.kind})`);
  console.log(`  Authority:  ${plan.authority}`);
  console.log(`  Dispatch:   ${plan.dispatchable ? "eligible" : "held"}`);
  console.log(`  Root:       #${plan.members.find((m) => m.work_id === plan.root_work_id)?.issue_number ?? "?"}`);
  console.log(`  Graph:      ${plan.graph_hash}`);
  console.log(`  Delivery:   ${plan.delivery_branch}`);
  console.log(`  Integration:${plan.integration_branch ? ` ${plan.integration_branch}` : " none"}`);
  if (plan.accepted_revision) {
    console.log(
      `  Accepted:   ${plan.accepted_revision.revision_id} (rev ${plan.accepted_revision.revision_number}, ${plan.accepted_revision.content_hash})`,
    );
  } else {
    console.log("  Accepted:   none");
  }
  console.log(`  Members (${plan.members.length}):`);
  for (const member of plan.members) {
    console.log(
      `    #${member.issue_number}  ${member.role}  ${member.gate_profile}  ${member.revision_id}  ${member.title}`,
    );
  }
  if (plan.holds.length > 0) {
    console.log(`  Holds (${plan.holds.length}):`);
    for (const item of plan.holds) {
      const member = item.issue_number ? ` #${item.issue_number}` : "";
      console.log(`    [${item.severity}] ${item.code}${member}: ${item.detail}`);
    }
  } else {
    console.log("  Holds:      none");
  }
  console.log(`  Decisions (${plan.decisions.length}):`);
  for (const decision of plan.decisions) {
    console.log(
      `    ${decision.sequence}. ${decision.action} -> ${decision.outcome} by ${decision.actor} (${decision.source})${decision.reason ? `: ${decision.reason}` : ""}`,
    );
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
