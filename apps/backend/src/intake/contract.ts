import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  resolveProjectWorkspace,
  getMergedIssueNumbers,
  getIssuesWaitingApproval,
  loadCascadedScheduleConfig,
} from "@animus/contracts/paths";
import {
  parseDependencies,
  parseTicketSections,
  isActiveClaim,
  type StructuredTicketSections,
} from "./parser";
import {
  evaluateIssueAdmission,
  readRunStates,
  readVerifiedBranchIntegrations,
  type RawIssue,
} from "./admission";

export type GithubRead = (args: string[], cwd: string) => unknown;

export interface BindIssueContractOptions {
  root?: string;
  number: number;
  repo: string;
  read?: GithubRead;
  validateSections?: boolean;
  db?: any;
  dbPath?: string;
  projectId?: string;
  branchIntegrations?: Set<number> | Map<number, string>;
}

export interface BoundIssueContract {
  number: number;
  url: string;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  activeClaim: boolean;
  labels?: string[];
  verificationProfile?: "docs" | "ui" | "logic" | "api" | "core";
  sha256: string;
  contractSha256: string;
  sections: {
    partOf: number | null;
    sourceProblem: string;
    outcome: string;
    invariants: string[];
    acceptanceCriteria: string[];
    boundary: string;
    dependsOn: number[];
  };
}

export const CANONICAL_SECTIONS = [
  "Source and problem",
  "Outcome",
  "Invariants",
  "Acceptance criteria",
  "Boundary",
] as const;

export function validateCanonicalSections(body: string): StructuredTicketSections {
  if (!body || typeof body !== "string") {
    throw new Error(
      `Invalid issue contract: missing canonical sections: ${CANONICAL_SECTIONS.join(", ")}`,
    );
  }

  const sections = parseTicketSections(body);
  const missing: string[] = [];

  if (!sections.sourceProblem || !sections.sourceProblem.trim()) {
    missing.push("Source and problem");
  }
  if (!sections.outcome || !sections.outcome.trim()) {
    missing.push("Outcome");
  }
  if (!sections.invariants || sections.invariants.length === 0) {
    missing.push("Invariants");
  }
  if (!sections.acceptanceCriteria || sections.acceptanceCriteria.length === 0) {
    missing.push("Acceptance criteria");
  }
  if (!sections.boundary || !sections.boundary.trim()) {
    missing.push("Boundary");
  }

  if (missing.length > 0) {
    throw new Error(`Invalid issue contract: missing canonical sections: ${missing.join(", ")}`);
  }

  return sections;
}

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const val = (obj as any)[key];
    if (val !== null && (typeof val === "object" || typeof val === "function")) {
      deepFreeze(val);
    }
  }
  return obj;
}

export function normalizeIssueContractContent(contract: {
  number: number;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  labels?: string[];
  sections?: {
    partOf: number | null;
    sourceProblem: string;
    outcome: string;
    invariants: string[];
    acceptanceCriteria: string[];
    boundary: string;
    dependsOn: number[];
  };
}): string {
  const normTitle = (contract.title || "").trim();
  const normBody = (contract.body || "").replace(/\r\n/g, "\n").trim();
  const normComments = (contract.comments || []).map((c) =>
    (c || "").replace(/\r\n/g, "\n").trim(),
  );
  const normDeps = [...(contract.dependencies || [])]
    .sort((a, b) => a.number - b.number)
    .map((d) => `${d.number}:${d.state}`);
  const normLabels = [...(contract.labels || [])].map((l) => l.trim().toLowerCase()).sort();

  const payload: Record<string, unknown> = {
    number: contract.number,
    title: normTitle,
    body: normBody,
    comments: normComments,
    dependencies: normDeps,
    labels: normLabels,
  };

  if (contract.sections) {
    payload.sections = {
      partOf: contract.sections.partOf ?? null,
      sourceProblem: (contract.sections.sourceProblem || "").trim(),
      outcome: (contract.sections.outcome || "").trim(),
      invariants: [...(contract.sections.invariants || [])].map((s) => s.trim()),
      acceptanceCriteria: [...(contract.sections.acceptanceCriteria || [])].map((s) => s.trim()),
      boundary: (contract.sections.boundary || "").trim(),
      dependsOn: [...(contract.sections.dependsOn || [])].sort((a, b) => a - b),
    };
  }

  return JSON.stringify(payload);
}

export function computeContractSha256(normalizedJson: string): string {
  return createHash("sha256").update(normalizedJson, "utf8").digest("hex");
}

export function bindIssueContract(options: BindIssueContractOptions): BoundIssueContract {
  const { root = process.cwd(), number, repo, read, validateSections = true } = options;

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("Invalid repository identity");
  }

  let title = "";
  let body = "";
  let url = `https://github.com/${repo}/issues/${number}`;
  let rawLabels: Array<{ name: string } | string> = [];
  let comments: string[] = [];
  let nativeDependencies: number[] = [];
  let issueState = "OPEN";

  if (!read) {
    throw new Error("bindIssueContract requires a 'read' adapter (e.g. githubJson)");
  }

  // 1. Fetch main issue view
  const rawIssue = read(
    [
      "issue",
      "view",
      String(number),
      "--repo",
      repo,
      "--json",
      "number,url,state,labels,title,body,comments",
    ],
    root,
  ) as {
    number?: number;
    url?: string;
    state?: string;
    labels?: Array<{ name: string } | string>;
    title?: string;
    body?: string;
    comments?: Array<{ body: string }>;
    isPullRequest?: boolean;
  };

  const expectedUrl = `https://github.com/${repo}/issues/${number}`;
  if (
    !rawIssue ||
    rawIssue.number !== number ||
    rawIssue.url !== expectedUrl ||
    rawIssue.isPullRequest
  ) {
    throw new Error("GitHub did not return the requested issue in the selected repository");
  }

  issueState = String(rawIssue.state || "OPEN").toUpperCase();
  title = String(rawIssue.title || "");
  body = String(rawIssue.body || "");
  url = expectedUrl;
  rawLabels = rawIssue.labels || [];

  if (
    typeof rawIssue.title !== "string" ||
    typeof rawIssue.body !== "string" ||
    !rawIssue.body.trim()
  ) {
    throw new Error("Incomplete issue body/comments");
  }

  // 2. Paginate comments to avoid truncation
  const pages = read(
    ["api", `repos/${repo}/issues/${number}/comments`, "--paginate", "--slurp"],
    root,
  );

  if (!Array.isArray(pages)) {
    throw new Error("Unable to verify complete comments");
  }

  const rawCommentItems: Array<{ body: string }> =
    pages.length > 0 && Array.isArray(pages[0])
      ? (pages as Array<Array<{ body: string }>>).flat()
      : (pages as Array<{ body: string }>);

  if (rawCommentItems.some((c) => !c || typeof c !== "object" || typeof c.body !== "string")) {
    throw new Error("Unable to verify complete comments");
  }
  comments = rawCommentItems.map((c) => c.body);

  if (
    isActiveClaim(
      comments.map((c) => ({ body: c })),
      body,
    )
  ) {
    throw new Error("Requested issue has a loop claim; resolve ownership before running");
  }

  // 3. Paginate native dependencies (blocked_by)
  const dependencyPages = read(
    ["api", `repos/${repo}/issues/${number}/dependencies/blocked_by`, "--paginate", "--slurp"],
    root,
  );

  if (!Array.isArray(dependencyPages)) {
    throw new Error("Unable to verify native dependencies");
  }

  const rawDepItems: Array<{ number: number; state: string; repository_url: string }> =
    dependencyPages.length > 0 && Array.isArray(dependencyPages[0])
      ? (
          dependencyPages as Array<Array<{ number: number; state: string; repository_url: string }>>
        ).flat()
      : (dependencyPages as Array<{ number: number; state: string; repository_url: string }>);

  for (const dep of rawDepItems) {
    if (
      !dep ||
      typeof dep !== "object" ||
      dep.repository_url !== `https://api.github.com/repos/${repo}` ||
      !Number.isSafeInteger(dep.number)
    ) {
      throw new Error(
        "Cross-repository or malformed native dependency requires human verification",
      );
    }
    nativeDependencies.push(dep.number);
  }

  // 4. Union dependencies (Markdown + native)
  const allDeps = new Set<number>(parseDependencies([body, ...comments].join("\n")));
  for (const depNum of nativeDependencies) {
    allDeps.add(depNum);
  }

  // 5. Evaluate admission invariants
  const labelNames = rawLabels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);

  const rawForAdmission: RawIssue = {
    number,
    title,
    state: issueState,
    labels: rawLabels,
    body,
    comments: comments.map((c) => ({ body: c })),
    native_dependencies: nativeDependencies,
  };

  let localMergedIssues = new Set<number>();
  let waitingApprovalIssues = new Set<number>();
  let runStates = new Map<number, string>();
  let runsDir: string | undefined;
  let stateRoot: string | undefined;
  let dossiersDir: string | undefined;
  let maxLaps: number | undefined;

  try {
    const ws = resolveProjectWorkspace(root);
    runsDir = ws.runsDir;
    stateRoot = ws.stateRoot;
    dossiersDir = ws.dossiersDir;
    const candidateRunsDirs = [ws.runsDir, ...(ws.fallbackRunsDirs ?? [])];
    localMergedIssues = new Set<number>();
    waitingApprovalIssues = new Set<number>();
    runStates = new Map<number, string>();
    for (const dir of candidateRunsDirs) {
      if (existsSync(dir)) {
        for (const n of getMergedIssueNumbers(dir)) localMergedIssues.add(n);
        for (const n of getIssuesWaitingApproval(dir)) waitingApprovalIssues.add(n);
        for (const [n, st] of readRunStates(dir)) {
          if (!runStates.has(n)) runStates.set(n, st);
        }
      }
    }
    try {
      const sched = loadCascadedScheduleConfig(ws);
      maxLaps = sched.max_laps ?? 3;
    } catch {
      maxLaps = 3;
    }
  } catch {}

  const verifiedIntegrations = readVerifiedBranchIntegrations({
    db: options.db,
    dbPath: options.dbPath,
    projectId: options.projectId,
    root,
    branchIntegrations: options.branchIntegrations,
  });

  const admissionCheck = evaluateIssueAdmission(rawForAdmission, new Map(), {
    integratedBranchIssues: verifiedIntegrations,
    mergedIssueNumbers: localMergedIssues,
    waitingApprovalIssueNumbers: waitingApprovalIssues,
    runStates,
    stateRoot,
    dossiersDir,
    runsDir,
    maxLaps,
  });

  // Check state and labels
  if (issueState !== "OPEN" || admissionCheck.reason === "issue_closed") {
    throw new Error("Requested issue is not open");
  }

  const normalizedLabels = new Set(labelNames.map((l) => l.toLowerCase()));
  if (
    !normalizedLabels.has("ready-for-agent") ||
    ["needs-info", "ready-for-human", "needs-triage", "wontfix", "needs-owner"].some((l) =>
      normalizedLabels.has(l),
    ) ||
    admissionCheck.reason === "held_by_label" ||
    admissionCheck.reason === "missing_ready_label" ||
    admissionCheck.reason === "excluded_by_label"
  ) {
    throw new Error("Requested issue is not ready for agent execution");
  }

  if (admissionCheck.reason === "actively_claimed") {
    throw new Error("Requested issue has a loop claim; resolve ownership before running");
  }

  if (admissionCheck.reason === "waiting_approval") {
    throw new Error("Requested issue is waiting for human approval (waiting_approval)");
  }

  if (admissionCheck.reason === "needs_owner") {
    throw new Error("Requested issue was escalated to needs_owner");
  }

  if (admissionCheck.reason === "interrupted") {
    throw new Error(
      "Requested issue has an interrupted run requiring manual intervention (interrupted)",
    );
  }

  if (admissionCheck.reason === "already_merged") {
    throw new Error("Requested issue is already merged (already_merged)");
  }

  if (admissionCheck.reason === "dossier_budget_exhausted") {
    throw new Error("Requested issue has exhausted dossier budget (dossier_budget_exhausted)");
  }

  if (
    admissionCheck.admission_status !== "admitted" &&
    !admissionCheck.reason.startsWith("waiting_on_dependency:")
  ) {
    throw new Error(`Requested issue is not admitted: ${admissionCheck.reason}`);
  }

  // Resolve all dependencies
  const resolved = [...allDeps].map((dependency) => {
    const data = read(
      ["issue", "view", String(dependency), "--repo", repo, "--json", "number,url,state"],
      root,
    ) as { number: number; url: string; state: string };
    const isClosedOrMerged =
      data?.state === "CLOSED" ||
      localMergedIssues.has(dependency) ||
      verifiedIntegrations.has(dependency);
    if (
      !data ||
      data.number !== dependency ||
      data.url !== `https://github.com/${repo}/issues/${dependency}` ||
      !isClosedOrMerged ||
      dependency === number
    ) {
      throw new Error(`Unresolved dependency #${dependency}`);
    }
    return { number: dependency, state: "CLOSED" };
  });

  // 6. Validate canonical sections if requested
  const parsedSections = validateSections
    ? validateCanonicalSections(body)
    : parseTicketSections(body);

  // 7. Normalize content and compute cryptographic SHA-256
  const normalizedJson = normalizeIssueContractContent({
    number,
    title,
    body,
    comments,
    dependencies: resolved,
    labels: labelNames,
    sections: parsedSections,
  });
  const sha256 = computeContractSha256(normalizedJson);

  // 8. Produce immutable frozen contract
  const boundContract = {
    number,
    url,
    title,
    body,
    comments: [...comments],
    dependencies: resolved.map((d) => ({ ...d })),
    activeClaim: false,
    labels: [...labelNames],
    sha256,
    contractSha256: sha256,
    sections: {
      partOf: parsedSections.partOf,
      sourceProblem: parsedSections.sourceProblem,
      outcome: parsedSections.outcome,
      invariants: [...parsedSections.invariants],
      acceptanceCriteria: [...parsedSections.acceptanceCriteria],
      boundary: parsedSections.boundary,
      dependsOn: [...parsedSections.dependsOn],
    },
  };

  return deepFreeze(boundContract) as unknown as BoundIssueContract;
}
