import type { EvaluatedIssue } from "@animus/contracts/operator";
import { parseDependencies, isActiveClaim } from "./parser";

export interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  body?: string | null;
  comments?: Array<{ body?: string | null }>;
}

export interface AdmissionOptions {
  integratedBranchIssues?: Set<number> | Map<number, string>;
}

export function evaluateIssueAdmission(
  issue: RawIssue,
  allIssuesByNumber: Map<number, RawIssue>,
  options: AdmissionOptions = {},
): EvaluatedIssue {
  const number = Number(issue.number) || 0;
  const title = String(issue.title || "");
  const state = String(issue.state || "OPEN").toUpperCase();

  const rawLabels = issue.labels || [];
  const labelNames: string[] = [];
  for (const lbl of rawLabels) {
    if (typeof lbl === "object" && lbl !== null && "name" in lbl) {
      const name = String(lbl.name || "").trim();
      if (name) labelNames.push(name);
    } else if (typeof lbl === "string") {
      const name = lbl.trim();
      if (name) labelNames.push(name);
    }
  }

  // Canonical labels: legacy factory:* labels convey zero authority
  const canonicalLabels = labelNames.filter((l) => !l.toLowerCase().startsWith("factory:"));
  const lowerCanonicalLabels = new Set(canonicalLabels.map((l) => l.toLowerCase()));

  const body = String(issue.body || "");
  const deps = parseDependencies(body);
  const comments = issue.comments || [];
  if (Array.isArray(comments)) {
    for (const c of comments) {
      const cBody = String(c?.body || "");
      for (const d of parseDependencies(cBody)) {
        if (!deps.includes(d)) {
          deps.push(d);
        }
      }
    }
  }

  // Check branch integration status
  let integratedBranch: string | null = null;
  if (options.integratedBranchIssues) {
    if (options.integratedBranchIssues instanceof Map) {
      integratedBranch = options.integratedBranchIssues.get(number) ?? null;
    } else if (options.integratedBranchIssues.has(number)) {
      integratedBranch = "integrated";
    }
  }

  // Check dependencies: satisfied if closed on GitHub OR has verified integrated_to_branch status
  const unsatisfied: number[] = [];
  for (const depNum of deps) {
    let depIntegrated = false;
    if (options.integratedBranchIssues) {
      depIntegrated = options.integratedBranchIssues.has(depNum);
    }

    if (depIntegrated) {
      // Satisfied via local verified branch integration
      continue;
    }

    const depIssue = allIssuesByNumber.get(depNum);
    if (!depIssue) {
      unsatisfied.push(depNum);
    } else {
      const depState = String(depIssue.state || "OPEN").toUpperCase();
      if (depState !== "CLOSED") {
        unsatisfied.push(depNum);
      }
    }
  }

  // 1. Closed issues are held
  if (state !== "OPEN") {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "issue_closed",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 2. Unlabeled check
  if (labelNames.length === 0) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "unlabeled_awaiting_triage",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 3. Exclude check: wontfix overrides everything. Legacy factory:exclude has no authority in canonical mode.
  if (lowerCanonicalLabels.has("wontfix")) {
    return {
      number,
      title,
      state,
      admission_status: "excluded",
      reason: "excluded_by_label",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 4. Hold check: canonical needs-info, ready-for-human, needs-triage block admission
  const blockingLabels = ["needs-info", "ready-for-human", "needs-triage"];
  if (blockingLabels.some((lbl) => lowerCanonicalLabels.has(lbl))) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "held_by_label",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 5. Ready check: canonical ready-for-agent is strictly required. Legacy factory:ready has no authority.
  if (!lowerCanonicalLabels.has("ready-for-agent")) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "missing_ready_label",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 6. Dependency check
  if (unsatisfied.length > 0) {
    const reasonDeps = unsatisfied.map((d) => `#${d}`).join(",");
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: `waiting_on_dependency:${reasonDeps}`,
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // 7. Active claim check
  if (isActiveClaim(comments, body)) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "actively_claimed",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // All satisfied -> Admitted
  return {
    number,
    title,
    state,
    admission_status: "admitted",
    reason: "admitted_ready",
    labels: labelNames,
    dependencies: deps,
    unsatisfied_dependencies: [],
    body,
    integrated_to_branch: integratedBranch,
  };
}
