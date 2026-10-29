import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function setupArtifactDirectories(runDirectory: string) {
  const artifactsDir = join(runDirectory, "artifacts");
  const handoffDir = join(artifactsDir, "handoff");
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(handoffDir, { recursive: true });
  return { artifactsDir, handoffDir };
}

export function parseAgentReport(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const blocks = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```/g)];
    if (blocks.length !== 1) {
      throw new Error(
        "Agent report must contain one JSON object, either plain or in one code fence",
      );
    }
    try {
      return JSON.parse(blocks[0]![1]!);
    } catch {
      throw new Error("Agent report contains invalid JSON in its code fence");
    }
  }
}

function normalizeExtractedReport(value: any, candidate: string) {
  if (!value || typeof value !== "object") {
    throw new Error("Missing, malformed or stale candidate-bound checks/review verdict");
  }

  // Canonical Archon check-app report normalization
  if (value.overall !== undefined && Array.isArray(value.lines)) {
    const isPass = String(value.overall).toUpperCase() === "PASS";
    const head = value.head || candidate;
    return {
      ...value,
      candidate: head,
      verdict: isPass ? "pass" : "fail",
      checks: value.lines.map((l: any) => ({
        criterion: l.id || "criterion",
        result: String(l.verdict).toLowerCase(),
        evidence: Array.isArray(l.evidence) ? l.evidence.join(", ") : String(l.text || ""),
      })),
      findings: value.lines
        .filter((l: any) => l.verdict !== "PASS" && l.verdict !== "OK")
        .map((l: any) => `${l.id}: ${l.text}`),
      passed: isPass && value.lines.every((l: any) => l.verdict === "PASS" || l.verdict === "OK"),
    };
  }

  // Canonical Archon review report normalization
  if (value.outcome !== undefined) {
    const isPass = ["merge", "approved"].includes(String(value.outcome).toLowerCase());
    const sha = value.sha || candidate;
    return {
      ...value,
      candidate: sha,
      verdict: isPass ? "pass" : "fail",
      checks: [
        {
          criterion: "review-outcome",
          result: isPass ? "pass" : "fail",
          evidence: value.reason || value.outcome,
        },
      ],
      findings: Array.isArray(value.dispositions)
        ? value.dispositions
            .filter((d: any) => d.action === "blocks")
            .map((d: any) => `${d.line}: ${d.reason}`)
        : Array.isArray(value.findings)
          ? value.findings
          : [],
      passed: isPass,
    };
  }

  // Generic / Mock report format
  if (
    value.candidate !== candidate ||
    !["pass", "fail", "blocked"].includes(value.verdict) ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.checks)
  )
    throw new Error("Missing, malformed or stale candidate-bound checks/review verdict");
  return {
    ...value,
    passed:
      value.verdict === "pass" &&
      value.checks.every((c: { result: string }) => c.result === "pass"),
  };
}

export function extractReport(stdout: string, candidate: string) {
  let message:
    | { role?: string; stopReason?: string; content?: { type: string; text?: string }[] }
    | undefined;
  let settled = false;
  let textDirect: string | null = null;

  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        message = event.message;
        if (Array.isArray(event.message?.content)) {
          textDirect = event.message.content
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
        }
      }
      if (event.type === "agent_start") settled = false;
      if (event.type === "agent_settled") settled = event.aborted === false;
      if (event.result && typeof event.result === "string") textDirect = event.result;
      if (event.content && typeof event.content === "string") textDirect = event.content;
    } catch {}
  }

  if (settled && message && message.stopReason === "stop" && Array.isArray(message.content)) {
    const textContent = message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    return normalizeExtractedReport(parseAgentReport(textContent), candidate);
  }

  // If output was from Claude Code, Codex, OpenCode, or plain JSON/fenced markdown:
  try {
    const directValue = parseAgentReport(textDirect ?? stdout);
    if (directValue && typeof directValue === "object") {
      return normalizeExtractedReport(directValue, candidate);
    }
  } catch {}

  if (!settled || !message || message.stopReason !== "stop" || !Array.isArray(message.content))
    throw new Error("Pi did not settle with a final assistant response");

  return normalizeExtractedReport(parseAgentReport(stdout), candidate);
}

export function validateEvidenceCitations(
  qaReport: any,
  artifactsDir: string,
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (Array.isArray(qaReport.lines)) {
    for (const line of qaReport.lines) {
      if (Array.isArray(line.evidence)) {
        for (const evPath of line.evidence) {
          if (typeof evPath === "string" && evPath.trim()) {
            const fullPath = resolve(artifactsDir, evPath);
            if (!existsSync(fullPath)) {
              problems.push(`Line ${line.id} cited missing evidence: ${evPath}`);
            }
          }
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
