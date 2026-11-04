import type { DatabaseSync } from "node:sqlite";
import type {
  TargetBindingSubmission,
  TargetBindingResult,
  OperatorErrorCode,
} from "@animus/contracts/operator";
import type { ForgeAdapter, ForgeIssue } from "../registry/forge";
import { assertIssueForge } from "../registry/forge";
import { evaluateBacklogAdmission } from "./admission";

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

  // 2. Query project checkout path and local branch integrations
  const projectRow = db
    .prepare("SELECT checkout_path FROM projects WHERE id = ?")
    .get(projectId) as { checkout_path?: string } | undefined;

  const integrations = db
    .prepare("SELECT issue_number, branch FROM project_issue_integrations WHERE project_id = ?")
    .all(projectId) as unknown as Array<{ issue_number: number; branch: string }>;

  const integratedMap = new Map<number, string>();
  for (const row of integrations) {
    integratedMap.set(row.issue_number, row.branch);
  }

  let nativeDeps: number[] = [];
  if (issueForge.getIssueDependencies) {
    try {
      nativeDeps = await issueForge.getIssueDependencies(repoName, issueNumber);
    } catch {}
  }

  // 3. Unified admission evaluation across all 7 invariants
  const admissionResult = await evaluateBacklogAdmission({
    repo: repoName,
    issues: [liveIssue],
    forge: issueForge,
    workspace: projectRow?.checkout_path,
    branchIntegrations: integratedMap,
    nativeDependencies: new Map([[issueNumber, nativeDeps]]),
  });

  const admission = admissionResult.issues[0];
  if (!admission) {
    throw new TargetBindingError("target_drift", "Admission evaluation failed");
  }

  // 4. Verify state
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
