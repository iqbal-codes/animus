import { open, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export function summarize(value: string, limit = 240): string {
  const text = value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/g, "$1[REDACTED]")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function formatSessionEvent(event: any): string[] {
  if (event.type === "model_change") return [`MODEL ${event.provider}/${event.modelId}`];
  if (event.type !== "message") return [];
  const message = event.message;
  if (message?.role === "toolResult") {
    const text = Array.isArray(message.content)
      ? message.content.filter((part: any) => part.type === "text").map((part: any) => part.text ?? "").join("\n")
      : typeof message.content === "string" ? message.content : "";
    const lines = text.split("\n").map((line: string) => line.trim()).filter(Boolean);
    const significant = lines.filter((line: string) => /\b(pass(?:ed)?|fail(?:ed)?|error|tests?|exit|warning|blocked)\b/i.test(line));
    const summary = summarize((significant.length ? significant : lines).slice(-3).join(" | "));
    return [`${message.isError ? "ERROR" : "RESULT"} ${message.toolName}${typeof message.durationMs === "number" ? ` (${message.durationMs}ms)` : ""}${summary ? ` → ${summary}` : " → no text output"}`];
  }
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part: any) => {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) return [`PI ${summarize(part.text, 360)}`];
    if (part.type === "toolCall") {
      const args = part.arguments ?? {};
      let detail = "";
      if (part.name === "bash") detail = args.command ?? "";
      else if (["read", "write", "edit"].includes(part.name)) {
        detail = args.path ?? "";
        if (part.name === "read" && args.offset) detail += ` (line ${args.offset}${args.limit ? `, ${args.limit} lines` : ""})`;
        if (part.name === "edit" && Array.isArray(args.edits)) detail += ` (${args.edits.length} replacement${args.edits.length === 1 ? "" : "s"})`;
        if (part.name === "write" && typeof args.content === "string") detail += ` (${args.content.split("\n").length} lines)`;
      } else detail = args.query ?? args.pattern ?? args.path ?? "";
      return [`ACTION ${part.name}${detail ? ` → ${summarize(String(detail))}` : ""}`];
    }
    return [];
  });
}

export class JsonlCursor {
  private offset = 0;
  private pending = "";
  private decoder = new TextDecoder();
  async read(path: string): Promise<unknown[]> {
    const file = await open(path, "r");
    try {
      const size = (await file.stat()).size;
      if (size < this.offset) { this.offset = 0; this.pending = ""; this.decoder = new TextDecoder(); }
      let text = "";
      while (this.offset < size) {
        const buffer = Buffer.alloc(Math.min(65536, size - this.offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        text += this.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      }
      const lines = (this.pending + text).split("\n");
      this.pending = lines.pop() ?? "";
      return lines.filter((line) => line.trim()).map((line) => JSON.parse(line));
    } finally { await file.close(); }
  }
}

export async function findRun(runs: string, issue?: number, runId?: string): Promise<string> {
  if (runId && !/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("Invalid run ID");
  const matches: { path: string; modified: number }[] = [];
  for (const entry of await readdir(runs, { withFileTypes: true })) {
    if (!entry.isDirectory() || (runId && entry.name !== runId)) continue;
    const path = join(runs, entry.name);
    const stateFile = Bun.file(join(path, "state.json"));
    if (!(await stateFile.exists())) continue;
    const state = await stateFile.json();
    if (issue && !String(state.issue).endsWith(`/issues/${issue}`)) continue;
    matches.push({ path, modified: (await stat(join(path, "state.json"))).mtimeMs });
  }
  matches.sort((a, b) => b.modified - a.modified);
  if (!matches.length) throw new Error("No matching local loop run found");
  return matches[0]!.path;
}

export function terminalSummary(state: any): string[] {
  if (!["waiting_approval", "failed", "interrupted"].includes(state.status)) return [];
  const evidence = Array.isArray(state.evidence) ? state.evidence : [];
  const last = evidence.at(-1);
  return [
    `RUN ENDED: ${state.status === "waiting_approval" ? "WAITING FOR APPROVAL" : state.status.toUpperCase()}`,
    ...(state.error ? [`Reason: ${summarize(state.error, 500)}`] : []),
    ...(last ? [`Last recorded step: ${last.role ?? "ordinary check"}, round ${last.round}; process exit ${last.exitCode} (not a verification verdict)`] : []),
    `Worktree preserved: ${state.worktree}`,
    `Evidence: ${state.runDirectory}`,
    "Watcher exited because the run is terminal; it did not stop the run.",
  ];
}

export async function watchRun(directory: string, once = false, signal?: AbortSignal, history = false) {
  const cursors = new Map<string, JsonlCursor>();
  let previous = "";
  let firstPoll = true;
  let lastActivity = Date.now();
  do {
    const state = await Bun.file(join(directory, "state.json")).json();
    const summary = JSON.stringify([state.status, state.candidate, state.error]);
    if (summary !== previous) {
      console.log(`\n[${new Date().toISOString()}] ${state.status} | ${state.issue}`);
      if (state.candidate) console.log(`candidate: ${state.candidate}`);
      if (state.error) console.log(`error: ${state.error}`);
      previous = summary;
    }
    const sessions = (await readdir(directory)).filter((name) => /^\d+-(builder|qa|reviewer)-session$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let activity = false;
    for (const session of sessions) {
      for (const filename of (await readdir(join(directory, session))).filter((name) => name.endsWith(".jsonl")).sort()) {
        const path = join(directory, session, filename);
        let cursor = cursors.get(path);
        if (!cursor) { cursor = new JsonlCursor(); cursors.set(path, cursor); }
        const events = await cursor.read(path);
        if (firstPoll && !history && !once) continue;
        for (const event of events) {
          const timestamp = (event as { timestamp?: string }).timestamp;
          const time = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
          for (const line of formatSessionEvent(event)) {
            console.log(`[${time}] [${session.replace("-session", "")}] ${line}`);
            activity = true;
          }
        }
      }
    }
    if (firstPoll && !history && !once && !["waiting_approval", "failed", "interrupted"].includes(state.status)) console.log("LIVE: historical events skipped. Waiting for new completed messages/tool results. Use --history to replay.");
    firstPoll = false;
    if (activity) lastActivity = Date.now();
    // Re-read after draining logs: the run may have ended while events were read.
    const latest = await Bun.file(join(directory, "state.json")).json();
    const ending = terminalSummary(latest);
    if (ending.length) { console.log(`\n${ending.join("\n")}`); return; }
    if (once) return;
    if (Date.now() - lastActivity >= 15_000) {
      console.log(`[${new Date().toLocaleTimeString()}] WAITING | stage=${latest.status} | no new completed message/tool result in 15s; this does not prove worker health`);
      lastActivity = Date.now();
    }
    await Bun.sleep(1000);
  } while (!signal?.aborted);
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: { issue: { type: "string" }, run: { type: "string" }, once: { type: "boolean", default: false }, history: { type: "boolean", default: false } } });
    if (values.issue && (!/^[1-9]\d*$/.test(values.issue) || !Number.isSafeInteger(Number(values.issue)))) throw new Error("Invalid issue number");
    if (values.issue && values.run) throw new Error("Use --issue or --run, not both");
    const result = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: resolve(import.meta.dir, "..") });
    if (result.exitCode !== 0) throw new Error("Unable to resolve repository state directory");
    const common = resolve(import.meta.dir, "..", result.stdout.toString().trim());
    const directory = await findRun(join(common, "factory-local-loop", "runs"), values.issue ? Number(values.issue) : undefined, values.run);
    console.log(`Following ${directory}\nCtrl+C stops watching only. Showing one-line agent responses, commands, file actions and result summaries. Prompts/thinking are hidden. Common credentials are redacted, but output may still contain sensitive data.`);
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    await watchRun(directory, values.once, controller.signal, values.history);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
