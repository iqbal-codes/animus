import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  planRecordSchema,
  type PlanAcceptedRevision,
  type PlanAcceptanceCriterion,
  type PlanCoverage,
  type PlanDecision,
  type PlanDecisionSubmission,
  type PlanDependency,
  type PlanDependencySource,
  type PlanDependencyTarget,
  type PlanGateProfile,
  type PlanHold,
  type PlanImportSubmission,
  type PlanKind,
  type PlanManifest,
  type PlanMember,
  type PlanMemberRole,
  type PlanRecord,
  type PlanSummary,
  type WorkRecord,
} from "@animus/contracts/operator";
import { loadCascadedScheduleConfig, resolveProjectWorkspace } from "@animus/contracts/paths";
import type { ForgeAdapter, IssueForgeAdapter } from "../registry/forge";
import { assertIssueForge } from "../registry/forge";
import { isActiveClaim, parseDependencies, parseTicketSections } from "../intake/parser";
import { readVerifiedBranchIntegrations } from "../intake/admission";
import { WorkPersistenceError, WorkService } from "../work";
import {
  computeGraphHash,
  duplicateAcceptanceKeys,
  normalizeAcceptanceCriteria,
  parseCoverageClauses,
  type CoverageClause,
  type NormalizedCriterion,
} from "./parser";

export type PlanErrorCode =
  | "project_not_found"
  | "project_not_active"
  | "work_not_found"
  | "issue_not_found"
  | "plan_not_found"
  | "plan_import_failed"
  | "plan_storage_failed"
  | "intake_unavailable";

export class PlanError extends Error {
  constructor(
    public readonly code: PlanErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PlanError";
  }
}

interface ProjectRow {
  id: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
  status: string;
}

interface PlanRow {
  id: string;
  project_id: string;
  kind: PlanKind;
  root_work_id: string;
  root_revision_id: string;
  graph_hash: string;
  evidence_hash: string;
  delivery_branch: string;
  integration_branch: string | null;
  created_at: number;
  updated_at: number;
}

interface MemberDraft {
  work: WorkRecord;
  role: PlanMemberRole;
  gateProfile: PlanGateProfile;
  criteria: NormalizedCriterion[];
  coverage: CoverageClause[];
  dependencies: Map<number, Set<"textual" | "native">>;
}

interface DependencyDraft {
  work: WorkRecord;
  target: number;
  source: PlanDependencySource;
  targetRole: PlanDependencyTarget;
  targetWorkId: string | null;
  targetRevisionId: string | null;
}

interface EvidenceMember {
  work_id: string;
  issue_number: number;
  state: string;
  labels: string[];
  ready_for_agent: boolean;
  blocking_labels: string[];
  exclusion_labels: string[];
  active_claim: boolean;
  outcome: "admitted" | "held" | "excluded";
  reason: string;
}

interface PlanDraft {
  project: ProjectRow;
  kind: PlanKind;
  root: WorkRecord;
  members: MemberDraft[];
  dependencies: DependencyDraft[];
  coverage: Array<{ parent_ac_key: string; child_work_id: string; note: string | null }>;
  holds: PlanHold[];
  evidenceMembers: EvidenceMember[];
  deliveryBranch: string;
  integrationBranch: string | null;
  budgets: { child_max_laps: number; final_max_laps: number };
  graph: unknown;
  graphHash: string;
}

interface ExternalResolution {
  role: PlanDependencyTarget;
  workId: string | null;
  revisionId: string | null;
}

const BLOCKING_LABELS = ["needs-info", "ready-for-human", "needs-triage", "needs-owner"];
const APPROVABLE_HOLDS = new Set(["missing_ready_label", "unlabeled_awaiting_triage"]);

function declaredParent(body: string): number | null {
  const match = body.match(/^\s*Part of\s+#?(\d+)\b/im);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function sourceFor(kinds: Set<"textual" | "native">): PlanDependencySource {
  if (kinds.has("textual") && kinds.has("native")) return "textual+native";
  return kinds.has("native") ? "native" : "textual";
}

function hold(
  code: string,
  detail: string,
  options: {
    severity?: "blocking" | "conditional";
    member?: WorkRecord | null;
  } = {},
): PlanHold {
  return {
    code,
    severity: options.severity ?? "blocking",
    member_work_id: options.member?.id ?? null,
    issue_number: options.member?.issue_number ?? null,
    detail,
  };
}

function isApprovedHold(item: PlanHold): boolean {
  return item.severity === "blocking" && !APPROVABLE_HOLDS.has(item.code);
}

function planError(error: unknown): PlanError {
  if (error instanceof PlanError) return error;
  return new PlanError(
    "plan_import_failed",
    error instanceof Error ? error.message : String(error),
  );
}

export class PlanService {
  private readonly work: WorkService;
  private readonly forge: IssueForgeAdapter;

  constructor(
    private readonly db: DatabaseSync,
    forge: ForgeAdapter,
  ) {
    this.work = new WorkService(db);
    this.forge = assertIssueForge(forge);
  }

  async importPlan(projectId: string, submission: PlanImportSubmission): Promise<PlanRecord> {
    const project = this.project(projectId);
    const root = await this.resolveRootWork(project, submission);

    const draft = await this.buildDraft(project, root, submission);
    const evidenceHash = this.evidenceHash(draft);
    const existing = this.findReusablePlan(root.id, draft.graphHash, evidenceHash);
    if (existing) return this.record(existing);

    const planId = `plan_${randomUUID()}`;
    const now = Date.now();
    const admitted = !draft.holds.some((item) => item.severity === "blocking");
    const decisionHolds = admitted
      ? this.dynamicDependencyHolds(
          project,
          draft.dependencies,
          draft.integrationBranch ?? draft.deliveryBranch,
        )
      : draft.holds;

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw planError(error);
    }

    try {
      const raced = this.findReusablePlan(root.id, draft.graphHash, evidenceHash);
      if (raced) {
        this.db.exec("COMMIT;");
        return this.record(raced);
      }

      this.db
        .prepare(
          `INSERT INTO plans
             (id, project_id, kind, root_work_id, root_revision_id, graph_hash,
              evidence_hash, delivery_branch, integration_branch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          planId,
          project.id,
          draft.kind,
          draft.root.id,
          draft.root.revision.id,
          draft.graphHash,
          evidenceHash,
          draft.deliveryBranch,
          draft.integrationBranch,
          now,
          now,
        );

      for (const member of draft.members) {
        this.db
          .prepare(
            `INSERT INTO plan_members
               (plan_id, project_id, work_id, revision_id, role, gate_profile, issue_number)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            planId,
            project.id,
            member.work.id,
            member.work.revision.id,
            member.role,
            member.gateProfile,
            member.work.issue_number,
          );
        for (const criterion of member.criteria) {
          this.db
            .prepare(
              `INSERT INTO plan_acceptance_criteria
                 (id, plan_id, work_id, revision_id, ac_key, ordinal, text)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `ac_${randomUUID()}`,
              planId,
              member.work.id,
              member.work.revision.id,
              criterion.key,
              criterion.ordinal,
              criterion.text,
            );
        }
      }

      for (const dependency of draft.dependencies) {
        this.db
          .prepare(
            `INSERT INTO plan_dependencies
               (id, plan_id, work_id, revision_id, target_issue_number, source,
                target_role, target_work_id, target_revision_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `dep_${randomUUID()}`,
            planId,
            dependency.work.id,
            dependency.work.revision.id,
            dependency.target,
            dependency.source,
            dependency.targetRole,
            dependency.targetWorkId,
            dependency.targetRevisionId,
          );
      }

      for (const coverage of draft.coverage) {
        this.db
          .prepare(
            `INSERT INTO plan_coverage (plan_id, parent_ac_key, child_work_id, note)
             VALUES (?, ?, ?, ?)`,
          )
          .run(planId, coverage.parent_ac_key, coverage.child_work_id, coverage.note);
      }

      for (const item of draft.holds) this.insertHold(planId, item, now);

      const evidence = JSON.stringify({
        rules_version: "prepared-plan-v1",
        members: draft.evidenceMembers,
        holds: draft.holds,
      });
      const manifestId = this.insertManifest(planId, project.id, draft);
      this.insertDecision({
        planId,
        sequence: 1,
        action: "import",
        outcome: admitted ? "admitted" : "held",
        actor: "factory",
        source: "import_authorization",
        reason: admitted
          ? "Imported with initial ready-for-agent authorization"
          : "Imported with explicit holds",
        manifestId: admitted ? manifestId : null,
        holds: decisionHolds,
        evidence,
        recordedAt: now,
      });

      const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as unknown as
        | PlanRow
        | undefined;
      if (!row) throw new PlanError("plan_storage_failed", "Imported plan is unreadable");

      this.db.exec("COMMIT;");
      return this.record(row);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw planError(error);
    }
  }

  listPlans(projectId: string): PlanSummary[] {
    this.project(projectId);
    const rows = this.db
      .prepare("SELECT id FROM plans WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as Array<{ id: string }>;
    return rows.map((row) => this.summary(this.recordById(projectId, row.id)));
  }

  getPlan(projectId: string, planId: string): PlanRecord {
    this.project(projectId);
    return this.recordById(projectId, planId);
  }

  approvePlan(
    projectId: string,
    planId: string,
    submission: PlanDecisionSubmission = {},
  ): PlanRecord {
    const project = this.project(projectId);
    const current = this.recordById(projectId, planId);
    const latest = current.decisions.at(-1);
    if (latest?.outcome === "admitted") return current;

    const actor = submission.actor ?? "operator";
    const now = Date.now();
    const blocking = this.storedHolds(planId).filter(isApprovedHold);
    const admitted = blocking.length === 0;
    const decisionHolds = this.currentHolds(project, planId).filter(
      (item) => !(admitted && APPROVABLE_HOLDS.has(item.code)),
    );

    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw planError(error);
    }

    try {
      const refreshed = this.recordById(projectId, planId);
      const refreshedLatest = refreshed.decisions.at(-1);
      if (refreshedLatest?.outcome === "admitted") {
        this.db.exec("COMMIT;");
        return refreshed;
      }
      // Re-authorizing a revoked plan is a new operator decision, but it must bind to
      // the exact revocation the operator observed. A bare or stale approval (for
      // example an HTTP retry queued before revocation) never resurrects the plan.
      if (
        refreshedLatest?.outcome === "revoked" &&
        submission.expected_sequence !== refreshedLatest.sequence
      ) {
        this.db.exec("COMMIT;");
        return refreshed;
      }
      const sequence = (refreshedLatest?.sequence ?? 0) + 1;
      const manifestId = admitted
        ? this.ensureManifestFromStored(project, refreshed)
        : (refreshed.decisions.find((decision) => decision.manifest_id)?.manifest_id ?? null);
      this.insertDecision({
        planId,
        sequence,
        action: "approve",
        outcome: admitted ? "admitted" : "held",
        actor,
        source: "operator",
        reason:
          submission.reason ??
          (admitted
            ? "Operator authorized the complete plan"
            : "Operator approval rejected: plan still has non-approvable holds"),
        manifestId,
        holds: decisionHolds,
        evidence: JSON.stringify({
          rules_version: "prepared-plan-v1",
          remaining_holds: this.storedHolds(planId),
          overridable_holds: [...APPROVABLE_HOLDS],
          prior_sequence: refreshedLatest?.sequence ?? null,
          prior_outcome: refreshedLatest?.outcome ?? null,
          expected_sequence: submission.expected_sequence ?? null,
          graph_hash: refreshed.graph_hash,
          accepted_revision_id: refreshed.root_revision_id,
        }),
        recordedAt: now,
      });
      this.db.exec("COMMIT;");
      return this.recordById(projectId, planId);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw planError(error);
    }
  }

  revokePlan(
    projectId: string,
    planId: string,
    submission: PlanDecisionSubmission = {},
  ): PlanRecord {
    this.project(projectId);
    const current = this.recordById(projectId, planId);
    const latest = current.decisions.at(-1);
    if (latest?.outcome === "revoked") return current;

    const now = Date.now();
    try {
      this.db.exec("BEGIN IMMEDIATE;");
    } catch (error) {
      throw planError(error);
    }
    try {
      const refreshed = this.recordById(projectId, planId);
      const refreshedLatest = refreshed.decisions.at(-1);
      if (refreshedLatest?.outcome === "revoked") {
        this.db.exec("COMMIT;");
        return refreshed;
      }
      this.insertDecision({
        planId,
        sequence: (refreshedLatest?.sequence ?? 0) + 1,
        action: "revoke",
        outcome: "revoked",
        actor: submission.actor ?? "operator",
        source: "operator",
        reason: submission.reason ?? "Operator revoked the plan",
        manifestId:
          refreshed.decisions.find((decision) => decision.manifest_id)?.manifest_id ?? null,
        holds: refreshed.holds,
        evidence: JSON.stringify({
          rules_version: "prepared-plan-v1",
          revoked_at: now,
          accepted_revision_id: refreshed.accepted_revision?.revision_id ?? null,
        }),
        recordedAt: now,
      });
      this.db.exec("COMMIT;");
      return this.recordById(projectId, planId);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw planError(error);
    }
  }

  private findReusablePlan(
    rootWorkId: string,
    graphHash: string,
    evidenceHash: string,
  ): PlanRow | undefined {
    const rows = this.db
      .prepare(
        "SELECT * FROM plans WHERE root_work_id = ? AND graph_hash = ? ORDER BY created_at DESC",
      )
      .all(rootWorkId, graphHash) as unknown as PlanRow[];
    for (const row of rows) {
      const latest = this.db
        .prepare(
          "SELECT outcome FROM plan_decisions WHERE plan_id = ? ORDER BY sequence DESC LIMIT 1",
        )
        .get(row.id) as { outcome: "admitted" | "held" | "revoked" } | undefined;
      if (latest?.outcome === "admitted" || latest?.outcome === "revoked") return row;
    }
    return rows.find((row) => row.evidence_hash === evidenceHash);
  }

  private evidenceHash(draft: PlanDraft): string {
    return computeGraphHash({
      holds: draft.holds,
      evidence_members: draft.evidenceMembers,
    });
  }

  private project(projectId: string): ProjectRow {
    const row = this.db
      .prepare("SELECT id, repo_id, repo_name, checkout_path, status FROM projects WHERE id = ?")
      .get(projectId) as unknown as ProjectRow | undefined;
    if (!row) throw new PlanError("project_not_found", `Project ${projectId} not found`);
    if (row.status !== "active") {
      throw new PlanError("project_not_active", `Project ${projectId} is ${row.status}`);
    }
    return row;
  }

  private async resolveRootWork(
    project: ProjectRow,
    submission: PlanImportSubmission,
  ): Promise<WorkRecord> {
    if (submission.work_id) {
      try {
        return this.work.getWorkById(project.id, submission.work_id);
      } catch (error) {
        if (error instanceof WorkPersistenceError && error.code === "work_not_found") {
          throw new PlanError("work_not_found", `Work ${submission.work_id} not found`);
        }
        throw planError(error);
      }
    }
    const local = this.work.getWorkByIssue(project.id, submission.issue_number!);
    if (local) return local;
    return await this.importIssue(project, submission.issue_number!);
  }

  private async importIssue(project: ProjectRow, issueNumber: number): Promise<WorkRecord> {
    let source;
    try {
      source = await this.forge.getIssue(project.repo_name, issueNumber);
    } catch (error) {
      throw new PlanError(
        "intake_unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!source) throw new PlanError("issue_not_found", `Issue #${issueNumber} not found`);
    try {
      return this.work.importIssue(
        { id: project.id, repo_id: project.repo_id, repo_name: project.repo_name },
        source,
      );
    } catch (error) {
      throw planError(error);
    }
  }

  private async buildDraft(
    project: ProjectRow,
    root: WorkRecord,
    submission: PlanImportSubmission,
  ): Promise<PlanDraft> {
    const holds: PlanHold[] = [];
    const rootIssue = root.issue_number;
    const rootParent = declaredParent(root.revision.source.body);
    const members: MemberDraft[] = [];

    if (rootParent !== null) {
      holds.push(
        hold(
          "inconsistent_parent_child_ownership",
          `Root work #${rootIssue} declares Part of #${rootParent}; a parent cannot be imported as its own plan root`,
          { member: root },
        ),
      );
    }

    if (submission.kind === "standalone") {
      if (rootParent !== null) {
        holds.push(
          hold(
            "inconsistent_parent_child_ownership",
            `Work #${rootIssue} is a child ticket (Part of #${rootParent}); import the parent as a spec plan`,
            { member: root },
          ),
        );
      }
      const discovered = await this.discoverChildren(project, root, holds, true);
      if (discovered.length > 0) {
        holds.push(
          hold(
            "inconsistent_parent_child_ownership",
            `Work #${rootIssue} has discovered child tickets (${discovered
              .map((child) => `#${child.issue_number}`)
              .join(", ")}); import it as a spec plan instead of standalone`,
            { member: root },
          ),
        );
      }
      members.push({
        work: root,
        role: "ticket",
        gateProfile: "standalone",
        criteria: [],
        coverage: [],
        dependencies: new Map(),
      });
    } else {
      const children = await this.discoverChildren(project, root, holds, false);
      if (children.length === 0) {
        holds.push(
          hold(
            "incomplete_child_discovery",
            `Spec #${rootIssue} has no discovered child tickets; a spec is never executed as standalone work`,
            { member: root },
          ),
        );
      }
      members.push({
        work: root,
        role: "spec",
        gateProfile: "final",
        criteria: [],
        coverage: [],
        dependencies: new Map(),
      });
      for (const child of children) {
        const parent = declaredParent(child.revision.source.body);
        if (parent !== null && parent !== rootIssue) {
          holds.push(
            hold(
              "inconsistent_parent_child_ownership",
              `Work #${child.issue_number} declares Part of #${parent}, not this spec #${rootIssue}`,
              { member: child },
            ),
          );
          continue;
        }
        members.push({
          work: child,
          role: "ticket",
          gateProfile: "child",
          criteria: [],
          coverage: [],
          dependencies: new Map(),
        });
      }
      await this.detectNestedSpecs(project, rootIssue, members, holds);
    }

    const uniqueMembers = new Map<string, MemberDraft>();
    for (const member of members) {
      if (uniqueMembers.has(member.work.id)) continue;
      uniqueMembers.set(member.work.id, member);
    }
    const finalMembers = [...uniqueMembers.values()].sort(
      (left, right) => left.work.issue_number - right.work.issue_number,
    );

    this.normalizeCriteria(finalMembers, holds);
    this.normalizeCoverage(finalMembers, holds);
    await this.normalizeDependencies(project, finalMembers, holds);

    const memberIssues = new Map<number, MemberDraft>(
      finalMembers.map((member) => [member.work.issue_number, member]),
    );
    this.detectCycles(finalMembers, memberIssues, holds);
    for (const member of finalMembers) {
      for (const target of member.dependencies.keys()) {
        const targetMember = memberIssues.get(target);
        if (targetMember?.role === "spec") {
          holds.push(
            hold(
              "dependency_on_planning_record",
              `Work #${member.work.issue_number} depends on planning record #${target}; parent specs are never dispatched as prerequisites`,
              { member: member.work },
            ),
          );
        }
      }
    }

    for (const member of finalMembers) {
      if (member.role !== "ticket") continue;
      const labels = member.work.revision.source.labels.map((label) => label.toLowerCase());
      const labelSet = new Set(labels);
      if (member.work.revision.source.state !== "OPEN") {
        holds.push(
          hold(
            "issue_closed",
            `Work #${member.work.issue_number} is ${member.work.revision.source.state}`,
            { member: member.work },
          ),
        );
      }
      if (labelSet.size === 0) {
        holds.push(
          hold("unlabeled_awaiting_triage", `Work #${member.work.issue_number} has no labels`, {
            member: member.work,
          }),
        );
      } else if (labelSet.has("wontfix")) {
        holds.push(
          hold("excluded_by_label", `Work #${member.work.issue_number} is wontfix`, {
            member: member.work,
          }),
        );
      } else {
        const blocking = BLOCKING_LABELS.filter((label) => labelSet.has(label));
        if (blocking.length > 0) {
          holds.push(
            hold(
              "held_by_label",
              `Work #${member.work.issue_number} has blocking labels: ${blocking.join(", ")}`,
              { member: member.work },
            ),
          );
        }
        if (!labelSet.has("ready-for-agent")) {
          holds.push(
            hold(
              "missing_ready_label",
              `Work #${member.work.issue_number} is missing ready-for-agent authorization`,
              { member: member.work },
            ),
          );
        }
      }
      const claimed = isActiveClaim(
        member.work.revision.source.comments.map((comment) => ({ body: comment.body })),
        member.work.revision.source.body,
      );
      if (claimed) {
        holds.push(
          hold("actively_claimed", `Work #${member.work.issue_number} has an active loop claim`, {
            member: member.work,
          }),
        );
      }
    }

    const specRoot = finalMembers.find((member) => member.role === "spec");
    if (specRoot && specRoot.work.revision.source.state !== "OPEN") {
      holds.push(
        hold(
          "issue_closed",
          `Spec #${specRoot.work.issue_number} is ${specRoot.work.revision.source.state}`,
          { member: specRoot.work },
        ),
      );
    }

    const evidenceMembers = this.admissionEvidence(finalMembers, holds);
    const dependencies = await this.buildDependencyRows(project, finalMembers, holds);
    const coverage = this.coverageRows(specRoot, finalMembers);
    const deliveryBranch = submission.delivery_branch ?? "main";
    const integrationBranch =
      submission.kind === "spec" ? `factory/spec-${rootIssue}-integration` : null;
    const maxLaps = this.maxLaps(project);
    const graph = {
      version: 1,
      kind: submission.kind,
      root: {
        work_id: root.id,
        revision_id: root.revision.id,
        issue_number: root.issue_number,
        content_hash: root.revision.content_hash,
      },
      members: finalMembers.map((member) => ({
        work_id: member.work.id,
        revision_id: member.work.revision.id,
        issue_number: member.work.issue_number,
        content_hash: member.work.revision.content_hash,
        role: member.role,
        gate_profile: member.gateProfile,
      })),
      acceptance_criteria: finalMembers.flatMap((member) =>
        member.criteria.map((criterion) => ({
          work_id: member.work.id,
          ac_key: criterion.key,
          text: criterion.text,
        })),
      ),
      coverage: coverage.map((row) => ({
        parent_ac_key: row.parent_ac_key,
        child_work_id: row.child_work_id,
      })),
      dependencies: dependencies.map((dependency) => ({
        work_id: dependency.work.id,
        target_issue_number: dependency.target,
        source: dependency.source,
        internal: dependency.targetRole === "internal",
      })),
      targets: {
        delivery_branch: deliveryBranch,
        integration_branch: integrationBranch,
        final_pr_base: deliveryBranch,
      },
      merge_policy: {
        child: "auto_after_gates" as const,
        standalone: "manual" as const,
        final: "manual" as const,
      },
      budgets: { child_max_laps: maxLaps, final_max_laps: maxLaps },
    };

    return {
      project,
      kind: submission.kind,
      root,
      members: finalMembers,
      dependencies,
      coverage,
      holds: dedupeHolds(holds),
      evidenceMembers,
      deliveryBranch,
      integrationBranch,
      budgets: { child_max_laps: maxLaps, final_max_laps: maxLaps },
      graph,
      graphHash: computeGraphHash(graph),
    };
  }

  private admissionEvidence(groups: MemberDraft[], holds: PlanHold[]): EvidenceMember[] {
    return groups.map((member) => {
      const labels = member.work.revision.source.labels;
      const lower = labels.map((label) => label.toLowerCase());
      const labelSet = new Set(lower);
      const memberHolds = holds.filter(
        (item) => item.member_work_id === member.work.id && item.severity === "blocking",
      );
      const blocked = memberHolds.filter((item) => item.code !== "missing_ready_label");
      return {
        work_id: member.work.id,
        issue_number: member.work.issue_number,
        state: member.work.revision.source.state,
        labels,
        ready_for_agent: labelSet.has("ready-for-agent"),
        blocking_labels: BLOCKING_LABELS.filter((label) => labelSet.has(label)),
        exclusion_labels: labelSet.has("wontfix") ? ["wontfix"] : [],
        active_claim: isActiveClaim(
          member.work.revision.source.comments.map((comment) => ({ body: comment.body })),
          member.work.revision.source.body,
        ),
        outcome:
          labelSet.has("wontfix") && member.role === "ticket"
            ? "excluded"
            : blocked.length > 0
              ? "held"
              : "admitted",
        reason: memberHolds[0]?.code ?? "admitted_ready",
      };
    });
  }

  private normalizeCriteria(members: MemberDraft[], holds: PlanHold[]): void {
    for (const member of members) {
      const sections = parseTicketSections(member.work.revision.source.body);
      const criteria = normalizeAcceptanceCriteria(sections.acceptanceCriteria);
      if (criteria.length === 0) {
        holds.push(
          hold(
            "missing_acceptance_criteria",
            `Work #${member.work.issue_number} has no addressable acceptance criteria`,
            { member: member.work },
          ),
        );
      }
      const duplicates = duplicateAcceptanceKeys(criteria);
      if (duplicates.length > 0) {
        holds.push(
          hold(
            "duplicate_acceptance_criteria",
            `Work #${member.work.issue_number} repeats ${duplicates.join(", ")}`,
            { member: member.work },
          ),
        );
      }
      // Persist one row per addressable key so the relational identity stays strict;
      // the malformed source is diagnosed by the hold above rather than by a storage abort.
      const uniqueCriteria: NormalizedCriterion[] = [];
      const seenKeys = new Set<string>();
      for (const criterion of criteria) {
        if (seenKeys.has(criterion.key)) continue;
        seenKeys.add(criterion.key);
        uniqueCriteria.push(criterion);
      }
      member.criteria = uniqueCriteria;
      if (member.role === "ticket")
        member.coverage = parseCoverageClauses(member.work.revision.source.body);
    }
  }

  private normalizeCoverage(members: MemberDraft[], holds: PlanHold[]): void {
    const root = members.find((member) => member.role === "spec");
    if (!root) return;
    const parentKeys = new Set(root.criteria.map((criterion) => criterion.key));
    const covered = new Map<string, string[]>();
    for (const member of members) {
      if (member.role !== "ticket") continue;
      const seen = new Set<number>();
      for (const clause of member.coverage) {
        for (const key of clause.keys) {
          const acKey = `AC${key}`;
          if (!parentKeys.has(acKey)) {
            holds.push(
              hold(
                "unresolved_acceptance_coverage",
                `Work #${member.work.issue_number} claims coverage of ${acKey}, which the spec does not define`,
                { member: member.work },
              ),
            );
            continue;
          }
          if (seen.has(key)) continue;
          seen.add(key);
          const existing = covered.get(acKey) ?? [];
          existing.push(member.work.id);
          covered.set(acKey, existing);
        }
      }
    }
    const uncovered = [...parentKeys].filter((key) => !covered.has(key));
    if (uncovered.length > 0) {
      holds.push(
        hold(
          "uncovered_parent_acceptance_criteria",
          `Spec #${root.work.issue_number} acceptance criteria have no child coverage: ${uncovered
            .sort(acKeySort)
            .join(", ")}`,
          { member: root.work },
        ),
      );
    }
  }

  private coverageRows(
    root: MemberDraft | undefined,
    members: MemberDraft[],
  ): Array<{ parent_ac_key: string; child_work_id: string; note: string | null }> {
    if (!root) return [];
    const parentKeys = new Set(root.criteria.map((criterion) => criterion.key));
    const rows: Array<{ parent_ac_key: string; child_work_id: string; note: string | null }> = [];
    const seen = new Set<string>();
    for (const member of members) {
      if (member.role !== "ticket") continue;
      for (const clause of member.coverage) {
        for (const key of clause.keys) {
          const acKey = `AC${key}`;
          if (!parentKeys.has(acKey)) continue;
          const identity = `${acKey}:${member.work.id}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          rows.push({
            parent_ac_key: acKey,
            child_work_id: member.work.id,
            note: clause.note,
          });
        }
      }
    }
    rows.sort((left, right) => {
      const key = acKeySort(left.parent_ac_key, right.parent_ac_key);
      return key !== 0 ? key : left.child_work_id.localeCompare(right.child_work_id);
    });
    return rows;
  }

  private async normalizeDependencies(
    project: ProjectRow,
    members: MemberDraft[],
    holds: PlanHold[],
  ): Promise<void> {
    for (const member of members) {
      const body = member.work.revision.source.body;
      const commentBodies = member.work.revision.source.comments.map((comment) => comment.body);
      for (const target of parseDependencies([body, ...commentBodies].join("\n"))) {
        addDependency(member.dependencies, target, "textual");
      }
      if (typeof this.forge.getIssueDependencies === "function") {
        try {
          const native = await this.forge.getIssueDependencies(
            project.repo_name,
            member.work.issue_number,
          );
          for (const target of native) addDependency(member.dependencies, target, "native");
        } catch (error) {
          holds.push(
            hold(
              "dependency_lookup_failed",
              `Native dependency discovery failed for #${member.work.issue_number}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { member: member.work },
            ),
          );
        }
      }
    }
  }

  private async buildDependencyRows(
    project: ProjectRow,
    members: MemberDraft[],
    holds: PlanHold[],
  ): Promise<DependencyDraft[]> {
    const memberIssues = new Set(members.map((member) => member.work.issue_number));
    const resolutions = new Map<number, ExternalResolution>();
    const rows: DependencyDraft[] = [];
    for (const member of members) {
      for (const [target, kinds] of [...member.dependencies.entries()].sort(
        (a, b) => a[0] - b[0],
      )) {
        if (memberIssues.has(target)) {
          rows.push({
            work: member.work,
            target,
            source: sourceFor(kinds),
            targetRole: "internal",
            targetWorkId: null,
            targetRevisionId: null,
          });
          continue;
        }
        let resolved = resolutions.get(target);
        if (!resolved) {
          resolved = await this.resolveExternalDependency(project, target, member.work, holds);
          resolutions.set(target, resolved);
        }
        rows.push({
          work: member.work,
          target,
          source: sourceFor(kinds),
          targetRole: resolved.role,
          targetWorkId: resolved.workId,
          targetRevisionId: resolved.revisionId,
        });
      }
    }
    return rows;
  }

  private async resolveExternalDependency(
    project: ProjectRow,
    target: number,
    member: WorkRecord,
    holds: PlanHold[],
  ): Promise<ExternalResolution> {
    const local = this.work.getWorkByIssue(project.id, target);
    if (local) {
      return { role: "external", workId: local.id, revisionId: local.revision.id };
    }
    try {
      if (typeof this.forge.getIssueStates === "function") {
        const states = await this.forge.getIssueStates(project.repo_name, [target]);
        const state = states.get(target);
        if (state === "CLOSED") return { role: "external", workId: null, revisionId: null };
        if (state === null || state === undefined) {
          holds.push(
            hold(
              "unresolved_reference",
              `Prerequisite #${target} referenced by #${member.issue_number} cannot be resolved`,
              { member },
            ),
          );
          return { role: "unresolved", workId: null, revisionId: null };
        }
      }
      const issue = await this.forge.getIssue(project.repo_name, target);
      if (!issue) {
        holds.push(
          hold(
            "unresolved_reference",
            `Prerequisite #${target} referenced by #${member.issue_number} cannot be resolved`,
            { member },
          ),
        );
        return { role: "unresolved", workId: null, revisionId: null };
      }
      const imported = this.work.importIssue(
        { id: project.id, repo_id: project.repo_id, repo_name: project.repo_name },
        issue,
      );
      return { role: "external", workId: imported.id, revisionId: imported.revision.id };
    } catch (error) {
      holds.push(
        hold(
          "dependency_lookup_failed",
          `Could not resolve prerequisite #${target} for #${member.issue_number}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { member },
        ),
      );
      return { role: "unresolved", workId: null, revisionId: null };
    }
  }

  private detectCycles(
    members: MemberDraft[],
    memberIssues: Map<number, MemberDraft>,
    holds: PlanHold[],
  ): void {
    const state = new Map<number, number>();
    const visit = (issue: number, path: number[]): void => {
      state.set(issue, 1);
      const member = memberIssues.get(issue);
      if (member) {
        for (const target of member.dependencies.keys()) {
          if (!memberIssues.has(target)) continue;
          const targetState = state.get(target) ?? 0;
          if (targetState === 1) {
            const cycle = [...path, issue, target];
            holds.push(
              hold(
                "dependency_cycle",
                `Cyclic dependency detected: ${cycle.map((n) => `#${n}`).join(" -> ")}`,
                { member: member.work },
              ),
            );
            continue;
          }
          if (targetState === 0) visit(target, [...path, issue]);
        }
      }
      state.set(issue, 2);
    };
    for (const member of members) {
      if ((state.get(member.work.issue_number) ?? 0) === 0) visit(member.work.issue_number, []);
    }
  }

  private async discoverChildren(
    project: ProjectRow,
    root: WorkRecord,
    holds: PlanHold[],
    standaloneProbe: boolean,
  ): Promise<WorkRecord[]> {
    const rootIssue = root.issue_number;
    const candidates = new Map<number, WorkRecord>();
    for (const item of this.work.listWork(project.id)) {
      if (item.id === root.id) continue;
      if (declaredParent(item.revision.source.body) === rootIssue) {
        candidates.set(item.issue_number, item);
      }
    }

    let discoveryFailed = false;
    if (typeof this.forge.listIssues === "function") {
      try {
        const issues = await this.forge.listIssues(project.repo_name, "ALL");
        for (const issue of issues) {
          if (issue.number === rootIssue || !issue.body) continue;
          if (declaredParent(issue.body) !== rootIssue) continue;
          if (candidates.has(issue.number)) continue;
          const imported = await this.importChild(project, issue.number, holds);
          if (imported) candidates.set(imported.issue_number, imported);
        }
      } catch (error) {
        discoveryFailed = true;
        if (!standaloneProbe) {
          holds.push(
            hold(
              "incomplete_child_discovery",
              `Child discovery failed for spec #${rootIssue}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { member: root },
            ),
          );
        }
      }
    } else {
      discoveryFailed = true;
    }

    if (typeof this.forge.getSubIssues === "function") {
      try {
        const native = await this.forge.getSubIssues(project.repo_name, rootIssue);
        for (const issueNumber of native) {
          if (issueNumber === rootIssue || candidates.has(issueNumber)) continue;
          const imported = await this.importChild(project, issueNumber, holds);
          if (imported) candidates.set(imported.issue_number, imported);
        }
      } catch (error) {
        discoveryFailed = true;
        if (!standaloneProbe) {
          holds.push(
            hold(
              "incomplete_child_discovery",
              `Native sub-issue discovery failed for spec #${rootIssue}: ${
                error instanceof Error ? error.message : String(error)
              }`,
              { member: root },
            ),
          );
        }
      }
    } else {
      discoveryFailed = true;
      if (!standaloneProbe) {
        holds.push(
          hold(
            "incomplete_child_discovery",
            `Native sub-issue discovery is unavailable for spec #${rootIssue}; child completeness cannot be verified`,
            { member: root },
          ),
        );
      }
    }

    if (standaloneProbe && discoveryFailed) {
      holds.push(
        hold(
          "incomplete_child_discovery",
          `Could not verify that work #${rootIssue} has no child tickets; import as a spec plan or restore discovery`,
          { member: root },
        ),
      );
    }

    return [...candidates.values()].sort((left, right) => left.issue_number - right.issue_number);
  }

  private async importChild(
    project: ProjectRow,
    issueNumber: number,
    holds: PlanHold[],
  ): Promise<WorkRecord | null> {
    const existing = this.work.getWorkByIssue(project.id, issueNumber);
    if (existing) return existing;
    try {
      return await this.importIssue(project, issueNumber);
    } catch (error) {
      holds.push(
        hold(
          "incomplete_child_discovery",
          `Child #${issueNumber} could not be imported: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
      return null;
    }
  }

  private async detectNestedSpecs(
    project: ProjectRow,
    rootIssue: number,
    members: MemberDraft[],
    holds: PlanHold[],
  ): Promise<void> {
    const childIssues = new Set(
      members
        .filter((member) => member.role === "ticket")
        .map((member) => member.work.issue_number),
    );
    for (const item of this.work.listWork(project.id)) {
      const parent = declaredParent(item.revision.source.body);
      if (parent === null || parent === rootIssue || !childIssues.has(parent)) continue;
      const nested = members.find((member) => member.work.issue_number === parent);
      if (!nested) continue;
      holds.push(
        hold(
          "inconsistent_parent_child_ownership",
          `Work #${parent} is itself a parent spec of #${item.issue_number}; nested specs cannot dispatch as child tickets`,
          { member: nested.work },
        ),
      );
    }
    if (typeof this.forge.getSubIssues === "function") {
      for (const member of members) {
        if (member.role !== "ticket") continue;
        try {
          const nested = await this.forge.getSubIssues(project.repo_name, member.work.issue_number);
          if (nested.length > 0) {
            holds.push(
              hold(
                "inconsistent_parent_child_ownership",
                `Work #${member.work.issue_number} has native sub-issues (${nested
                  .map((n) => `#${n}`)
                  .join(", ")}); nested specs cannot dispatch as child tickets`,
                { member: member.work },
              ),
            );
          }
        } catch {
          holds.push(
            hold(
              "incomplete_child_discovery",
              `Could not verify that child #${member.work.issue_number} has no nested children`,
              { member: member.work },
            ),
          );
        }
      }
    }
  }

  private maxLaps(project: ProjectRow): number {
    try {
      const workspace = resolveProjectWorkspace(project.checkout_path);
      return loadCascadedScheduleConfig(workspace).max_laps ?? 3;
    } catch {
      return 3;
    }
  }

  private insertHold(planId: string, item: PlanHold, now: number): void {
    this.db
      .prepare(
        `INSERT INTO plan_holds
           (id, plan_id, member_work_id, issue_number, code, severity, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `hold_${randomUUID()}`,
        planId,
        item.member_work_id,
        item.issue_number,
        item.code,
        item.severity,
        item.detail,
        now,
      );
  }

  private insertManifest(planId: string, projectId: string, draft: PlanDraft): string {
    const manifestId = `pman_${randomUUID()}`;
    const now = Date.now();
    const manifest = this.manifestValue(planId, projectId, draft, now);
    this.db
      .prepare(
        `INSERT INTO plan_manifests (id, plan_id, project_id, graph_hash, manifest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(manifestId, planId, projectId, draft.graphHash, JSON.stringify(manifest), now);
    return manifestId;
  }

  private manifestValue(
    planId: string,
    projectId: string,
    draft: PlanDraft,
    frozenAt: number,
  ): PlanManifest {
    const coverage = new Map<string, string[]>();
    for (const row of draft.coverage) {
      const existing = coverage.get(row.parent_ac_key) ?? [];
      if (!existing.includes(row.child_work_id)) existing.push(row.child_work_id);
      coverage.set(row.parent_ac_key, existing);
    }
    return {
      version: 1,
      plan_id: planId,
      project_id: projectId,
      kind: draft.kind,
      graph_hash: draft.graphHash,
      root: {
        work_id: draft.root.id,
        revision_id: draft.root.revision.id,
        revision_number: draft.root.revision.revision_number,
        issue_number: draft.root.issue_number,
        content_hash: draft.root.revision.content_hash,
      },
      members: draft.members.map((member) => ({
        work_id: member.work.id,
        revision_id: member.work.revision.id,
        revision_number: member.work.revision.revision_number,
        issue_number: member.work.issue_number,
        content_hash: member.work.revision.content_hash,
        role: member.role,
        gate_profile: member.gateProfile,
      })),
      acceptance_criteria: draft.members.flatMap((member) =>
        member.criteria.map((criterion) => ({
          work_id: member.work.id,
          ac_key: criterion.key,
          text: criterion.text,
        })),
      ),
      ac_coverage: [...coverage.entries()]
        .sort((left, right) => acKeySort(left[0], right[0]))
        .map(([parent_ac_key, child_work_ids]) => ({ parent_ac_key, child_work_ids })),
      dependencies: draft.dependencies.map((dependency) => ({
        work_id: dependency.work.id,
        target_issue_number: dependency.target,
        source: dependency.source,
        target_work_id: dependency.targetWorkId,
        internal: dependency.targetRole === "internal",
      })),
      targets: {
        delivery_branch: draft.deliveryBranch,
        integration_branch: draft.integrationBranch,
        final_pr_base: draft.deliveryBranch,
      },
      gate_profiles: draft.members.map((member) => ({
        work_id: member.work.id,
        gate_profile: member.gateProfile,
      })),
      merge_policy: {
        child: "auto_after_gates",
        standalone: "manual",
        final: "manual",
      },
      budgets: draft.budgets,
      frozen_at: frozenAt,
    };
  }

  private ensureManifestFromStored(project: ProjectRow, record: PlanRecord): string {
    // The manifest is persisted at import for held plans too, so approval reuses the
    // exact frozen graph identity instead of re-materializing a default budget.
    const row = this.db
      .prepare("SELECT id FROM plan_manifests WHERE plan_id = ? AND graph_hash = ?")
      .get(record.id, record.graph_hash) as { id: string } | undefined;
    if (row) return row.id;
    const stored = this.loadDraftFromStored(project, record);
    return this.insertManifest(record.id, project.id, stored);
  }

  private loadDraftFromStored(project: ProjectRow, record: PlanRecord): PlanDraft {
    const members: MemberDraft[] = record.members.map((member) => {
      const work = this.work.getWorkById(project.id, member.work_id);
      const criteria: NormalizedCriterion[] = record.acceptance_criteria
        .filter((criterion) => criterion.work_id === member.work_id)
        .map((criterion) => ({
          key: criterion.ac_key,
          ordinal: criterion.ordinal,
          text: criterion.text,
        }));
      return {
        work,
        role: member.role,
        gateProfile: member.gate_profile,
        criteria,
        coverage: [],
        dependencies: new Map(),
      };
    });
    const dependencies: DependencyDraft[] = record.dependencies.map((dependency) => ({
      work: this.work.getWorkById(project.id, dependency.work_id),
      target: dependency.target_issue_number,
      source: dependency.source,
      targetRole: dependency.target_role,
      targetWorkId: dependency.target_work_id,
      targetRevisionId: dependency.target_revision_id,
    }));
    return {
      project,
      kind: record.kind,
      root: this.work.getWorkById(project.id, record.root_work_id),
      members,
      dependencies,
      coverage: record.coverage,
      holds: record.holds,
      evidenceMembers: [],
      deliveryBranch: record.delivery_branch,
      integrationBranch: record.integration_branch,
      budgets: record.manifest?.budgets ?? { child_max_laps: 3, final_max_laps: 3 },
      graph: { graph_hash: record.graph_hash },
      graphHash: record.graph_hash,
    };
  }

  private insertDecision(input: {
    planId: string;
    sequence: number;
    action: "import" | "approve" | "revoke";
    outcome: "admitted" | "held" | "revoked";
    actor: string;
    source: "import_authorization" | "operator";
    reason: string;
    manifestId: string | null;
    holds: PlanHold[];
    evidence: string;
    recordedAt: number;
  }): void {
    const evidence = mergeEvidence(input.evidence, input.holds);
    this.db
      .prepare(
        `INSERT INTO plan_decisions
           (id, plan_id, sequence, action, outcome, actor, source, reason,
            manifest_id, evidence, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `dec_${randomUUID()}`,
        input.planId,
        input.sequence,
        input.action,
        input.outcome,
        input.actor,
        input.source,
        input.reason,
        input.manifestId,
        evidence,
        input.recordedAt,
      );
  }

  private dynamicDependencyHolds(
    project: ProjectRow,
    dependencies: DependencyDraft[],
    targetRef: string,
  ): PlanHold[] {
    const verified = readVerifiedBranchIntegrations({
      db: this.db,
      projectId: project.id,
      root: project.checkout_path,
      integrationRef: targetRef,
    });
    const holds: PlanHold[] = [];
    for (const dependency of dependencies) {
      if (dependency.targetRole === "internal") continue;
      const live = this.work.getWorkByIssue(project.id, dependency.target);
      if (!live) {
        holds.push(
          hold(
            "dependency_integration_unverified",
            `Prerequisite #${dependency.target} is known externally but has no local work or verified integration`,
            { severity: "conditional" },
          ),
        );
        continue;
      }
      if (verified.has(dependency.target)) continue;
      holds.push(
        hold(
          "dependency_pending_integration",
          `Prerequisite #${dependency.target} (${live.id}) is known locally and queued for verified integration; no re-triage required`,
          { severity: "conditional", member: live },
        ),
      );
    }
    return holds;
  }

  private currentHolds(project: ProjectRow, planId: string): PlanHold[] {
    const record = this.recordById(project.id, planId);
    const dependencies: DependencyDraft[] = record.dependencies.map((dependency) => ({
      work: this.work.getWorkById(project.id, dependency.work_id),
      target: dependency.target_issue_number,
      source: dependency.source,
      targetRole: dependency.target_role,
      targetWorkId: dependency.target_work_id,
      targetRevisionId: dependency.target_revision_id,
    }));
    return dedupeHolds([
      ...this.storedHolds(planId),
      ...this.dynamicDependencyHolds(
        project,
        dependencies,
        record.integration_branch ?? record.delivery_branch,
      ),
    ]);
  }

  private storedHolds(planId: string): PlanHold[] {
    const rows = this.db
      .prepare(
        `SELECT member_work_id, issue_number, code, severity, detail
         FROM plan_holds WHERE plan_id = ? ORDER BY created_at ASC, id ASC`,
      )
      .all(planId) as Array<{
      member_work_id: string | null;
      issue_number: number | null;
      code: string;
      severity: "blocking" | "conditional";
      detail: string;
    }>;
    return rows.map((row) => ({
      code: row.code,
      severity: row.severity,
      member_work_id: row.member_work_id,
      issue_number: row.issue_number,
      detail: row.detail,
    }));
  }

  private recordById(projectId: string, planId: string): PlanRecord {
    const row = this.db
      .prepare("SELECT * FROM plans WHERE id = ? AND project_id = ?")
      .get(planId, projectId) as unknown as PlanRow | undefined;
    if (!row) throw new PlanError("plan_not_found", `Plan ${planId} not found`);
    return this.record(row);
  }

  private record(row: PlanRow): PlanRecord {
    const project = this.project(row.project_id);
    const members = this.readMembers(row.id);
    const acceptanceCriteria = this.readCriteria(row.id);
    const storedDependencies = this.readDependencies(row.id);
    const coverage = this.readCoverage(row.id);
    const decisions = this.readDecisions(row.id);
    const latest = decisions.at(-1);
    const authority = latest?.outcome ?? "held";
    const everAdmitted = decisions.some((decision) => decision.outcome === "admitted");
    const manifest = everAdmitted ? this.readManifest(row.id) : null;
    const dynamicDependencies: DependencyDraft[] = storedDependencies.map((dependency) => ({
      work: this.work.getWorkById(project.id, dependency.work_id),
      target: dependency.target_issue_number,
      source: dependency.source,
      targetRole: dependency.target_role,
      targetWorkId: dependency.target_work_id,
      targetRevisionId: dependency.target_revision_id,
    }));
    const stored = this.storedHolds(row.id);
    const holds = dedupeHolds([
      ...stored.filter((item) => authority === "held" || !APPROVABLE_HOLDS.has(item.code)),
      ...this.dynamicDependencyHolds(
        project,
        dynamicDependencies,
        row.integration_branch ?? row.delivery_branch,
      ),
    ]);
    const acceptedRevision: PlanAcceptedRevision | null = manifest
      ? {
          work_id: manifest.root.work_id,
          revision_id: manifest.root.revision_id,
          revision_number: manifest.root.revision_number,
          content_hash: manifest.root.content_hash,
        }
      : null;
    return planRecordSchema.parse({
      id: row.id,
      project_id: row.project_id,
      kind: row.kind,
      root_work_id: row.root_work_id,
      root_revision_id: row.root_revision_id,
      graph_hash: row.graph_hash,
      delivery_branch: row.delivery_branch,
      integration_branch: row.integration_branch,
      created_at: row.created_at,
      updated_at: latest?.recorded_at ?? row.updated_at,
      members,
      acceptance_criteria: acceptanceCriteria,
      dependencies: storedDependencies,
      coverage,
      decisions,
      authority,
      holds,
      dispatchable: authority === "admitted" && holds.length === 0,
      accepted_revision: acceptedRevision,
      manifest,
    });
  }

  private readMembers(planId: string): PlanMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.work_id, m.revision_id, m.role, m.gate_profile, m.issue_number,
                r.revision_number, r.content_hash, r.source_title, r.source_state
         FROM plan_members m
         JOIN work_revisions r ON r.id = m.revision_id
         WHERE m.plan_id = ? ORDER BY m.issue_number ASC`,
      )
      .all(planId) as Array<{
      work_id: string;
      revision_id: string;
      role: PlanMemberRole;
      gate_profile: PlanGateProfile;
      issue_number: number;
      revision_number: number;
      content_hash: string;
      source_title: string;
      source_state: "OPEN" | "CLOSED";
    }>;
    return rows.map((row) => ({
      work_id: row.work_id,
      revision_id: row.revision_id,
      revision_number: row.revision_number,
      issue_number: row.issue_number,
      content_hash: row.content_hash,
      title: row.source_title,
      source_state: row.source_state,
      role: row.role,
      gate_profile: row.gate_profile,
    }));
  }

  private readCriteria(planId: string): PlanAcceptanceCriterion[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.work_id, c.revision_id, c.ac_key, c.ordinal, c.text, m.issue_number
         FROM plan_acceptance_criteria c
         JOIN plan_members m ON m.plan_id = c.plan_id AND m.work_id = c.work_id
         WHERE c.plan_id = ? ORDER BY m.issue_number ASC, c.ordinal ASC`,
      )
      .all(planId) as Array<{
      id: string;
      work_id: string;
      revision_id: string;
      ac_key: string;
      ordinal: number;
      text: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      work_id: row.work_id,
      revision_id: row.revision_id,
      ac_key: row.ac_key,
      ordinal: row.ordinal,
      text: row.text,
    }));
  }

  private readDependencies(planId: string): PlanDependency[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.work_id, d.revision_id, d.target_issue_number, d.source,
                d.target_role, d.target_work_id, d.target_revision_id, m.issue_number
         FROM plan_dependencies d
         JOIN plan_members m ON m.plan_id = d.plan_id AND m.work_id = d.work_id
         WHERE d.plan_id = ? ORDER BY m.issue_number ASC, d.target_issue_number ASC`,
      )
      .all(planId) as Array<{
      id: string;
      work_id: string;
      revision_id: string;
      target_issue_number: number;
      source: PlanDependencySource;
      target_role: PlanDependencyTarget;
      target_work_id: string | null;
      target_revision_id: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      work_id: row.work_id,
      revision_id: row.revision_id,
      target_issue_number: row.target_issue_number,
      source: row.source,
      target_role: row.target_role,
      target_work_id: row.target_work_id,
      target_revision_id: row.target_revision_id,
    }));
  }

  private readCoverage(planId: string): PlanCoverage[] {
    const rows = this.db
      .prepare(
        `SELECT c.parent_ac_key, c.child_work_id, c.note, m.issue_number
         FROM plan_coverage c
         JOIN plan_members m ON m.plan_id = c.plan_id AND m.work_id = c.child_work_id
         WHERE c.plan_id = ?`,
      )
      .all(planId) as Array<{
      parent_ac_key: string;
      child_work_id: string;
      note: string | null;
      issue_number: number;
    }>;
    return rows
      .sort((left, right) => {
        const key = acKeySort(left.parent_ac_key, right.parent_ac_key);
        return key !== 0 ? key : left.issue_number - right.issue_number;
      })
      .map((row) => ({
        parent_ac_key: row.parent_ac_key,
        child_work_id: row.child_work_id,
        note: row.note,
      }));
  }

  private readDecisions(planId: string): PlanDecision[] {
    const rows = this.db
      .prepare(
        `SELECT id, sequence, action, outcome, actor, source, reason, manifest_id,
                evidence, recorded_at
         FROM plan_decisions WHERE plan_id = ? ORDER BY sequence ASC`,
      )
      .all(planId) as Array<{
      id: string;
      sequence: number;
      action: "import" | "approve" | "revoke";
      outcome: "admitted" | "held" | "revoked";
      actor: string;
      source: "import_authorization" | "operator";
      reason: string | null;
      manifest_id: string | null;
      evidence: string;
      recorded_at: number;
    }>;
    return rows.map((row) => {
      const evidence = JSON.parse(row.evidence) as { holds?: PlanHold[] };
      return {
        id: row.id,
        sequence: row.sequence,
        action: row.action,
        outcome: row.outcome,
        actor: row.actor,
        source: row.source,
        reason: row.reason,
        manifest_id: row.manifest_id,
        recorded_at: row.recorded_at,
        holds: Array.isArray(evidence.holds) ? evidence.holds : [],
      };
    });
  }

  private readManifest(planId: string): PlanManifest | null {
    const row = this.db
      .prepare(
        "SELECT manifest FROM plan_manifests WHERE plan_id = ? ORDER BY created_at ASC LIMIT 1",
      )
      .get(planId) as { manifest: string } | undefined;
    return row ? (JSON.parse(row.manifest) as PlanManifest) : null;
  }

  private summary(record: PlanRecord): PlanSummary {
    const root = record.members.find((member) => member.work_id === record.root_work_id);
    return {
      id: record.id,
      project_id: record.project_id,
      kind: record.kind,
      root_work_id: record.root_work_id,
      root_issue_number: root?.issue_number ?? 0,
      root_title: root?.title ?? "",
      graph_hash: record.graph_hash,
      authority: record.authority,
      member_count: record.members.length,
      ticket_count: record.members.filter((member) => member.role === "ticket").length,
      hold_count: record.holds.length,
      accepted_revision_id: record.accepted_revision?.revision_id ?? null,
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
  }
}

function addDependency(
  dependencies: Map<number, Set<"textual" | "native">>,
  target: number,
  kind: "textual" | "native",
): void {
  if (!Number.isSafeInteger(target) || target <= 0) return;
  const existing = dependencies.get(target) ?? new Set<"textual" | "native">();
  existing.add(kind);
  dependencies.set(target, existing);
}

function dedupeHolds(holds: PlanHold[]): PlanHold[] {
  const seen = new Set<string>();
  const result: PlanHold[] = [];
  for (const item of holds) {
    const identity = `${item.code}:${item.member_work_id ?? ""}:${item.issue_number ?? ""}:${item.detail}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(item);
  }
  return result;
}

function acKeySort(left: string, right: string): number {
  const leftNumber = Number.parseInt(left.replace(/^AC/i, ""), 10);
  const rightNumber = Number.parseInt(right.replace(/^AC/i, ""), 10);
  return leftNumber - rightNumber;
}

function mergeEvidence(raw: string, holds: PlanHold[]): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return JSON.stringify({ ...parsed, holds });
  } catch {
    return JSON.stringify({ holds });
  }
}
