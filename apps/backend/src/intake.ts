import type { EvaluatedIssue, IntakeResult } from "@labq/contracts/operator";

export const DEPENDS_ON_PATTERN = /depends\s+on\s*:\s*([^\n\r]+)/gi;
export const ISSUE_NUM_PATTERN = /#?(\d+)/g;
export const CLAIM_PATTERN = /Loop claim: run ([a-zA-Z0-9_-]+)/;

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

export interface RawIssue {
  number: number;
  title: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  body?: string | null;
  comments?: Array<{ body?: string | null }>;
}

export function parseDependencies(text: string): number[] {
  if (!text) return [];
  const deps: number[] = [];
  const clauseMatches = text.matchAll(/(?:depends\s+on)\s*:\s*([^\n\r]+)/gi);
  for (const match of clauseMatches) {
    const clause = match[1] || "";
    const numMatches = clause.matchAll(/#?(\d+)/g);
    for (const numMatch of numMatches) {
      const n = parseInt(numMatch[1], 10);
      if (!Number.isNaN(n) && !deps.includes(n)) {
        deps.push(n);
      }
    }
  }
  return deps;
}

export function isActiveClaim(comments?: Array<{ body?: string | null }>): boolean {
  if (!comments || !Array.isArray(comments)) return false;
  for (const comment of comments) {
    const body = comment?.body || "";
    if (CLAIM_PATTERN.test(body)) {
      return true;
    }
  }
  return false;
}

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
  if (!apiKey && !fetcher) {
    // Unconfigured
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

export async function evaluateIssueAdmission(
  issue: RawIssue,
  allIssuesByNumber: Map<number, RawIssue>,
  jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>,
): Promise<EvaluatedIssue> {
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

  const lowerLabels = new Set(labelNames.map((l) => l.toLowerCase()));

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

  const unsatisfied: number[] = [];
  for (const depNum of deps) {
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
    };
  }

  // 2. Unlabeled check: strictly canonical (no factory-prefixed authority)
  if (lowerLabels.size === 0) {
    const jev = await runJevAdvisory(title, body, labelNames, jevFetcher);
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
      recommended_label: jev.rec_label,
      confidence: jev.conf,
      complexity: jev.comp,
      probabilities: jev.probs,
      jev_evaluation: jev.jev_meta,
    };
  }

  // 3. Exclude check: wontfix overrides everything. Legacy factory:exclude has no authority in canonical mode.
  if (lowerLabels.has("wontfix")) {
    return {
      number,
      title,
      state,
      admission_status: "excluded",
      reason: "excluded_by_label",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
    };
  }

  // 4. Hold check: canonical needs-info, ready-for-human, needs-triage block admission
  const blockingLabels = ["needs-info", "ready-for-human", "needs-triage"];
  if (blockingLabels.some((lbl) => lowerLabels.has(lbl))) {
    let jev: Awaited<ReturnType<typeof runJevAdvisory>> = {
      rec_label: null,
      conf: null,
      comp: null,
      probs: null,
      rec_reason: "",
      jev_meta: null,
    };
    if (lowerLabels.has("needs-triage")) {
      jev = await runJevAdvisory(title, body, labelNames, jevFetcher);
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
      recommended_label: jev.rec_label,
      confidence: jev.conf,
      complexity: jev.comp,
      probabilities: jev.probs,
      jev_evaluation: jev.jev_meta,
    };
  }

  // 5. Ready check: canonical ready-for-agent is strictly required. Legacy factory:ready has no authority.
  if (!lowerLabels.has("ready-for-agent")) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "missing_ready_label",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
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
    };
  }

  // 7. Active claim check
  if (isActiveClaim(comments)) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "actively_claimed",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
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
  };
}

export class IntakeService {
  private cachedResult: IntakeResult | null = null;
  private cachedAt = 0;
  private readonly ttlSeconds: number;
  private readonly repo: string;
  private readonly runner?: (cmd: string[]) => Promise<string>;
  private readonly jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>;

  constructor(options?: {
    repo?: string;
    ttlSeconds?: number;
    runner?: (cmd: string[]) => Promise<string>;
    jevFetcher?: (payload: unknown) => Promise<JevSystemOneResponse>;
  }) {
    this.repo = options?.repo || "labq-software-factory";
    this.ttlSeconds = options?.ttlSeconds ?? 60.0;
    this.runner = options?.runner;
    this.jevFetcher = options?.jevFetcher;
  }

  async fetchRawIssues(): Promise<RawIssue[]> {
    let repoArg = this.repo;
    if (!repoArg.includes("/")) {
      repoArg = `iqbal-codes/${repoArg}`;
    }
    const cmd = [
      "gh",
      "issue",
      "list",
      "--repo",
      repoArg,
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,title,labels,body,state,comments",
    ];

    let output: string;
    if (this.runner) {
      output = await this.runner(cmd);
    } else {
      const proc = Bun.spawn(cmd, {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exited = await proc.exited;
      if (exited !== 0) {
        const err = await new Response(proc.stderr).text();
        throw new Error(`gh issue list failed: ${err}`);
      }
      output = await new Response(proc.stdout).text();
    }

    try {
      const data = JSON.parse(output);
      if (!Array.isArray(data)) {
        throw new Error("Expected array of issues from gh CLI");
      }
      return data as RawIssue[];
    } catch (err: any) {
      throw new Error(`Failed to parse gh output: ${err.message}`);
    }
  }

  async evaluateBacklog(forceRefresh = false): Promise<IntakeResult> {
    const now = Date.now() / 1000;
    if (!forceRefresh && this.cachedResult && now - this.cachedAt < this.ttlSeconds) {
      return { ...this.cachedResult, cached: true };
    }

    const rawIssues = await this.fetchRawIssues();
    const byNumber = new Map<number, RawIssue>();
    for (const issue of rawIssues) {
      if (typeof issue.number === "number") {
        byNumber.set(issue.number, issue);
      }
    }

    const evaluated: EvaluatedIssue[] = [];
    for (const issue of rawIssues) {
      evaluated.push(await evaluateIssueAdmission(issue, byNumber, this.jevFetcher));
    }

    evaluated.sort((a, b) => a.number - b.number);

    const admittedCount = evaluated.filter((x) => x.admission_status === "admitted").length;
    const heldCount = evaluated.filter((x) => x.admission_status === "held").length;
    const excludedCount = evaluated.filter((x) => x.admission_status === "excluded").length;

    const result: IntakeResult = {
      repo: this.repo,
      as_of: new Date().toISOString(),
      cached: false,
      total_count: evaluated.length,
      admitted_count: admittedCount,
      held_count: heldCount,
      excluded_count: excludedCount,
      issues: evaluated,
    };

    this.cachedResult = result;
    this.cachedAt = now;
    return result;
  }
}
