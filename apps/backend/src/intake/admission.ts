import type { EvaluatedIssue } from "@labq/contracts/operator";
import { parseDependencies, isActiveClaim } from "./parser";

export interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  body?: string | null;
  comments?: Array<{ body?: string | null }>;
}

export const JEV_TRIAGE_QUESTIONS = {
  is_actionable: {
    type: "noul",
    instructions: "Does the issue have clear and unambiguous acceptance criteria?",
  },
  triage_category: {
    type: "choice",
    instructions: "Categorize the issue",
    criteria: {
      ready_for_agent: "Fully specified with unambiguous acceptance criteria",
      needs_info: "Vague or missing acceptance criteria",
      ready_for_human: "Requires human decision or high-level architecture",
    },
  },
  complexity: {
    type: "score",
    instructions: "Rate complexity of the task",
    criteria: [
      "trivial_single_line",
      "small_single_file",
      "medium_multi_file",
      "large_system_wide",
    ],
  },
};

export interface JevSystemOneResponse {
  id?: string;
  model?: string;
  answers?: {
    is_actionable?: { noul?: number };
    triage_category?: {
      choice?: string;
      confidence?: number;
      probabilities?: Record<string, number>;
    };
    complexity?: {
      score?: number;
      confidence?: number;
    };
  };
}

export async function runJevAdvisory(
  title: string,
  body: string,
  labels: string[],
  fetcher?: (payload: unknown) => Promise<JevSystemOneResponse>,
  enabled = true,
): Promise<{
  rec_label: string | null;
  conf: number | null;
  comp: number | null;
  probs: Record<string, number> | null;
  rec_reason: string;
  jev_meta: Record<string, any> | null;
  error?: string;
}> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!enabled || (!apiKey && !fetcher)) {
    return {
      rec_label: null,
      conf: null,
      comp: null,
      probs: null,
      rec_reason: "unconfigured",
      jev_meta: null,
    };
  }

  const stateText = `Title: ${title}\nBody: ${body}\nLabels: ${labels.join(", ")}`;
  const payload = {
    model: "typesafe/jev-1.14",
    state: stateText,
    questions: JEV_TRIAGE_QUESTIONS,
  };

  try {
    let result: JevSystemOneResponse;
    if (fetcher) {
      result = await fetcher(payload);
    } else {
      const res = await fetch("https://openrouter.ai/api/v1/systemone", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "LabQ-Software-Factory/1.0",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return {
          rec_label: null,
          conf: null,
          comp: null,
          probs: null,
          rec_reason: "evaluation_error:jev_unreachable",
          jev_meta: null,
          error: "evaluation_error:jev_unreachable",
        };
      }
      result = (await res.json()) as JevSystemOneResponse;
    }

    const noulAns = result.answers?.is_actionable;
    const choiceAns = result.answers?.triage_category;
    const scoreAns = result.answers?.complexity;

    const isActionable = typeof noulAns?.noul === "number" ? noulAns.noul : 0.0;
    const choice = choiceAns?.choice || "";
    const confidence = typeof choiceAns?.confidence === "number" ? choiceAns.confidence : 0.0;
    const probabilities = choiceAns?.probabilities || null;
    const complexity = typeof scoreAns?.score === "number" ? scoreAns.score : null;

    let rec_label: string;
    let rec_reason: string;

    if (choice === "ready_for_agent" && confidence >= 0.7 && isActionable >= 0.7) {
      rec_label = "ready-for-agent";
      rec_reason = "clear_acceptance_criteria";
    } else if (choice === "ready_for_human" && confidence >= 0.7) {
      rec_label = "ready-for-human";
      rec_reason = "requires_human_architecture";
    } else {
      rec_label = "needs-info";
      rec_reason = "unclear_acceptance_criteria";
    }

    const jev_meta = {
      id: result.id,
      model: result.model,
      is_actionable: isActionable,
      choice,
      confidence,
      complexity,
      probabilities,
      recommendation_reason: rec_reason,
    };

    return {
      rec_label,
      conf: confidence,
      comp: complexity,
      probs: probabilities,
      rec_reason,
      jev_meta,
    };
  } catch {
    return {
      rec_label: null,
      conf: null,
      comp: null,
      probs: null,
      rec_reason: "evaluation_error:jev_unreachable",
      jev_meta: null,
      error: "evaluation_error:jev_unreachable",
    };
  }
}

export interface AdmissionOptions {
  advisory?: boolean;
  integratedBranchIssues?: Set<number> | Map<number, string>;
  jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>;
}

export async function evaluateIssueAdmission(
  issue: RawIssue,
  allIssuesByNumber: Map<number, RawIssue>,
  optionsOrJevFetcher?: AdmissionOptions | ((payload: unknown) => Promise<JevSystemOneResponse>),
): Promise<EvaluatedIssue> {
  let options: AdmissionOptions = {};
  if (typeof optionsOrJevFetcher === "function") {
    options = { jevFetcher: optionsOrJevFetcher };
  } else if (optionsOrJevFetcher) {
    options = optionsOrJevFetcher;
  }

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
    const jev = await runJevAdvisory(
      title,
      body,
      labelNames,
      options.jevFetcher,
      options.advisory !== false,
    );
    if (jev.error) {
      return {
        number,
        title,
        state,
        admission_status: "held",
        reason: jev.error,
        labels: labelNames,
        dependencies: deps,
        unsatisfied_dependencies: unsatisfied,
        body,
        integrated_to_branch: integratedBranch,
      };
    }
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
      recommended_label: jev.rec_label,
      confidence: jev.conf,
      complexity: jev.comp,
      probabilities: jev.probs,
      jev_evaluation: jev.jev_meta,
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
    let jev: Awaited<ReturnType<typeof runJevAdvisory>> = {
      rec_label: null,
      conf: null,
      comp: null,
      probs: null,
      rec_reason: "",
      jev_meta: null,
    };
    if (lowerCanonicalLabels.has("needs-triage")) {
      jev = await runJevAdvisory(
        title,
        body,
        labelNames,
        options.jevFetcher,
        options.advisory !== false,
      );
      if (jev.error) {
        return {
          number,
          title,
          state,
          admission_status: "held",
          reason: jev.error,
          labels: labelNames,
          dependencies: deps,
          unsatisfied_dependencies: unsatisfied,
          body,
          integrated_to_branch: integratedBranch,
        };
      }
    }
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
      recommended_label: jev.rec_label,
      confidence: jev.conf,
      complexity: jev.comp,
      probabilities: jev.probs,
      jev_evaluation: jev.jev_meta,
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
