import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

export type Outcome = "CAUGHT" | "ESCAPED" | "INCONCLUSIVE";

export interface Verdict {
  outcome: Outcome;
  label: string;
  detail: string;
}

export interface Defect {
  id: string;
  file: string;
  find: string;
  replace: string;
  why: string;
}

const PRODUCT_RUNGS = new Set(["static", "unit", "e2e", "holdout"]);
const ASSERTION_EVIDENCE: Record<string, string> = {
  e2e: "E2E_FAIL",
  holdout: "HOLDOUT_FAIL",
};

export function classifyLog(rc: number, out: string): Verdict {
  if (rc === 0) {
    if (!out.includes("CHECKS_OK")) {
      return {
        outcome: "INCONCLUSIVE",
        label: "no-verdict",
        detail: "the gate exited 0 without printing CHECKS_OK",
      };
    }
    return { outcome: "ESCAPED", label: "gate-ok", detail: "" };
  }

  if (rc === 124) {
    return {
      outcome: "INCONCLUSIVE",
      label: "timeout",
      detail: "the gate timed out before reaching a verdict",
    };
  }

  let namedRung: string | null = null;
  for (const line of out.split("\n")) {
    if (line.trim().startsWith("GATE_FAILED:")) {
      namedRung = line.split(":", 2)[1].trim();
    }
  }

  if (!namedRung || !PRODUCT_RUNGS.has(namedRung)) {
    return {
      outcome: "INCONCLUSIVE",
      label: namedRung || "unknown",
      detail: "gate failure did not identify a product rung",
    };
  }

  const evidence = ASSERTION_EVIDENCE[namedRung];
  if (evidence && !out.includes(evidence)) {
    return {
      outcome: "INCONCLUSIVE",
      label: namedRung,
      detail: `rung went red without ${evidence}`,
    };
  }

  return { outcome: "CAUGHT", label: namedRung, detail: "" };
}

export function applyDefect(root: string, defect: Defect): { success: boolean; error?: string } {
  const filePath = resolve(join(root, defect.file));
  if (!filePath.startsWith(resolve(root))) {
    return { success: false, error: "defect escapes root" };
  }
  if (!existsSync(filePath)) {
    return { success: false, error: `file not found: ${defect.file}` };
  }

  const content = readFileSync(filePath, "utf-8");
  const count = content.split(defect.find).length - 1;
  if (count === 0) {
    return { success: false, error: "anchor not found" };
  }
  if (count > 1) {
    return { success: false, error: `anchor ambiguous (${count} occurrences)` };
  }

  const updated = content.replace(defect.find, defect.replace);
  writeFileSync(filePath, updated, "utf-8");
  return { success: true };
}
