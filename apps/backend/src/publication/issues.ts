import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  planDependencySourceSchema,
  type DraftPlan,
  type DraftPublication,
  type DraftPublicationIntent,
  type DraftPublicationMember,
  type DraftPublicationRelationship,
  type DraftRecord,
  type PlanAuthority,
  type PlanHold,
  type PlanMemberRole,
  type PlanRecord,
} from "@animus/contracts/operator";
import { validateCanonicalIssueBody } from "@animus/contracts/ticket";
import { ReportSanitizer } from "@animus/contracts/sanitizer";
import type { DraftService } from "../draft";
import type { ForgeAdapter, ForgeIssue } from "../registry/forge";
import { assertIssueForge } from "../registry/forge";
import type { PlanService } from "../plans";
import { WorkService } from "../work";
import { publicationMarker, sanitizePublicationText } from "./service";

export type DraftPublicationErrorCode =
  | "draft_publication_not_found"
  | "draft_publication_project_not_found"
  | "draft_publication_not_approved"
  | "draft_publication_not_publishable"
  | "draft_publication_stale_revision"
  | "draft_publication_draft_changed"
  | "draft_publication_transport_unsupported"
  | "draft_publication_invalid_plan"
  | "draft_publication_source_missing"
  | "draft_publication_failed";

export class DraftPublicationError extends Error {
  constructor(
    public readonly code: DraftPublicationErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DraftPublicationError";
  }
}

interface ProjectRow {
  id: string;
  repo_id: number;
  repo_name: string;
  checkout_path: string;
}

interface PublicationRow {
  id: string;
  project_id: string;
  draft_id: string;
  revision_id: string;
  revision_number: number;
  plan_hash: string;
  kind: "standalone" | "spec";
  state: DraftPublication["state"];
  source_issue_number: number;
  spec_issue_number: number | null;
  integration_branch: string | null;
  delivery_branch: string;
  plan_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface MemberRow {
  id: string;
  publication_id: string;
  project_id: string;
  node_key: string;
  role: PlanMemberRole;
  ordinal: number;
  title: string;
  body: string;
  labels_json: string;
  issue_number: number | null;
  work_id: string | null;
  state: DraftPublicationMember["state"];
  created_at: number;
  updated_at: number;
}

interface RelationshipRow {
  id: string;
  publication_id: string;
  project_id: string;
  kind: "parent_child" | "dependency";
  from_node_key: string;
  to_node_key: string;
  from_issue_number: number | null;
  to_issue_number: number | null;
  source: "textual" | "native" | "textual+native";
  state: DraftPublicationRelationship["state"];
  detail: string | null;
  created_at: number;
  updated_at: number;
}

interface IntentRow {
  id: string;
  target_id: string | null;
  project_id: string;
  draft_publication_id: string | null;
  operation_key: string;
  kind: "create_issue" | "create_issue_relationship" | "link_source_issue";
  resource_kind: "issue" | "relationship";
  state: "queued" | "attempting" | "accepted" | "failed" | "unknown";
  request_json: string;
  attempts: number;
  remote_object_id: string | null;
  remote_url: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

type SpecPlan = Extract<DraftPlan, { kind: "spec" }>;
type MemberPlan = Extract<DraftPlan, { kind: "standalone" | "spec" }>;
type ChildPlan = SpecPlan["children"][number];

export interface DraftPublicationServiceOptions {
  clock?: () => number;
  sanitizer?: ReportSanitizer;
}

const LABEL_META: Record<string, { color: string; description: string }> = {
  spec: { color: "5319e7", description: "Parent specification planning record" },
  "ready-for-human": { color: "fbca04", description: "Requires human implementation" },
  "ready-for-agent": { color: "0e8a16", description: "Eligible for agent admission" },
};

function labelName(value: string | { name?: string }): string {
  if (typeof value === "string") return value;
  return value?.name ?? "";
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))];
}

/** Deterministic canonical contract body generated from the approved plan fields. */
function canonicalBodyOf(plan: MemberPlan | ChildPlan): string {
  const criteria = plan.acceptance_criteria
    .map((criterion) => `- [ ] ${criterion.id}: ${criterion.description}`)
    .join("\n");
  const invariants =
    plan.invariants.length > 0
      ? plan.invariants.map((invariant) => `- ${invariant}`).join("\n")
      : "- No additional invariants.";
  const verification =
    plan.verification_requirements.length > 0
      ? plan.verification_requirements.map((requirement) => `- ${requirement}`).join("\n")
      : "- Targeted repository verification.";
  return [
    "## Source and problem",
    "",
    plan.scope,
    "",
    "## Outcome",
    "",
    plan.outcome,
    "",
    "## Invariants",
    "",
    invariants,
    "",
    "## Acceptance criteria",
    "",
    criteria || "- [ ] AC1: The approved outcome is observable.",
    "",
    "## Boundary",
    "",
    `- **Touchpoints**: ${plan.boundary.touchpoints}`,
    `- **Known callers**: ${plan.boundary.known_callers}`,
    `- **Test seam**: ${plan.boundary.test_seam}`,
    `- **Exclusions**: ${plan.boundary.exclusions}`,
    "",
    "## Verification",
    "",
    verification,
  ].join("\n");
}

function childOf(plan: SpecPlan, nodeKey: string): ChildPlan {
  const childId = nodeKey.startsWith("child:") ? nodeKey.slice("child:".length) : "";
  const child = plan.children.find((entry) => entry.id === childId);
  if (!child) {
    throw new DraftPublicationError(
      "draft_publication_invalid_plan",
      `Approved plan has no child draft '${childId}'`,
    );
  }
  return child;
}

export class DraftPublicationService {
  private readonly clock: () => number;
  private readonly sanitizer: ReportSanitizer;
  private readonly work: WorkService;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: DatabaseSync,
    private readonly forge: ForgeAdapter,
    private readonly drafts: DraftService,
    private readonly plans: PlanService,
    options: DraftPublicationServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => Date.now());
    this.sanitizer = options.sanitizer ?? new ReportSanitizer();
    this.work = new WorkService(db);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  list(projectId: string): DraftPublication[] {
    this.project(projectId);
    const rows = this.db
      .prepare(
        "SELECT id FROM draft_publications WHERE project_id = ? ORDER BY created_at DESC, id DESC",
      )
      .all(projectId) as Array<{ id: string }>;
    return rows.map((row) => this.record(projectId, row.id));
  }

  get(projectId: string, publicationId: string): DraftPublication {
    return this.record(projectId, publicationId);
  }

  getByDraft(projectId: string, draftId: string): DraftPublication | null {
    this.project(projectId);
    const row = this.db
      .prepare(
        `SELECT id FROM draft_publications
          WHERE project_id = ? AND draft_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(projectId, draftId) as { id: string } | undefined;
    return row ? this.record(projectId, row.id) : null;
  }

  // -------------------------------------------------------------------------
  // Publication
  // -------------------------------------------------------------------------

  async publishDraft(projectId: string, draftId: string): Promise<DraftPublication> {
    const draft = this.loadDraft(projectId, draftId);
    const existing = this.findByRevision(projectId, draft.id, draft.latest_revision.id);
    const publication = existing
      ? this.loadPublication(projectId, existing.id)
      : this.prepare(projectId, draft);
    return this.publish(projectId, publication.id);
  }

  async publish(projectId: string, publicationId: string): Promise<DraftPublication> {
    return this.serialize(publicationId, async () => {
      const publication = this.loadPublication(projectId, publicationId);
      const project = this.project(projectId);

      if (!this.isAdmitted(publication) && !this.allMembersResolved(publication.id)) {
        this.assertBoundRevision(publication);
      }

      const members = this.memberRows(publication.id);
      if (members.some((member) => member.issue_number === null)) {
        await this.ensureLabels(project.repo_name, ["spec", "ready-for-human", "ready-for-agent"]);
      }

      for (const member of members) {
        if (member.issue_number !== null) continue;
        const outcome = await this.executeCreateIssue(publication, member);
        if (outcome !== "created") {
          this.refresh(publication.id);
          return this.record(projectId, publication.id);
        }
      }

      const resolved = this.loadPublication(projectId, publicationId);
      if (!this.allMembersResolved(resolved.id)) {
        this.refresh(resolved.id);
        return this.record(projectId, resolved.id);
      }

      for (const relationship of this.relationshipRows(resolved.id)) {
        const outcome = await this.executeRelationship(resolved, relationship);
        if (outcome !== "ok") {
          this.refresh(resolved.id);
          return this.record(projectId, resolved.id);
        }
      }

      await this.executeLinkSource(resolved);
      await this.admit(resolved);
      this.refresh(resolved.id);
      return this.record(projectId, resolved.id);
    });
  }

  async reconcile(projectId: string, publicationId: string): Promise<DraftPublication> {
    return this.publish(projectId, publicationId);
  }

  async reconcileAll(projectId: string): Promise<DraftPublication[]> {
    this.project(projectId);
    const rows = this.db
      .prepare(
        "SELECT id FROM draft_publications WHERE project_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(projectId) as Array<{ id: string }>;
    const results: DraftPublication[] = [];
    for (const row of rows) results.push(await this.publish(projectId, row.id));
    return results;
  }

  // -------------------------------------------------------------------------
  // Preparation
  // -------------------------------------------------------------------------

  private findByRevision(
    projectId: string,
    draftId: string,
    revisionId: string,
  ): PublicationRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM draft_publications
          WHERE project_id = ? AND draft_id = ? AND revision_id = ?`,
      )
      .get(projectId, draftId, revisionId) as unknown as PublicationRow | undefined;
    return row ?? null;
  }

  private prepare(projectId: string, draft: DraftRecord): PublicationRow {
    this.assertPublishable(draft);
    const plan = draft.latest_revision.plan;
    if (plan.kind === "clarification") {
      throw new DraftPublicationError(
        "draft_publication_not_publishable",
        "A clarification draft has no approved contract to publish",
      );
    }
    this.project(projectId);
    const now = this.clock();
    const publicationId = `dpub_${randomUUID()}`;

    const members: Array<{
      nodeKey: string;
      role: PlanMemberRole;
      ordinal: number;
      title: string;
      body: string;
      labels: string[];
    }> = [];
    if (plan.kind === "standalone") {
      members.push({
        nodeKey: "root",
        role: "ticket",
        ordinal: 0,
        title: plan.title,
        body: canonicalBodyOf(plan),
        labels: ["ready-for-agent"],
      });
    } else {
      members.push({
        nodeKey: "root",
        role: "spec",
        ordinal: 0,
        title: plan.title,
        body: canonicalBodyOf(plan),
        labels: ["spec", "ready-for-human"],
      });
      plan.children.forEach((child, index) => {
        members.push({
          nodeKey: `child:${child.id}`,
          role: "ticket",
          ordinal: index + 1,
          title: child.title,
          body: canonicalBodyOf(child),
          labels: ["ready-for-agent"],
        });
      });
    }

    const relationships: Array<{
      kind: "parent_child" | "dependency";
      fromNodeKey: string;
      toNodeKey: string;
    }> = [];
    if (plan.kind === "spec") {
      for (const child of plan.children) {
        relationships.push({
          kind: "parent_child",
          fromNodeKey: `child:${child.id}`,
          toNodeKey: "root",
        });
        for (const index of child.depends_on_indices) {
          const dependency = plan.children[index];
          if (!dependency) {
            throw new DraftPublicationError(
              "draft_publication_invalid_plan",
              `Child '${child.id}' depends on missing child index ${index}`,
            );
          }
          relationships.push({
            kind: "dependency",
            fromNodeKey: `child:${child.id}`,
            toNodeKey: `child:${dependency.id}`,
          });
        }
      }
    }

    const nativeParentChild = typeof this.forge.addSubIssue === "function";
    const nativeDependency = typeof this.forge.addIssueDependency === "function";

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const raced = this.findByRevision(projectId, draft.id, draft.latest_revision.id);
      if (raced) {
        this.db.exec("COMMIT;");
        return raced;
      }
      this.db
        .prepare(
          `INSERT INTO draft_publications
             (id, project_id, draft_id, revision_id, revision_number, plan_hash, kind, state,
              source_issue_number, spec_issue_number, integration_branch, delivery_branch,
              plan_id, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, 'main', NULL, NULL, ?, ?)`,
        )
        .run(
          publicationId,
          projectId,
          draft.id,
          draft.latest_revision.id,
          draft.latest_revision.revision_number,
          draft.latest_revision.plan_hash,
          plan.kind,
          draft.source_provenance.issue_number,
          now,
          now,
        );

      for (const member of members) {
        this.db
          .prepare(
            `INSERT INTO draft_publication_members
               (id, publication_id, project_id, node_key, role, ordinal, title, body,
                labels_json, issue_number, work_id, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)`,
          )
          .run(
            `dpm_${randomUUID()}`,
            publicationId,
            projectId,
            member.nodeKey,
            member.role,
            member.ordinal,
            member.title,
            member.body,
            JSON.stringify(member.labels),
            now,
            now,
          );
        this.insertIntent({
          publicationId,
          projectId,
          operationKey: `create_issue:${publicationId}:${member.nodeKey}`,
          kind: "create_issue",
          resourceKind: "issue",
          request: { nodeKey: member.nodeKey },
          now,
        });
      }

      for (const relationship of relationships) {
        const nativeSupported =
          relationship.kind === "parent_child" ? nativeParentChild : nativeDependency;
        const operationKey = `rel:${publicationId}:${relationship.kind}:${relationship.fromNodeKey}:${relationship.toNodeKey}`;
        this.db
          .prepare(
            `INSERT INTO draft_publication_relationships
               (id, publication_id, project_id, kind, from_node_key, to_node_key,
                from_issue_number, to_issue_number, source, state, detail, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'textual', ?, ?, ?, ?)`,
          )
          .run(
            `dprel_${randomUUID()}`,
            publicationId,
            projectId,
            relationship.kind,
            relationship.fromNodeKey,
            relationship.toNodeKey,
            nativeSupported ? "pending" : "fallback_textual",
            nativeSupported
              ? null
              : "Native GitHub relationship is unsupported; the canonical textual reference is authoritative.",
            now,
            now,
          );
        if (nativeSupported) {
          this.insertIntent({
            publicationId,
            projectId,
            operationKey,
            kind: "create_issue_relationship",
            resourceKind: "relationship",
            request: {
              kind: relationship.kind,
              fromNodeKey: relationship.fromNodeKey,
              toNodeKey: relationship.toNodeKey,
            },
            now,
          });
        }
      }

      this.insertIntent({
        publicationId,
        projectId,
        operationKey: `link_source:${publicationId}`,
        kind: "link_source_issue",
        resourceKind: "issue",
        request: { sourceIssueNumber: draft.source_provenance.issue_number },
        now,
      });

      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }

    return this.loadPublication(projectId, publicationId);
  }

  private insertIntent(input: {
    publicationId: string;
    projectId: string;
    operationKey: string;
    kind: IntentRow["kind"];
    resourceKind: IntentRow["resource_kind"];
    request: Record<string, unknown>;
    now: number;
  }): void {
    const existing = this.db
      .prepare(
        "SELECT 1 AS present FROM publication_intents WHERE draft_publication_id = ? AND operation_key = ?",
      )
      .get(input.publicationId, input.operationKey);
    if (existing) return;
    this.db
      .prepare(
        `INSERT INTO publication_intents
           (id, target_id, project_id, draft_publication_id, operation_key, kind,
            resource_kind, state, request_json, attempts, remote_object_id, remote_url,
            last_error, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        `int_${randomUUID()}`,
        input.projectId,
        input.publicationId,
        input.operationKey,
        input.kind,
        input.resourceKind,
        JSON.stringify(input.request),
        input.now,
        input.now,
      );
  }

  private assertPublishable(draft: DraftRecord): void {
    if (draft.latest_revision.kind === "clarification") {
      throw new DraftPublicationError(
        "draft_publication_not_publishable",
        "A clarification draft cannot be published",
      );
    }
    if (draft.status === "rejected" || draft.status === "changes_requested") {
      throw new DraftPublicationError(
        "draft_publication_not_approved",
        `Draft ${draft.id} is ${draft.status}; only an approved revision may publish`,
      );
    }
    if (
      !draft.authorization.approved ||
      !draft.authorization.can_publish ||
      draft.authorization.approved_revision_id !== draft.latest_revision.id
    ) {
      throw new DraftPublicationError(
        "draft_publication_not_approved",
        "Publish only an operator-approved current draft revision",
      );
    }
  }

  /**
   * Publication is fenced to the exact approved revision. A later revision, or a
   * revoked approval, stops new issue creation while leaving already published
   * nodes visible and nonexecutable for reconciliation.
   */
  private assertBoundRevision(publication: PublicationRow): void {
    let draft: DraftRecord;
    try {
      draft = this.drafts.get(publication.project_id, publication.draft_id);
    } catch {
      throw new DraftPublicationError(
        "draft_publication_draft_changed",
        "The bound draft is no longer readable",
      );
    }
    if (draft.latest_revision.id !== publication.revision_id) {
      throw new DraftPublicationError(
        "draft_publication_stale_revision",
        "The draft has a newer revision; the approved publication is fenced to its original revision",
      );
    }
    if (
      !draft.authorization.approved ||
      draft.authorization.approved_revision_id !== publication.revision_id
    ) {
      throw new DraftPublicationError(
        "draft_publication_not_approved",
        "The approved revision was superseded or revoked; reconcile requires a new approval",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Issue creation
  // -------------------------------------------------------------------------

  private async executeCreateIssue(
    publication: PublicationRow,
    member: MemberRow,
  ): Promise<"created" | "blocked" | "failed"> {
    const intent = this.intentFor(
      publication.id,
      `create_issue:${publication.id}:${member.node_key}`,
    );
    if (!intent) {
      throw new DraftPublicationError(
        "draft_publication_invalid_plan",
        `Missing durable create-issue intent for ${member.node_key}`,
      );
    }
    if (member.issue_number !== null) {
      if (intent.state !== "accepted") this.acceptIntent(intent, String(member.issue_number));
      return "created";
    }
    const rendered = this.renderMember(publication, member);
    if (!rendered) return "blocked";
    const project = this.project(publication.project_id);
    const marker = publicationMarker(intent.operation_key);

    if (intent.state === "attempting") this.markIntentUnknown(intent);

    // Reconcile an ambiguous prior attempt by exact correlation before any retry.
    let recovered: ForgeIssue | null = null;
    try {
      recovered = await this.findIssueByMarker(project.repo_name, marker);
    } catch {
      if (intent.state === "unknown") return "failed";
    }
    if (recovered) return this.bindCreated(publication, member, intent, recovered);

    const current = this.loadIntent(intent.id);
    if (!this.claimIntent(current)) return "blocked";
    try {
      const issue = await this.createIssue(project, rendered);
      return this.bindCreated(publication, member, current, issue);
    } catch (error) {
      let after: ForgeIssue | null = null;
      try {
        after = await this.findIssueByMarker(project.repo_name, marker);
      } catch {}
      if (after) return this.bindCreated(publication, member, current, after);
      this.failIntent(current, error);
      return "failed";
    }
  }

  private renderMember(
    publication: PublicationRow,
    member: MemberRow,
  ): { title: string; body: string; labels: string[] } | null {
    const plan = this.loadPlan(publication.revision_id);
    const memberPlan: MemberPlan | ChildPlan =
      member.node_key === "root"
        ? plan
        : plan.kind === "spec"
          ? childOf(plan, member.node_key)
          : (() => {
              throw new DraftPublicationError(
                "draft_publication_invalid_plan",
                `Standalone plan has no child node '${member.node_key}'`,
              );
            })();

    const rootMembers = this.memberRows(publication.id).filter((row) => row.node_key === "root");
    const root = rootMembers[0];
    const membersByKey = new Map(this.memberRows(publication.id).map((row) => [row.node_key, row]));

    const header: string[] = [];
    if (member.node_key !== "root") {
      if (!root?.issue_number) return null;
      header.push(`Part of #${root.issue_number}`);
      if ("covers_parent_ac_ids" in memberPlan && memberPlan.covers_parent_ac_ids.length > 0) {
        header.push(`Source acceptance coverage: ${memberPlan.covers_parent_ac_ids.join(", ")}`);
      }
    } else {
      header.push(`Refined request: #${publication.source_issue_number}`);
    }

    const dependencyNumbers: number[] = [];
    if (member.node_key === "root") {
      dependencyNumbers.push(...uniqueNumbers(plan.depends_on ?? []));
    } else if ("depends_on_indices" in memberPlan) {
      if (plan.kind !== "spec") return null;
      for (const index of memberPlan.depends_on_indices) {
        const dependency = plan.children[index];
        if (!dependency) return null;
        const dependencyMember = membersByKey.get(`child:${dependency.id}`);
        if (!dependencyMember?.issue_number) return null;
        dependencyNumbers.push(dependencyMember.issue_number);
      }
      dependencyNumbers.push(...uniqueNumbers(memberPlan.depends_on ?? []));
    }

    const dependsLine =
      dependencyNumbers.length > 0
        ? `Depends on: ${uniqueNumbers(dependencyNumbers)
            .map((number) => `#${number}`)
            .join(", ")}`
        : "Depends on: None";
    const marker = publicationMarker(`create_issue:${publication.id}:${member.node_key}`);
    const body = this.sanitize(
      [...header, "", member.body, "", dependsLine, "", marker].join("\n"),
    );
    const canonical = validateCanonicalIssueBody(body);
    if (!canonical.valid) {
      throw new DraftPublicationError(
        "draft_publication_invalid_plan",
        `Published body for ${member.node_key} is not canonical: ${canonical.errors.join("; ")}`,
      );
    }
    return {
      title: this.sanitize(member.title),
      body,
      labels: JSON.parse(member.labels_json) as string[],
    };
  }

  private async createIssue(
    project: ProjectRow,
    rendered: { title: string; body: string; labels: string[] },
  ): Promise<ForgeIssue> {
    const forge = assertIssueForge(this.forge);
    const created = await forge.createIssue(project.repo_name, {
      title: rendered.title,
      body: rendered.body,
      labels: rendered.labels,
    });
    const readBack = await forge.getIssue(project.repo_name, created.number);
    if (!readBack) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Created issue #${created.number} could not be read back`,
      );
    }
    this.assertIssueReadback(project.repo_name, readBack, rendered);
    return readBack;
  }

  private assertIssueReadback(
    repo: string,
    issue: ForgeIssue,
    expected: { title: string; body: string; labels: string[] },
  ): void {
    if (issue.title !== expected.title) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Issue #${issue.number} in ${repo} has title '${issue.title}', not '${expected.title}'`,
      );
    }
    const body = issue.body ?? "";
    if (!body.includes(publicationMarkerFromBody(expected.body))) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Issue #${issue.number} in ${repo} did not persist the publication marker`,
      );
    }
    for (const heading of [
      "## Source and problem",
      "## Outcome",
      "## Invariants",
      "## Acceptance criteria",
      "## Boundary",
      "## Verification",
    ]) {
      if (!body.includes(heading)) {
        throw new DraftPublicationError(
          "draft_publication_failed",
          `Issue #${issue.number} is missing '${heading}' on read-back`,
        );
      }
    }
    if (!/^Depends on:\s*(?:#[0-9]+(?:\s*,\s*#[0-9]+)*|None)\s*$/m.test(body)) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Issue #${issue.number} has no canonical Depends on line on read-back`,
      );
    }
    if (expected.body.includes("Part of #") && !/^Part of #\d+\s*$/m.test(body)) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Issue #${issue.number} lost its Part of parent reference on read-back`,
      );
    }
    const labels = new Set((issue.labels ?? []).map(labelName).map((name) => name.toLowerCase()));
    for (const label of expected.labels) {
      if (!labels.has(label.toLowerCase())) {
        throw new DraftPublicationError(
          "draft_publication_failed",
          `Issue #${issue.number} is missing required label '${label}' on read-back`,
        );
      }
    }
  }

  private bindCreated(
    publication: PublicationRow,
    member: MemberRow,
    intent: IntentRow,
    issue: ForgeIssue,
  ): "created" {
    const rendered = this.renderMember(publication, member);
    if (!rendered) {
      throw new DraftPublicationError(
        "draft_publication_invalid_plan",
        `Cannot verify issue for unresolved member ${member.node_key}`,
      );
    }
    const project = this.project(publication.project_id);
    this.assertIssueReadback(project.repo_name, issue, rendered);

    const now = this.clock();
    let workId: string | null = null;
    try {
      const work = this.work.importIssue(
        { id: project.id, repo_id: project.repo_id, repo_name: project.repo_name },
        issue,
      );
      workId = work.id;
    } catch (error) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Confirmed issue #${issue.number} could not be bound to local work: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db
        .prepare(
          `UPDATE draft_publication_members
              SET issue_number = ?, work_id = ?, state = 'verified', updated_at = ?
            WHERE id = ?`,
        )
        .run(issue.number, workId, now, member.id);
      if (member.node_key === "root") {
        this.db
          .prepare(
            "UPDATE draft_publications SET spec_issue_number = CASE WHEN kind = 'spec' THEN ? ELSE spec_issue_number END, updated_at = ? WHERE id = ?",
          )
          .run(issue.number, now, publication.id);
      }
      this.db
        .prepare(
          `UPDATE draft_publication_relationships
              SET from_issue_number = ?, updated_at = ?
            WHERE publication_id = ? AND from_node_key = ? AND from_issue_number IS NULL`,
        )
        .run(issue.number, now, publication.id, member.node_key);
      this.db
        .prepare(
          `UPDATE draft_publication_relationships
              SET to_issue_number = ?, updated_at = ?
            WHERE publication_id = ? AND to_node_key = ? AND to_issue_number IS NULL`,
        )
        .run(issue.number, now, publication.id, member.node_key);
      this.db.exec("COMMIT;");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK;");
      } catch {}
      throw error;
    }
    this.acceptIntent(intent, String(issue.number));
    return "created";
  }

  private async findIssueByMarker(repo: string, marker: string): Promise<ForgeIssue | null> {
    const forge = assertIssueForge(this.forge);
    const issues = await forge.listIssues(repo, "ALL");
    return issues.find((issue) => (issue.body ?? "").includes(marker)) ?? null;
  }

  // -------------------------------------------------------------------------
  // Relationships
  // -------------------------------------------------------------------------

  private async executeRelationship(
    publication: PublicationRow,
    relationship: RelationshipRow,
  ): Promise<"ok" | "failed"> {
    if (relationship.state === "verified") return "ok";
    if (relationship.from_issue_number === null || relationship.to_issue_number === null) {
      return "failed";
    }
    const project = this.project(publication.project_id);

    // The canonical textual reference is always authoritative. Verify it on
    // read-back before any supplementary native edge is considered, including
    // the textual-only fallback when native relationships are unsupported.
    try {
      const child = await assertIssueForge(this.forge).getIssue(
        project.repo_name,
        relationship.from_issue_number,
      );
      if (!child) throw new Error("child issue is unreadable");
      const expected =
        relationship.kind === "parent_child"
          ? `Part of #${relationship.to_issue_number}`
          : `#${relationship.to_issue_number}`;
      if (relationship.kind === "parent_child" && !(child.body ?? "").includes(expected)) {
        throw new Error(`child #${child.number} is missing textual '${expected}'`);
      }
      if (relationship.kind === "dependency") {
        const line = (child.body ?? "").match(/^Depends on:\s*(.+)$/m)?.[1] ?? "";
        if (!line.includes(`#${relationship.to_issue_number}`)) {
          throw new Error(
            `child #${child.number} is missing textual '#${relationship.to_issue_number}' dependency`,
          );
        }
      }
    } catch (error) {
      this.db
        .prepare(
          "UPDATE draft_publication_relationships SET state = 'failed', detail = ?, updated_at = ? WHERE id = ?",
        )
        .run(error instanceof Error ? error.message : String(error), this.clock(), relationship.id);
      return "failed";
    }

    if (relationship.state === "fallback_textual") return "ok";

    const intent = this.intentFor(
      publication.id,
      `rel:${publication.id}:${relationship.kind}:${relationship.from_node_key}:${relationship.to_node_key}`,
    );
    if (!intent) {
      this.fallbackRelationship(
        relationship,
        "No native relationship intent is recorded; canonical textual reference verified.",
      );
      return "ok";
    }
    if (intent.state === "attempting") this.markIntentUnknown(intent);

    const nativeSupported =
      relationship.kind === "parent_child"
        ? typeof this.forge.addSubIssue === "function" &&
          typeof this.forge.getSubIssues === "function"
        : typeof this.forge.addIssueDependency === "function" &&
          typeof this.forge.getIssueDependencies === "function";
    if (!nativeSupported) {
      this.fallbackRelationship(
        relationship,
        "Native GitHub relationship is unsupported; canonical textual reference verified.",
      );
      this.acceptIntent(this.loadIntent(intent.id), null);
      return "ok";
    }

    if (intent.state === "unknown") {
      try {
        if (await this.nativeExists(project.repo_name, relationship)) {
          return this.verifyNative(relationship, intent);
        }
      } catch {
        return "failed";
      }
    }

    const current = this.loadIntent(intent.id);
    if (!this.claimIntent(current)) return "ok";
    try {
      if (relationship.kind === "parent_child") {
        await this.forge.addSubIssue!(
          project.repo_name,
          relationship.to_issue_number,
          relationship.from_issue_number,
        );
      } else {
        await this.forge.addIssueDependency!(
          project.repo_name,
          relationship.from_issue_number,
          relationship.to_issue_number,
        );
      }
      if (await this.nativeExists(project.repo_name, relationship)) {
        return this.verifyNative(relationship, current);
      }
      this.fallbackRelationship(
        relationship,
        "Native relationship was not observable on read-back; canonical textual reference verified.",
      );
      this.acceptIntent(current, null);
      return "ok";
    } catch (error) {
      try {
        if (await this.nativeExists(project.repo_name, relationship)) {
          return this.verifyNative(relationship, current);
        }
      } catch {
        this.failIntent(current, error);
        this.db
          .prepare(
            "UPDATE draft_publication_relationships SET state = 'unknown', detail = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            error instanceof Error ? error.message : String(error),
            this.clock(),
            relationship.id,
          );
        return "failed";
      }
      this.fallbackRelationship(
        relationship,
        `Native relationship failed (${
          error instanceof Error ? error.message : String(error)
        }); canonical textual reference verified.`,
      );
      this.acceptIntent(current, null);
      return "ok";
    }
  }

  private async nativeExists(repo: string, relationship: RelationshipRow): Promise<boolean> {
    if (relationship.from_issue_number === null || relationship.to_issue_number === null) {
      return false;
    }
    if (relationship.kind === "parent_child") {
      if (typeof this.forge.getSubIssues !== "function") return false;
      const children = await this.forge.getSubIssues(repo, relationship.to_issue_number);
      return children.includes(relationship.from_issue_number);
    }
    if (typeof this.forge.getIssueDependencies !== "function") return false;
    const dependencies = await this.forge.getIssueDependencies(
      repo,
      relationship.from_issue_number,
    );
    return dependencies.includes(relationship.to_issue_number);
  }

  private verifyNative(relationship: RelationshipRow, intent: IntentRow): "ok" {
    this.db
      .prepare(
        `UPDATE draft_publication_relationships
            SET state = 'verified', source = 'textual+native', detail = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(this.clock(), relationship.id);
    this.acceptIntent(
      intent,
      `${relationship.kind}:${relationship.from_node_key}:${relationship.to_node_key}`,
    );
    return "ok";
  }

  private fallbackRelationship(relationship: RelationshipRow, detail: string): void {
    this.db
      .prepare(
        `UPDATE draft_publication_relationships
            SET state = 'fallback_textual', source = 'textual', detail = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(detail, this.clock(), relationship.id);
  }

  // -------------------------------------------------------------------------
  // Source backlink
  // -------------------------------------------------------------------------

  private async executeLinkSource(publication: PublicationRow): Promise<void> {
    const intent = this.intentFor(publication.id, `link_source:${publication.id}`);
    if (!intent || intent.state === "accepted") return;
    const root = this.memberRows(publication.id).find((row) => row.node_key === "root");
    if (!root?.issue_number) return;
    const project = this.project(publication.project_id);
    const marker = publicationMarker(intent.operation_key);
    const body = this.sanitize(
      [
        `Refined contract: #${root.issue_number} (approved draft revision ${publication.revision_number}).`,
        "The original request remains the reporter's record; this link points to the executable contract.",
        "",
        marker,
      ].join("\n"),
    );

    if (intent.state === "attempting") this.markIntentUnknown(intent);
    if (intent.state === "unknown") {
      try {
        if (await this.commentExists(project.repo_name, publication.source_issue_number, marker)) {
          this.acceptIntent(this.loadIntent(intent.id), null);
          return;
        }
      } catch {
        return;
      }
    }
    const current = this.loadIntent(intent.id);
    if (!this.claimIntent(current)) return;
    try {
      if (typeof this.forge.createIssueComment !== "function") {
        throw new DraftPublicationError(
          "draft_publication_transport_unsupported",
          "Forge transport does not support source-request comments",
        );
      }
      const comment = await this.forge.createIssueComment(
        project.repo_name,
        publication.source_issue_number,
        body,
      );
      this.acceptIntent(current, comment.id ?? null);
    } catch (error) {
      try {
        if (await this.commentExists(project.repo_name, publication.source_issue_number, marker)) {
          this.acceptIntent(current, null);
          return;
        }
      } catch {}
      this.failIntent(current, error);
    }
  }

  private async commentExists(repo: string, issueNumber: number, marker: string): Promise<boolean> {
    const issue = await assertIssueForge(this.forge).getIssue(repo, issueNumber);
    return Boolean(issue?.comments?.some((comment) => (comment.body ?? "").includes(marker)));
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  private async admit(publication: PublicationRow): Promise<void> {
    if (publication.plan_id) {
      this.refresh(publication.id);
      return;
    }
    const root = this.memberRows(publication.id).find((row) => row.node_key === "root");
    if (!root?.issue_number) {
      this.fail(publication.id, "The root contract issue was not published");
      return;
    }
    try {
      const plan = await this.plans.importPlan(publication.project_id, {
        issue_number: root.issue_number,
        kind: publication.kind,
      });
      this.db
        .prepare(
          `UPDATE draft_publications
              SET plan_id = ?, integration_branch = ?, state = ?, last_error = NULL, updated_at = ?
            WHERE id = ?`,
        )
        .run(
          plan.id,
          plan.integration_branch,
          plan.authority === "admitted" ? "admitted" : "published",
          this.clock(),
          publication.id,
        );
    } catch (error) {
      this.fail(
        publication.id,
        `Plan admission failed after publication: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private isAdmitted(publication: PublicationRow): boolean {
    return publication.state === "admitted";
  }

  private allMembersResolved(publicationId: string): boolean {
    const members = this.memberRows(publicationId);
    return members.length > 0 && members.every((member) => member.issue_number !== null);
  }

  // -------------------------------------------------------------------------
  // Persistence helpers
  // -------------------------------------------------------------------------

  private loadDraft(projectId: string, draftId: string): DraftRecord {
    try {
      return this.drafts.get(projectId, draftId);
    } catch {
      throw new DraftPublicationError(
        "draft_publication_not_found",
        `Draft ${draftId} was not found for project ${projectId}`,
      );
    }
  }

  private project(projectId: string): ProjectRow {
    const row = this.db
      .prepare("SELECT id, repo_id, repo_name, checkout_path FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;
    if (!row) {
      throw new DraftPublicationError(
        "draft_publication_project_not_found",
        `Project ${projectId} not found`,
      );
    }
    return row;
  }

  private loadPublication(projectId: string, publicationId: string): PublicationRow {
    const row = this.db
      .prepare("SELECT * FROM draft_publications WHERE project_id = ? AND id = ?")
      .get(projectId, publicationId) as unknown as PublicationRow | undefined;
    if (!row) {
      throw new DraftPublicationError(
        "draft_publication_not_found",
        `Draft publication ${publicationId} not found`,
      );
    }
    return row;
  }

  private loadPlan(revisionId: string): MemberPlan {
    const row = this.db
      .prepare("SELECT plan_json FROM work_draft_revisions WHERE id = ?")
      .get(revisionId) as { plan_json: string } | undefined;
    if (!row) {
      throw new DraftPublicationError(
        "draft_publication_invalid_plan",
        "Approved draft revision is unreadable",
      );
    }
    const plan = JSON.parse(row.plan_json) as DraftPlan;
    if (plan.kind === "clarification") {
      throw new DraftPublicationError(
        "draft_publication_invalid_plan",
        "A clarification revision has no publishable contract",
      );
    }
    return plan;
  }

  private memberRows(publicationId: string): MemberRow[] {
    return this.db
      .prepare(
        "SELECT * FROM draft_publication_members WHERE publication_id = ? ORDER BY ordinal ASC, id ASC",
      )
      .all(publicationId) as unknown as MemberRow[];
  }

  private relationshipRows(publicationId: string): RelationshipRow[] {
    return this.db
      .prepare(
        `SELECT * FROM draft_publication_relationships
          WHERE publication_id = ?
          ORDER BY CASE kind WHEN 'parent_child' THEN 0 ELSE 1 END, from_node_key ASC, to_node_key ASC`,
      )
      .all(publicationId) as unknown as RelationshipRow[];
  }

  private intentFor(publicationId: string, operationKey: string): IntentRow | null {
    const row = this.db
      .prepare(
        "SELECT * FROM publication_intents WHERE draft_publication_id = ? AND operation_key = ?",
      )
      .get(publicationId, operationKey) as unknown as IntentRow | undefined;
    return row ?? null;
  }

  private loadIntent(intentId: string): IntentRow {
    const row = this.db
      .prepare("SELECT * FROM publication_intents WHERE id = ?")
      .get(intentId) as unknown as IntentRow | undefined;
    if (!row) {
      throw new DraftPublicationError(
        "draft_publication_failed",
        `Publication intent ${intentId} disappeared`,
      );
    }
    return row;
  }

  private markIntentUnknown(intent: IntentRow): void {
    this.db
      .prepare("UPDATE publication_intents SET state = 'unknown', updated_at = ? WHERE id = ?")
      .run(this.clock(), intent.id);
  }

  private claimIntent(intent: IntentRow): boolean {
    if (intent.state === "accepted") return false;
    const result = this.db
      .prepare(
        `UPDATE publication_intents
            SET state = 'attempting', attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND state IN ('queued', 'failed', 'unknown')`,
      )
      .run(this.clock(), intent.id) as { changes: number };
    return result.changes > 0;
  }

  private acceptIntent(intent: IntentRow, remoteId: string | null): void {
    this.db
      .prepare(
        `UPDATE publication_intents
            SET state = 'accepted', remote_object_id = ?, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(remoteId, this.clock(), intent.id);
  }

  private failIntent(intent: IntentRow, error: unknown): void {
    const message = this.sanitize(error instanceof Error ? error.message : String(error));
    const ambiguous =
      /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|aborted|killed|signal|socket hang up|network/i.test(
        message,
      );
    this.db
      .prepare(
        "UPDATE publication_intents SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(ambiguous ? "unknown" : "failed", message, this.clock(), intent.id);
    this.fail(intent.draft_publication_id ?? "", message);
  }

  private fail(publicationId: string, error: string): void {
    if (!publicationId) return;
    this.db
      .prepare(
        "UPDATE draft_publications SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(error, this.clock(), publicationId);
  }

  /**
   * Recompute the projected state from durable rows so partial publication and
   * unresolved native relationships are always visible and never presented as
   * admitted. The stored state is refreshed, but the caller sees the projection.
   */
  private refresh(publicationId: string): void {
    const publication = this.db
      .prepare("SELECT * FROM draft_publications WHERE id = ?")
      .get(publicationId) as unknown as PublicationRow | undefined;
    if (!publication) return;
    const members = this.memberRows(publicationId);
    const relationships = this.relationshipRows(publicationId);
    const intents = this.intents(publicationId);

    let state: DraftPublication["state"] = publication.state;
    let lastError = publication.last_error;

    if (publication.plan_id) {
      const plan = this.safePlan(publication.project_id, publication.plan_id);
      state = plan?.authority === "admitted" ? "admitted" : "published";
      lastError = null;
    } else {
      const failedIntent = intents.find((intent) => intent.state === "failed");
      const unknownIntent = intents.find((intent) => intent.state === "unknown");
      const failedMember = members.find((member) => member.state === "failed");
      const unknownRelationship = relationships.find((row) => row.state === "unknown");
      const failedRelationship = relationships.find((row) => row.state === "failed");
      const allResolved =
        members.length > 0 &&
        members.every((member) => member.issue_number !== null) &&
        relationships.every((row) => row.state === "verified" || row.state === "fallback_textual");

      if (publication.state === "admitted") state = "admitted";
      else if (unknownIntent || unknownRelationship) {
        state = "unknown";
        lastError =
          unknownIntent?.last_error ?? unknownRelationship?.detail ?? publication.last_error;
      } else if (failedIntent || failedMember || failedRelationship) {
        state = "failed";
        lastError =
          failedIntent?.last_error ??
          failedRelationship?.detail ??
          publication.last_error ??
          "Publication failed";
      } else if (allResolved) state = "published";
      else if (
        intents.some((intent) => intent.state === "accepted") ||
        members.some((member) => member.issue_number !== null)
      ) {
        state = "publishing";
      } else state = "pending";
    }

    this.db
      .prepare(
        "UPDATE draft_publications SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
      )
      .run(state, lastError, this.clock(), publicationId);
  }

  private safePlan(projectId: string, planId: string): PlanRecord | null {
    try {
      return this.plans.getPlan(projectId, planId);
    } catch {
      return null;
    }
  }

  private intents(publicationId: string): IntentRow[] {
    return this.db
      .prepare(
        "SELECT * FROM publication_intents WHERE draft_publication_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(publicationId) as unknown as IntentRow[];
  }

  private async ensureLabels(repo: string, labels: string[]): Promise<void> {
    if (
      typeof this.forge.listLabels !== "function" ||
      typeof this.forge.createLabel !== "function"
    ) {
      return;
    }
    const existing = new Set(
      (await this.forge.listLabels(repo)).map((label) => label.name.toLowerCase()),
    );
    for (const name of labels) {
      if (existing.has(name.toLowerCase())) continue;
      const meta = LABEL_META[name] ?? { color: "ededed", description: "Animus publication label" };
      await this.forge.createLabel(repo, { name, ...meta });
      existing.add(name.toLowerCase());
    }
  }

  private sanitize(value: string): string {
    return sanitizePublicationText(value, this.sanitizer);
  }

  private serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // Mapping
  // -------------------------------------------------------------------------

  private record(projectId: string, publicationId: string): DraftPublication {
    const publication = this.loadPublication(projectId, publicationId);
    const members = this.memberRows(publicationId);
    const relationships = this.relationshipRows(publicationId);
    const intents = this.intents(publicationId);
    const plan = publication.plan_id ? this.safePlan(projectId, publication.plan_id) : null;
    const holds: PlanHold[] = plan?.holds ?? [];

    return {
      id: publication.id,
      projectId: publication.project_id,
      draftId: publication.draft_id,
      revisionId: publication.revision_id,
      revisionNumber: publication.revision_number,
      planHash: publication.plan_hash,
      kind: publication.kind,
      state: publication.state,
      sourceIssueNumber: publication.source_issue_number,
      specIssueNumber: publication.spec_issue_number,
      integrationBranch: publication.integration_branch,
      deliveryBranch: publication.delivery_branch,
      planId: publication.plan_id,
      planAuthority: (plan?.authority ?? null) as PlanAuthority | null,
      holds,
      lastError: publication.last_error,
      members: members.map((member) => this.mapMember(member)),
      relationships: relationships.map((row) => this.mapRelationship(row)),
      intents: intents.map((row) => this.mapIntent(row)),
      createdAt: publication.created_at,
      updatedAt: publication.updated_at,
    };
  }

  private mapMember(row: MemberRow): DraftPublicationMember {
    return {
      id: row.id,
      publicationId: row.publication_id,
      nodeKey: row.node_key,
      role: row.role,
      ordinal: row.ordinal,
      title: row.title,
      labels: JSON.parse(row.labels_json) as string[],
      issueNumber: row.issue_number,
      workId: row.work_id,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapRelationship(row: RelationshipRow): DraftPublicationRelationship {
    return {
      id: row.id,
      publicationId: row.publication_id,
      kind: row.kind,
      fromNodeKey: row.from_node_key,
      toNodeKey: row.to_node_key,
      fromIssueNumber: row.from_issue_number,
      toIssueNumber: row.to_issue_number,
      source: planDependencySourceSchema.parse(row.source),
      state: row.state,
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapIntent(row: IntentRow): DraftPublicationIntent {
    return {
      id: row.id,
      publicationId: row.draft_publication_id ?? "",
      projectId: row.project_id,
      operationKey: row.operation_key,
      kind: row.kind,
      resourceKind: row.resource_kind,
      state: row.state,
      attempts: row.attempts,
      remoteObjectId: row.remote_object_id,
      remoteUrl: row.remote_url,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

function publicationMarkerFromBody(body: string): string {
  return body.match(/<!-- animus-publication:[^>]+ -->/)?.[0] ?? "";
}
