import { createHash } from "node:crypto";
import { resolveProjectWorkspace, getMergedIssueNumbers } from "@animus/contracts/paths";
import {
  parseDependencies,
  parseTicketSections,
  isActiveClaim,
  type StructuredTicketSections,
} from "./parser";
import { evaluateIssueAdmission, type RawIssue } from "./admission";
import type { IssueForgeAdapter } from "../registry/forge";

export type GithubRead = (args: string[], cwd: string) => unknown;

export interface BindIssueContractOptions {
  root?: string;
  number: number;
  repo: string;
  read?: GithubRead;
  forge?: IssueForgeAdapter;
  validateSections?: boolean;
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

export function normalizeIssueContractContent(contract: {
  number: number;
  title: string;
  body: string;
  comments: string[];
  dependencies: { number: number; state: string }[];
  labels?: string[];
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

  return JSON.stringify({
    number: contract.number,
    title: normTitle,
    body: normBody,
    comments: normComments,
    dependencies: normDeps,
    labels: normLabels,
  });
}

export function computeContractSha256(normalizedJson: string): string {
  return createHash("sha256").update(normalizedJson, "utf8").digest("hex");
}

export function bindIssueContract(options: BindIssueContractOptions): BoundIssueContract {
  const { root = process.cwd(), number, repo, read, forge, validateSections = true } = options;

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

  if (forge) {
    throw new Error(
      "Synchronous bindIssueContract requires 'read' adapter or preloaded data; use bindIssueContractAsync for forge",
    );
  }

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
  ) as Array<Array<{ body: string }>>;

  if (Array.isArray(pages)) {
    if (
      pages.some((page) => !Array.isArray(page) || page.some((c) => typeof c?.body !== "string"))
    ) {
      throw new Error("Unable to verify complete comments");
    }
    comments = pages.flat().map((c) => c.body);
  } else if (Array.isArray(rawIssue.comments)) {
    comments = rawIssue.comments.map((c) => c.body);
  }

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
  ) as Array<Array<{ number: number; state: string; repository_url: string }>>;

  if (Array.isArray(dependencyPages)) {
    if (dependencyPages.some((p) => !Array.isArray(p))) {
      throw new Error("Unable to verify native dependencies");
    }
    for (const dep of dependencyPages.flat()) {
      if (
        dep.repository_url !== `https://api.github.com/repos/${repo}` ||
        !Number.isSafeInteger(dep.number)
      ) {
        throw new Error(
          "Cross-repository or malformed native dependency requires human verification",
        );
      }
      nativeDependencies.push(dep.number);
    }
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
  let runsDir: string | undefined;
  let stateRoot: string | undefined;
  try {
    const ws = resolveProjectWorkspace(root);
    runsDir = ws.runsDir;
    stateRoot = ws.stateRoot;
    localMergedIssues = getMergedIssueNumbers(ws.runsDir);
  } catch {}

  const admissionCheck = evaluateIssueAdmission(rawForAdmission, new Map(), {
    mergedIssueNumbers: localMergedIssues,
    stateRoot,
    runsDir,
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

  // Resolve all dependencies
  const resolved = [...allDeps].map((dependency) => {
    const data = read(
      ["issue", "view", String(dependency), "--repo", repo, "--json", "number,url,state"],
      root,
    ) as { number: number; url: string; state: string };
    const isClosedOrMerged = data?.state === "CLOSED" || localMergedIssues.has(dependency);
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
  });
  const sha256 = computeContractSha256(normalizedJson);

  // 8. Produce immutable frozen contract
  const frozenSections = Object.freeze({
    partOf: parsedSections.partOf,
    sourceProblem: parsedSections.sourceProblem,
    outcome: parsedSections.outcome,
    invariants: Object.freeze([...parsedSections.invariants]),
    acceptanceCriteria: Object.freeze([...parsedSections.acceptanceCriteria]),
    boundary: parsedSections.boundary,
    dependsOn: Object.freeze([...parsedSections.dependsOn]),
  });

  return Object.freeze({
    number,
    url,
    title,
    body,
    comments: Object.freeze([...comments]),
    dependencies: Object.freeze(resolved.map((d) => Object.freeze({ ...d }))),
    activeClaim: false,
    labels: Object.freeze([...labelNames]),
    sha256,
    contractSha256: sha256,
    sections: frozenSections,
  }) as unknown as BoundIssueContract;
}
