import { resolve } from "node:path";
import {
  readCatalog,
  readDiagnostics,
  readLaps,
  readLapDetail,
  readLapEvidence,
  readLapReport,
  launchNativeLap,
} from "../../../apps/engine-host/src/native";

export async function runEngineCommand(opts: {
  subcommand?: string;
  repoRoot: string;
  host?: string;
  port?: number;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "doctor";

  if (sub === "serve") {
    const host = opts.host ?? "127.0.0.1";
    const port = opts.port ?? 4001;
    const script = resolve(opts.repoRoot, "apps/engine-host/src/main.ts");
    const child = Bun.spawn(
      [process.execPath, script, "--port", String(port), "--host", host, "--root", opts.repoRoot],
      {
        cwd: opts.repoRoot,
        env: {
          ...process.env,
          FACTORY_HOST_TOKEN:
            process.env.FACTORY_HOST_TOKEN ?? "standalone_local_host_token_0000000000000000",
        },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    return await child.exited;
  }

  if (sub === "doctor" || sub === "diagnostics") {
    try {
      const diag = readDiagnostics(opts.repoRoot);
      if (opts.json) {
        console.log(JSON.stringify(diag, null, 2));
      } else {
        console.log(`Engine Status:      ${diag.status.toUpperCase()}`);
        console.log(`Required Revision:  ${diag.revision_required}`);
        console.log(`Source Directory:   ${diag.source_directory}`);
        console.log(
          `Workflows Loaded:   ${diag.default_workflows_loaded ? "yes" : "no"} (${diag.file_count} files)`,
        );
        console.log(`Pack Digest:        ${diag.digest}`);
      }
      return diag.status === "healthy" ? 0 : 1;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`Error: ${msg}`);
      return 1;
    }
  }

  if (sub === "catalog" || sub === "workflows") {
    try {
      const cat = readCatalog(opts.repoRoot);
      if (opts.json) {
        console.log(JSON.stringify(cat, null, 2));
      } else {
        console.log(`Registered Engine Workflows (${cat.workflows.length}):`);
        for (const wf of cat.workflows) {
          console.log(`  - ${wf.name.padEnd(22)} ${wf.description}`);
        }
      }
      return 0;
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
      else console.error(`Error: ${msg}`);
      return 1;
    }
  }

  const msg = `Unknown engine subcommand: ${sub}. Expected serve, doctor, or catalog.`;
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
  else console.error(`Error: ${msg}`);
  return 1;
}

export async function runLapCommand(opts: {
  subcommand?: string;
  positionals: string[];
  repoRoot: string;
  runId?: string;
  json?: boolean;
}): Promise<number> {
  const sub = opts.subcommand ?? "list";
  const targetId = opts.runId ?? opts.positionals[2];

  try {
    if (sub === "list") {
      const laps = readLaps(opts.repoRoot);
      if (opts.json) {
        console.log(JSON.stringify(laps, null, 2));
      } else if (laps.length === 0) {
        console.log("No Animus engine laps found.");
      } else {
        console.log(`Animus Engine Laps (${laps.length}):`);
        for (const lap of laps) {
          console.log(`  ${lap.id}  [${lap.product_status}]  ${lap.started_at ?? "unknown"}`);
        }
      }
      return 0;
    }

    if (sub === "get" || sub === "status") {
      if (!targetId) throw new Error("Usage: factory lap get <lap-id>");
      const detail = readLapDetail(opts.repoRoot, targetId);
      if (opts.json) {
        console.log(JSON.stringify(detail, null, 2));
      } else {
        console.log(`Lap ID:         ${detail.id}`);
        console.log(`Workflow:       ${detail.workflow_name}`);
        console.log(`Native Status:  ${detail.native_status}`);
        console.log(`Product Status: ${detail.product_status}`);
        console.log(`Candidate Head: ${detail.candidate_head ?? "none"}`);
        console.log(`Started At:     ${detail.started_at ?? "unknown"}`);
      }
      return 0;
    }

    if (sub === "evidence") {
      if (!targetId) throw new Error("Usage: factory lap evidence <lap-id>");
      const ev = readLapEvidence(opts.repoRoot, targetId);
      if (opts.json) {
        console.log(JSON.stringify(ev, null, 2));
      } else {
        console.log(`Lap Evidence (${ev.id}):`);
        console.log(`  Candidate Head:       ${ev.candidate_head ?? "none"}`);
        console.log(
          `  Runtime Verification: ${ev.runtime_verification.status} (verdict: ${ev.runtime_verification.verdict})`,
        );
        console.log(
          `  Peer Review:          ${ev.peer_review.status} (outcome: ${ev.peer_review.outcome})`,
        );
      }
      return 0;
    }

    if (sub === "report") {
      if (!targetId) throw new Error("Usage: factory lap report <lap-id>");
      const report = readLapReport(opts.repoRoot, targetId);
      if (opts.json) {
        console.log(JSON.stringify({ id: targetId, report }, null, 2));
      } else {
        console.log(report);
      }
      return 0;
    }

    if (sub === "run" || sub === "launch") {
      const spec = opts.positionals.slice(2).join(" ").trim();
      if (!spec) {
        throw new Error('Usage: factory lap run "<specification>"');
      }
      const ack = launchNativeLap(opts.repoRoot, spec);
      if (opts.json) {
        console.log(JSON.stringify(ack, null, 2));
      } else {
        console.log(`Launched supervised lap ${ack.id} (status: ${ack.status})`);
      }
      return 0;
    }

    throw new Error(`Unknown lap subcommand: ${sub}. Expected list, get, run, evidence, or report.`);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(`Error: ${msg}`);
    return 1;
  }
}
