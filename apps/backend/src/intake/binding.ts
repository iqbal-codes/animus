import type { DatabaseSync } from "node:sqlite";
import type {
  TargetBindingSubmission,
  TargetBindingResult,
  OperatorErrorCode,
} from "@animus/contracts/operator";
import type { ForgeAdapter, ForgeIssue } from "../registry/forge";
import { assertIssueForge } from "../registry/forge";
import { evaluateIssueAdmission, type RawIssue } from "./admission";
import { parseDependencies } from "./parser";

export class TargetBindingError extends Error {
  constructor(
    public readonly code: OperatorErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TargetBindingError";
  }
}

export interface VerifyTargetBindingOptions {
  projectId: string;
  repoName: string;
  issueNumber: number;
  submission: TargetBindingSubmission;
  forge: ForgeAdapter;
  db: DatabaseSync;
}

export async function verifyTargetBinding(
  options: VerifyTargetBindingOptions,
): Promise<TargetBindingResult> {
  const { projectId, repoName, issueNumber, submission, forge, db } = options;
  const issueForge = assertIssueForge(forge);

  // 1. Fetch fresh live issue from forge
  let liveIssue: ForgeIssue | null = null;
  try {
    liveIssue = await issueForge.getIssue(repoName, issueNumber);
  } catch (error: any) {
    throw new TargetBindingError(
      "target_drift",
      `Failed to query forge for #${issueNumber}: ${error?.message || String(error)}`,
    );
  }

  if (!liveIssue) {
    throw new TargetBindingError(
      "issue_not_found",
      `Target issue #${issueNumber} not found on ${repoName}`,
    );
  }

  const dependencies = [
    ...new Set(
      [
        liveIssue.body ?? "",
        ...(liveIssue.comments ?? []).map((comment) => comment.body ?? ""),
      ].flatMap(parseDependencies),
    ),
  ];
  const allByNumber = new Map<number, RawIssue>([[liveIssue.number, liveIssue]]);
  try {
    if (dependencies.length && issueForge.getIssueStates) {
      const states = await issueForge.getIssueStates(repoName, dependencies);
      for (const [number, state] of states) {
        if (state) allByNumber.set(number, { number, title: "", state });
      }
    } else {
      for (const number of dependencies) {
        const dependency = await issueForge.getIssue(repoName, number);
        if (dependency) allByNumber.set(number, dependency);
      }
    }
  } catch (error: any) {
    throw new TargetBindingError(
      "target_drift",
      `Failed to verify dependencies: ${error?.message || String(error)}`,
    );
  }

  // 3. Query local branch integrations for this project
  const integrations = db
    .prepare("SELECT issue_number, branch FROM project_issue_integrations WHERE project_id = ?")
    .all(projectId) as unknown as Array<{ issue_number: number; branch: string }>;

  const integratedMap = new Map<number, string>();
  for (const row of integrations) {
    integratedMap.set(row.issue_number, row.branch);
  }

  // 4. Fresh admission evaluation
  const admission = await evaluateIssueAdmission(liveIssue, allByNumber, {
    integratedBranchIssues: integratedMap,
    advisory: false,
  });

  // 5. Verify state
  const expectedState = (submission.expected_state || "OPEN").toUpperCase();
  const actualState = (liveIssue.state || "OPEN").toUpperCase();
  if (actualState !== expectedState) {
    throw new TargetBindingError(
      "target_drift",
      `State drift: expected ${expectedState}, but remote issue is ${actualState}`,
    );
  }

  // 6. Verify labels (deduplicated set comparison)
  const liveLabelSet = new Set(
    (liveIssue.labels || [])
      .map((l) => (typeof l === "string" ? l : l.name))
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0),
  );
  const liveLabels = Array.from(liveLabelSet).sort();

  const expectedLabelSet = new Set(
    (submission.expected_labels || [])
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0),
  );
  const expectedLabels = Array.from(expectedLabelSet).sort();

  if (
    liveLabels.length !== expectedLabels.length ||
    liveLabels.some((l, i) => l !== expectedLabels[i])
  ) {
    throw new TargetBindingError(
      "target_drift",
      `Label drift: expected [${expectedLabels.join(",")}], but remote issue has [${liveLabels.join(",")}]`,
    );
  }

  // 7. Verify admission status
  const expectedAdmission = submission.expected_admission_status || "admitted";
  if (admission.admission_status !== expectedAdmission) {
    throw new TargetBindingError(
      "target_drift",
      `Admission status drift: expected ${expectedAdmission}, but current admission is ${admission.admission_status} (${admission.reason})`,
    );
  }

  return {
    bound: true,
    project_id: projectId,
    repo_name: repoName,
    issue_number: issueNumber,
    state: actualState,
    labels: liveLabels,
    admission_status: admission.admission_status,
    bound_at: new Date().toISOString(),
  };
}
