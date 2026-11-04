import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvaluatedIssue } from "@animus/contracts/operator";
import {
  resolveProjectWorkspace,
  loadCascadedScheduleConfig,
  getMergedIssueNumbers,
  getIssuesWaitingApproval,
  type ProjectWorkspace,
} from "@animus/contracts/paths";
import type { IssueForgeAdapter } from "../registry/forge";
import { parseDependencies, isActiveClaim } from "./parser";

export interface RawIssue {
  number: number;
  title?: string;
  state: string;
  labels?: Array<{ name: string } | string>;
  body?: string | null;
  comments?: Array<{ body?: string | null }>;
  dependencies?: number[];
  native_dependencies?: number[];
  blocked_by?: number[];
  activeClaim?: boolean;
}

export interface AdmissionOptions {
  integratedBranchIssues?: Set<number> | Map<number, string>;
  mergedIssueNumbers?: Set<number>;
  closedIssueNumbers?: Set<number>;
  waitingApprovalIssueNumbers?: Set<number>;
  runStates?: Map<number, string>;
  nativeDependencies?: Map<number, number[]>;
  dossierAttempts?: Map<number, number>;
  stateRoot?: string;
  dossiersDir?: string;
  runsDir?: string;
  maxLaps?: number;
}

export const CANONICAL_BLOCKING_LABELS = [
  "needs-info",
  "ready-for-human",
  "needs-triage",
  "needs-owner",
] as const;

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
  const parsedDeps = parseDependencies(body);
  const comments = issue.comments || [];
  if (Array.isArray(comments)) {
    for (const c of comments) {
      const cBody = String(c?.body || "");
      for (const d of parseDependencies(cBody)) {
        if (!parsedDeps.includes(d)) {
          parsedDeps.push(d);
        }
      }
    }
  }

  // Union of Markdown Depends on: and native dependencies
  const nativeDeps = [
    ...(issue.native_dependencies || []),
    ...(issue.blocked_by || []),
    ...(options.nativeDependencies?.get(number) || []),
    ...(issue.dependencies || []),
  ];

  const deps = Array.from(new Set([...parsedDeps, ...nativeDeps]));

  // Check branch integration status
  let integratedBranch: string | null = null;
  if (options.integratedBranchIssues) {
    if (options.integratedBranchIssues instanceof Map) {
      integratedBranch = options.integratedBranchIssues.get(number) ?? null;
    } else if (options.integratedBranchIssues.has(number)) {
      integratedBranch = "integrated";
    }
  }

  // Check dependencies: satisfied if closed on GitHub, verified integrated_to_branch status, or local merged run
  const unsatisfied: number[] = [];
  for (const depNum of deps) {
    if (options.integratedBranchIssues?.has(depNum)) {
      continue;
    }
    if (options.mergedIssueNumbers?.has(depNum)) {
      continue;
    }
    if (options.closedIssueNumbers?.has(depNum)) {
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

  // 1. Exclude check: wontfix overrides everything with absolute precedence.
  // Legacy factory:exclude has no authority in canonical mode.
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

  // 2. Closed issues are held
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

  // 3. Unlabeled check
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

  // 4. Hold check: canonical needs-info, ready-for-human, needs-triage, needs-owner block admission
  if (CANONICAL_BLOCKING_LABELS.some((lbl) => lowerCanonicalLabels.has(lbl))) {
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

  // 7. Active claim check, local run states, and issue dossier attempt exhaustion
  if (issue.activeClaim || isActiveClaim(comments, body)) {
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

  // Local run states from runsDir
  const localRunState = options.runStates?.get(number);
  if (localRunState === "needs_owner") {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "needs_owner",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }
  if (localRunState === "interrupted") {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "interrupted",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }
  if (localRunState === "waiting_approval" || options.waitingApprovalIssueNumbers?.has(number)) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "waiting_approval",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }
  if (localRunState === "merged" || options.mergedIssueNumbers?.has(number)) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "already_merged",
      labels: labelNames,
      dependencies: deps,
      unsatisfied_dependencies: unsatisfied,
      body,
      integrated_to_branch: integratedBranch,
    };
  }

  // Issue Dossier attempt exhaustion
  let attemptsCount = options.dossierAttempts?.get(number);
  if (attemptsCount === undefined && options.maxLaps !== undefined) {
    const dossiersDir =
      options.dossiersDir || (options.stateRoot ? join(options.stateRoot, "dossiers") : null);
    if (dossiersDir && existsSync(dossiersDir)) {
      const dossierFile = join(dossiersDir, `issue-${number}.json`);
      if (existsSync(dossierFile)) {
        try {
          const dossier = JSON.parse(readFileSync(dossierFile, "utf-8"));
          if (Array.isArray(dossier?.attempts)) {
            attemptsCount = dossier.attempts.length;
          }
        } catch {}
      }
    }
  }

  if (
    attemptsCount !== undefined &&
    options.maxLaps !== undefined &&
    attemptsCount >= options.maxLaps
  ) {
    return {
      number,
      title,
      state,
      admission_status: "held",
      reason: "dossier_budget_exhausted",
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

export interface EvaluateBacklogAdmissionOptions {
  repo?: string;
  issues: RawIssue[];
  forge?: IssueForgeAdapter;
  workspace?: ProjectWorkspace | string;
  runsDir?: string;
  stateRoot?: string;
  dossiersDir?: string;
  maxLaps?: number;
  branchIntegrations?: Set<number> | Map<number, string>;
  waitingApprovalIssueNumbers?: Set<number>;
  mergedIssueNumbers?: Set<number>;
  closedIssueNumbers?: Set<number>;
  nativeDependencies?: Map<number, number[]>;
}

export interface BacklogAdmissionResult {
  issues: EvaluatedIssue[];
  admitted: EvaluatedIssue[];
  held: EvaluatedIssue[];
  excluded: EvaluatedIssue[];
  byNumber: Map<number, EvaluatedIssue>;
}

export function readRunStates(runsDir: string): Map<number, string> {
  const runStates = new Map<number, string>();
  if (!existsSync(runsDir)) return runStates;
  try {
    for (const entry of readdirSync(runsDir)) {
      const statePath = join(runsDir, entry, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, "utf-8"));
        let num: number | undefined;
        if (typeof state.issue === "number") num = state.issue;
        else if (typeof state.issue === "string") {
          const m = state.issue.match(/\/issues\/(\d+)\/?$/) || state.issue.match(/^#?(\d+)$/);
          if (m?.[1]) num = Number(m[1]);
        }
        if (num && Number.isSafeInteger(num) && typeof state.status === "string") {
          runStates.set(num, state.status);
        }
      } catch {}
    }
  } catch {}
  return runStates;
}

export async function evaluateBacklogAdmission(
  options: EvaluateBacklogAdmissionOptions,
): Promise<BacklogAdmissionResult> {
  let runsDir = options.runsDir;
  let stateRoot = options.stateRoot;
  let dossiersDir = options.dossiersDir;
  let maxLaps = options.maxLaps;

  if (options.workspace) {
    try {
      const ws =
        typeof options.workspace === "string"
          ? resolveProjectWorkspace(options.workspace)
          : options.workspace;
      runsDir = runsDir ?? ws.runsDir;
      stateRoot = stateRoot ?? ws.stateRoot;
      dossiersDir = dossiersDir ?? ws.dossiersDir;
      if (maxLaps === undefined) {
        try {
          const sched = loadCascadedScheduleConfig(ws);
          maxLaps = sched.max_laps ?? 3;
        } catch {
          maxLaps = 3;
        }
      }
    } catch {}
  }

  const mergedIssueNumbers = new Set<number>(options.mergedIssueNumbers ?? []);
  const waitingApprovalIssueNumbers = new Set<number>(options.waitingApprovalIssueNumbers ?? []);
  const runStates = new Map<number, string>();

  if (runsDir && existsSync(runsDir)) {
    for (const n of getMergedIssueNumbers(runsDir)) mergedIssueNumbers.add(n);
    for (const n of getIssuesWaitingApproval(runsDir)) waitingApprovalIssueNumbers.add(n);
    for (const [n, st] of readRunStates(runsDir)) runStates.set(n, st);
  }

  const nativeDependenciesMap = new Map<number, number[]>(options.nativeDependencies ?? []);
  const failedNativeLookup = new Set<number>();
  if (options.forge?.getIssueDependencies && options.repo) {
    for (const issue of options.issues) {
      if (!nativeDependenciesMap.has(issue.number)) {
        try {
          const deps = await options.forge.getIssueDependencies(options.repo, issue.number);
          if (deps && deps.length > 0) {
            nativeDependenciesMap.set(issue.number, deps);
          }
        } catch {
          failedNativeLookup.add(issue.number);
        }
      }
    }
  }

  const byNumber = new Map<number, RawIssue>(options.issues.map((issue) => [issue.number, issue]));
  const missingDependencyNumbers = new Set<number>();
  const branchIntegrations = options.branchIntegrations;

  for (const issue of options.issues) {
    const rawDeps = [
      ...parseDependencies(issue.body ?? ""),
      ...(issue.comments ?? []).flatMap((c) => parseDependencies(c?.body ?? "")),
      ...(issue.native_dependencies ?? []),
      ...(issue.blocked_by ?? []),
      ...(nativeDependenciesMap.get(issue.number) ?? []),
      ...(issue.dependencies ?? []),
    ];
    for (const depNum of rawDeps) {
      if (
        !byNumber.has(depNum) &&
        !branchIntegrations?.has(depNum) &&
        !mergedIssueNumbers.has(depNum) &&
        !options.closedIssueNumbers?.has(depNum)
      ) {
        missingDependencyNumbers.add(depNum);
      }
    }
  }

  const failedLookup = new Set<number>();
  const missing = [...missingDependencyNumbers];
  if (missing.length > 0 && options.forge && options.repo) {
    if (options.forge.getIssueStates) {
      try {
        const states = await options.forge.getIssueStates(options.repo, missing);
        for (const num of missing) {
          const state = states.get(num);
          if (state) {
            byNumber.set(num, { number: num, title: "", state });
          } else {
            failedLookup.add(num);
          }
        }
      } catch {
        for (const num of missing) failedLookup.add(num);
      }
    } else {
      for (let i = 0; i < missing.length; i += 5) {
        await Promise.all(
          missing.slice(i, i + 5).map(async (num) => {
            try {
              const dep = await options.forge!.getIssue(options.repo!, num);
              if (dep) {
                byNumber.set(num, dep);
              } else {
                failedLookup.add(num);
              }
            } catch {
              failedLookup.add(num);
            }
          }),
        );
      }
    }
  }

  const evaluated: EvaluatedIssue[] = options.issues.map((issue) => {
    const res = evaluateIssueAdmission(issue, byNumber, {
      integratedBranchIssues: branchIntegrations,
      mergedIssueNumbers,
      closedIssueNumbers: options.closedIssueNumbers,
      waitingApprovalIssueNumbers,
      runStates,
      nativeDependencies: nativeDependenciesMap,
      stateRoot,
      dossiersDir,
      runsDir,
      maxLaps,
    });

    if (failedNativeLookup.has(issue.number) && res.admission_status === "admitted") {
      res.admission_status = "held";
      res.reason = "dependency_lookup_failed:native";
    }

    const unavailable = res.unsatisfied_dependencies.filter((n) => failedLookup.has(n));
    if (unavailable.length > 0 && res.reason.startsWith("waiting_on_dependency:")) {
      res.reason = "dependency_lookup_failed:" + unavailable.map((n) => "#" + n).join(",");
    }
    return res;
  });

  const admitted = evaluated
    .filter((x) => x.admission_status === "admitted")
    .sort((a, b) => {
      const aPriority = a.labels.some((l) => l.toLowerCase() === "priority");
      const bPriority = b.labels.some((l) => l.toLowerCase() === "priority");
      if (aPriority && !bPriority) return -1;
      if (!aPriority && bPriority) return 1;
      return a.number - b.number;
    });

  const held = evaluated
    .filter((x) => x.admission_status === "held")
    .sort((a, b) => a.number - b.number);
  const excluded = evaluated
    .filter((x) => x.admission_status === "excluded")
    .sort((a, b) => a.number - b.number);
  const resultByNumber = new Map<number, EvaluatedIssue>(evaluated.map((i) => [i.number, i]));

  return {
    issues: evaluated,
    admitted,
    held,
    excluded,
    byNumber: resultByNumber,
  };
}
