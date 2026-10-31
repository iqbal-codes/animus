import { join, resolve } from "node:path";
import { applyControlAction, readControlState } from "../../../apps/engine-host/src/native";
import { PromotionService } from "../../../apps/engine-host/src/promotion";
import { IntakeService } from "../../../apps/backend/src/intake";
import { initializeDatabase } from "../../../apps/backend/src/registry";
import {
  createRegistrationClient,
  registerRepository,
  registrationErrorMessage,
  type FactoryConnectionOptions,
} from "./onboarding-registration";
import { CommandService } from "../../../apps/backend/src/command";
import type { ControlAction } from "@animus/contracts/operator";

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

export async function runIntakeCommand(opts: {
  subcommand?: string;
  positionals: string[];
  issue?: string;
  refresh?: boolean;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "list";
  const intake = new IntakeService();

  try {
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
