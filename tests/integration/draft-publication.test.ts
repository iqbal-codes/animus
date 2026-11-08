import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftPlan } from "@animus/contracts/operator";
import { createFactoryClient } from "@animus/client";
import { DraftService, type DraftPlanner } from "../../apps/backend/src/draft";
import { IntakeService } from "../../apps/backend/src/intake";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { PlanService } from "../../apps/backend/src/plans";
import { DraftPublicationService } from "../../apps/backend/src/publication";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { runDraftCommand } from "../../scripts/cli/commands/operations";

const REPO = "owner/repo";

const boundary = {
  touchpoints: "apps/backend/src/feature.ts",
  known_callers: "none",
  test_seam: "tests/integration/feature.test.ts",
  exclusions: "unrelated work",
};

function canonicalBody(acIds: string[], verification = "bun run test"): string {
  return [
    "## Source and problem",
    "The imported request needs a bounded implementation.",
    "",
    "## Outcome",
    "The requested behavior is observable and verified.",
    "",
    "## Invariants",
    "- Existing behavior remains intact.",
    "",
    "## Acceptance criteria",
    ...acIds.map((id) => `- [ ] ${id}: Behavior ${id} works.`),
    "",
    "## Boundary",
    "- **Touchpoints**: apps/backend/src/feature.ts",
    "- **Known callers**: none",
    "- **Test seam**: tests/integration/feature.test.ts",
    "- **Exclusions**: unrelated work",
    "",
    "## Verification",
    `- ${verification}`,
    "",
    "Depends on: None",
  ].join("\n");
}

function standalonePlan(overrides: Partial<DraftPlan> = {}): DraftPlan {
  return {
    kind: "standalone",
    title: "Add the small button",
    scope: "Add one button.",
    outcome: "The button works.",
    invariants: ["Existing behavior remains intact."],
    acceptance_criteria: [
      { id: "AC1", description: "Button is visible.", verification: "Component test" },
    ],
    verification_requirements: ["bun run test"],
    boundary,
    depends_on: [],
    body: canonicalBody(["AC1"]),
    prepared: false,
    ...overrides,
  } as DraftPlan;
}

function specPlan(overrides: Partial<DraftPlan> = {}): DraftPlan {
  return {
    kind: "spec",
    title: "Ship the feature",
    scope: "A substantial feature.",
    outcome: "The feature works end to end.",
    invariants: ["Existing behavior remains intact."],
    acceptance_criteria: [
      { id: "AC1", description: "First behavior.", verification: "Integration test" },
      { id: "AC2", description: "Second behavior.", verification: "Integration test" },
    ],
    verification_requirements: ["bun run test"],
    boundary,
    depends_on: [],
    body: canonicalBody(["AC1", "AC2"]),
    children: [
      {
        id: "C1",
        title: "First slice",
        scope: "First slice scope.",
        outcome: "First slice works.",
        invariants: ["Slice invariant."],
        acceptance_criteria: [
          { id: "AC1", description: "First slice behavior.", verification: "Test" },
        ],
        verification_requirements: ["bun run test"],
        boundary,
        depends_on: [],
        body: canonicalBody(["AC1"]),
        depends_on_indices: [],
        covers_parent_ac_ids: ["AC1"],
      },
      {
        id: "C2",
        title: "Second slice",
        scope: "Second slice scope.",
        outcome: "Second slice works.",
        invariants: ["Slice invariant."],
        acceptance_criteria: [
          { id: "AC2", description: "Second slice behavior.", verification: "Test" },
        ],
        verification_requirements: ["bun run test"],
        boundary,
        depends_on: [],
        body: canonicalBody(["AC2"]),
        depends_on_indices: [0],
        covers_parent_ac_ids: ["AC2"],
      },
    ],
    ...overrides,
  } as DraftPlan;
}

function makeCheckout(root: string): string {
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Publication Test"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "publication@test.local"], { cwd: checkout });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], {
    cwd: checkout,
  });
  writeFileSync(join(checkout, "README.md"), "# Product\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: checkout });
  return checkout;
}

class FailingCreateForge extends SyntheticForgeAdapter {
  failOnCreate = -1;
  private creates = 0;

  async createIssue(
    ...args: Parameters<SyntheticForgeAdapter["createIssue"]>
  ): ReturnType<SyntheticForgeAdapter["createIssue"]> {
    this.creates += 1;
    if (this.creates === this.failOnCreate) {
      throw new Error("synthetic create failed before remote acceptance");
    }
    return super.createIssue(...args);
  }
}

class AmbiguousCreateForge extends SyntheticForgeAdapter {
  ambiguousOnCreate = -1;
  failNextListAfterAmbiguous = false;
  private creates = 0;
  private ambiguousFired = false;

  async createIssue(
    ...args: Parameters<SyntheticForgeAdapter["createIssue"]>
  ): ReturnType<SyntheticForgeAdapter["createIssue"]> {
    this.creates += 1;
    const created = await super.createIssue(...args);
    if (this.creates === this.ambiguousOnCreate) {
      this.ambiguousFired = true;
      throw new Error("socket hang up after remote acceptance");
    }
    return created;
  }

  async listIssues(
    ...args: Parameters<SyntheticForgeAdapter["listIssues"]>
  ): ReturnType<SyntheticForgeAdapter["listIssues"]> {
    if (this.failNextListAfterAmbiguous && this.ambiguousFired) {
      this.ambiguousFired = false;
      this.failNextListAfterAmbiguous = false;
      throw new Error("network timeout while reading remote issues");
    }
    return super.listIssues(...args);
  }
}

interface Fixture {
  root: string;
  app: BackendApp;
  forge: SyntheticForgeAdapter;
  registry: ProjectRegistryService;
  projectId: string;
  checkout: string;
  workByIssue: Map<number, string>;
  client: ReturnType<typeof createFactoryClient>;
}

async function buildFixture(
  forge: SyntheticForgeAdapter = new SyntheticForgeAdapter({ [REPO]: 501 }),
  plans: (issueNumber: number) => DraftPlan = (issueNumber) =>
    issueNumber === 21 ? specPlan() : standalonePlan(),
): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "animus-draft-publication-"));
  const checkout = makeCheckout(root);

  const rawSpec = "Please ship the substantial feature described in the request.";
  const rawStandalone = "Please add a small button.";
  forge.addIssue(REPO, {
    number: 21,
    title: "Ship the substantial feature",
    body: rawSpec,
    state: "OPEN",
    labels: [{ name: "needs-triage" }],
    comments: [{ id: "c1", author: "reporter", body: "It should be blue." }],
  });
  forge.addIssue(REPO, {
    number: 22,
    title: "Add a small button",
    body: rawStandalone,
    state: "OPEN",
    labels: [{ name: "needs-triage" }],
    comments: [],
  });

  const planner: DraftPlanner = async (request) => {
    const issueNumber = request.work.revision.provenance.issue_number;
    return {
      plan: plans(issueNumber),
      metadata: {
        transport: "agent",
        prompt: "draft",
        provider: "offline",
        model: "offline",
        effort: null,
        accepted_ref: null,
      },
    };
  };

  const app = await createBackendApp({
    stateDir: join(root, "state"),
    startMonitor: false,
    forge,
    draftPlanner: planner,
  });
  const registry = new ProjectRegistryService(app.db, forge);
  const project = await registry.registerProject({
    method: "local_checkout",
    name: "Product",
    checkout_path: checkout,
  });

  const intake = new IntakeService(app.db, forge);
  const evaluated = await intake.evaluateProjectBacklog(project.id, true);
  const workByIssue = new Map<number, string>();
  for (const issue of evaluated.issues) {
    if (issue.work) workByIssue.set(issue.number, issue.work.id);
  }

  const client = createFactoryClient({
    baseUrl: "http://127.0.0.1",
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });

  return {
    root,
    app,
    forge,
    registry,
    projectId: project.id,
    checkout,
    workByIssue,
    client,
  };
}

function bodyOf(issue: { body?: string | null } | null): string {
  return issue?.body ?? "";
}

describe("approved draft publication into GitHub issues and admission", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await buildFixture();
  });

  afterEach(async () => {
    await fixture.app.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  async function approveDraft(issueNumber: number) {
    const scoped = fixture.client.forProject(fixture.projectId);
    const workId = fixture.workByIssue.get(issueNumber);
    if (!workId) throw new Error(`No work for issue ${issueNumber}`);
    const draft = await scoped.refineDraft({ work_id: workId, answers: [] });
    return scoped.decideDraft(draft.id, {
      revision_id: draft.latest_revision.id,
      decision: "approve",
      reason: "Approved after repository investigation",
    });
  }

  test("AC1/AC2/AC4: a spec draft publishes in dependency order and enters the frozen queue", async () => {
    const rawBefore = await fixture.forge.getIssue(REPO, 21);
    const draft = await approveDraft(21);
    const scoped = fixture.client.forProject(fixture.projectId);

    const publication = await scoped.publishDraft(draft.id);

    expect(publication.state).toBe("admitted");
    expect(publication.planAuthority).toBe("admitted");
    expect(publication.sourceIssueNumber).toBe(21);
    expect(publication.specIssueNumber).toBeGreaterThan(22);
    expect(publication.planId).not.toBeNull();
    expect(publication.integrationBranch).toContain("integration");

    const root = publication.members.find((member) => member.nodeKey === "root")!;
    const tickets = publication.members.filter((member) => member.role === "ticket");
    expect(root.issueNumber).toBe(publication.specIssueNumber);
    expect(tickets).toHaveLength(2);
    // Parent is created first, then children in topological order with real numbers.
    expect(root.issueNumber!).toBeLessThan(tickets[0]!.issueNumber!);
    expect(tickets[0]!.issueNumber!).toBeLessThan(tickets[1]!.issueNumber!);

    const parentIssue = await fixture.forge.getIssue(REPO, root.issueNumber!);
    expect(bodyOf(parentIssue)).toContain("Refined request: #21");
    expect(
      (parentIssue!.labels ?? [])
        .map((label) => (typeof label === "string" ? label : label.name))
        .join(","),
    ).toContain("spec");

    const first = await fixture.forge.getIssue(REPO, tickets[0]!.issueNumber!);
    expect(bodyOf(first)).toContain(`Part of #${root.issueNumber}`);
    expect(bodyOf(first)).toContain("Source acceptance coverage: AC1");
    expect(bodyOf(first)).toMatch(/^Depends on:\s*None\s*$/m);
    expect(bodyOf(first)).toContain("## Verification");

    const second = await fixture.forge.getIssue(REPO, tickets[1]!.issueNumber!);
    expect(bodyOf(second)).toContain("Source acceptance coverage: AC2");
    expect(bodyOf(second)).toContain(`Depends on: #${tickets[0]!.issueNumber}`);
    expect(bodyOf(second)).toContain(`Part of #${root.issueNumber}`);

    // Native relationships were created and read back.
    expect(await fixture.forge.getSubIssues(REPO, root.issueNumber!)).toEqual([
      tickets[0]!.issueNumber!,
      tickets[1]!.issueNumber!,
    ]);
    expect(await fixture.forge.getIssueDependencies(REPO, tickets[1]!.issueNumber!)).toEqual([
      tickets[0]!.issueNumber!,
    ]);
    expect(
      publication.relationships.every((relationship) => relationship.state === "verified"),
    ).toBe(true);
    expect(
      publication.relationships.every((relationship) => relationship.source === "textual+native"),
    ).toBe(true);

    // The reporter's original record is untouched; a backlink comment is appended instead.
    expect((await fixture.forge.getIssue(REPO, 21))!.body).toBe(rawBefore!.body);
    const source = await fixture.forge.getIssue(REPO, 21);
    expect(
      source!.comments?.some((comment) =>
        bodyOf({ body: comment.body }).includes(`Refined contract: #${root.issueNumber}`),
      ),
    ).toBe(true);

    // The same frozen admission rules as prepared work produced the plan.
    const plan = await scoped.plan(publication.planId!);
    expect(plan.id).toBe(publication.planId);
    expect(plan.authority).toBe("admitted");
    expect(plan.members.map((member) => member.role).sort()).toEqual(["spec", "ticket", "ticket"]);
    expect(plan.members.find((member) => member.role === "spec")!.issue_number).toBe(
      root.issueNumber,
    );
    expect(plan.kind).toBe("spec");

    // Rediscovery after publication does not duplicate or retriage the accepted contract.
    const before = (await fixture.forge.listIssues(REPO, "ALL")).length;
    const intake = new IntakeService(fixture.app.db, fixture.forge);
    await intake.evaluateProjectBacklog(fixture.projectId, true);
    expect((await fixture.forge.listIssues(REPO, "ALL")).length).toBe(before);
    expect((await scoped.drafts()).length).toBe(1);
    expect((await scoped.plans()).length).toBe(1);
    expect((await scoped.draftPublicationByDraft(draft.id)).id).toBe(publication.id);

    // Operator and CLI surfaces show real issue numbers and no fabricated URL.
    expect((await scoped.draftPublications()).length).toBe(1);
    expect((await scoped.draftPublication(publication.id)).state).toBe("admitted");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(
        await runDraftCommand({
          subcommand: "publication",
          positionals: ["draft", "publication", draft.id],
          projectId: fixture.projectId,
          factoryUrl: "http://127.0.0.1",
          factoryToken: "",
          fetch: (input, init) => fixture.app.fetch(new Request(input, init)),
          json: false,
        }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
    const output = logs.join("\n");
    expect(output).toContain("admitted");
    expect(output).toContain(`#${root.issueNumber}`);
    expect(output).not.toMatch(/https?:\/\//);

    // No builder was dispatched by publication.
    expect(JSON.stringify(publication)).not.toMatch(/https?:\/\//);
  });

  test("AC4: a standalone draft publishes its own ticket and is admitted", async () => {
    const draft = await approveDraft(22);
    const publication = await fixture.client.forProject(fixture.projectId).publishDraft(draft.id);

    expect(publication.state).toBe("admitted");
    expect(publication.kind).toBe("standalone");
    expect(publication.members).toHaveLength(1);
    const ticket = publication.members[0]!;
    expect(ticket.role).toBe("ticket");
    expect(ticket.labels).toEqual(["ready-for-agent"]);
    const issue = await fixture.forge.getIssue(REPO, ticket.issueNumber!);
    expect(bodyOf(issue)).toContain("Refined request: #22");
    expect(bodyOf(issue)).toMatch(/^Depends on:\s*None\s*$/m);

    const plan = (await fixture.client.forProject(fixture.projectId).plans())[0]!;
    expect(plan.kind).toBe("standalone");
    expect(plan.authority).toBe("admitted");
  });

  test("AC1: unapproved, clarification and stale drafts cannot publish", async () => {
    const scoped = fixture.client.forProject(fixture.projectId);
    const workId = fixture.workByIssue.get(21)!;
    const unapproved = await scoped.refineDraft({ work_id: workId, answers: [] });

    await expect(scoped.publishDraft(unapproved.id)).rejects.toMatchObject({
      code: "draft_publication_not_approved",
    });

    const clarificationPlanner: DraftPlanner = async () => ({
      plan: {
        kind: "clarification",
        reason: "The desired outcome is a product decision.",
        questions: [
          { id: "q1", question: "Which outcome matters most?", reason: "Product priority." },
        ],
      },
      metadata: plannerMetadata(),
    });
    const clarificationService = new DraftService(fixture.app.db, {
      planner: clarificationPlanner,
      stateRoot: join(fixture.root, "state"),
    });
    const clarification = await clarificationService.refine(fixture.projectId, {
      work_id: fixture.workByIssue.get(22)!,
      answers: [],
    });
    await expect(scoped.publishDraft(clarification.id)).rejects.toMatchObject({
      code: "draft_publication_not_publishable",
    });

    const approved = await scoped.decideDraft(unapproved.id, {
      revision_id: unapproved.latest_revision.id,
      decision: "approve",
      reason: "Approved",
    });
    expect(approved.authorization.can_publish).toBe(true);
    const revised = await scoped.reviseDraft(approved.id, { answers: [] });
    expect(revised.authorization.can_publish).toBe(false);
    await expect(scoped.publishDraft(approved.id)).rejects.toMatchObject({
      code: "draft_publication_not_approved",
    });
  });
});

describe("partial, ambiguous and unsupported publication recovery", () => {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture.app.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  async function approveDraft(issueNumber: number) {
    const scoped = fixture.client.forProject(fixture.projectId);
    const workId = fixture.workByIssue.get(issueNumber)!;
    const draft = await scoped.refineDraft({ work_id: workId, answers: [] });
    return scoped.decideDraft(draft.id, {
      revision_id: draft.latest_revision.id,
      decision: "approve",
      reason: "Approved",
    });
  }

  test("AC3: a definitive failure halfway stays visible and a restarted service resumes without duplicates", async () => {
    const forge = new FailingCreateForge({ [REPO]: 501 });
    fixture = await buildFixture(forge);
    forge.failOnCreate = 2;
    const draft = await approveDraft(21);
    const scoped = fixture.client.forProject(fixture.projectId);

    const partial = await scoped.publishDraft(draft.id);
    expect(partial.state).toBe("failed");
    expect(partial.planId).toBeNull();
    const root = partial.members.find((member) => member.nodeKey === "root")!;
    expect(root.issueNumber).not.toBeNull();
    expect(partial.members.filter((member) => member.issueNumber === null)).toHaveLength(2);
    expect(partial.lastError).toContain("synthetic create failed");

    // The partial graph is visible and nonexecutable: no plan was admitted.
    expect((await scoped.plans()).length).toBe(0);

    forge.failOnCreate = -1;
    // A fresh service instance over the same database proves durable restart recovery.
    const draftService = new DraftService(fixture.app.db, {
      planner: async () => ({ plan: specPlan(), metadata: plannerMetadata() }),
      stateRoot: join(fixture.root, "state"),
    });
    const planService = new PlanService(fixture.app.db, fixture.forge);
    const restarted = new DraftPublicationService(
      fixture.app.db,
      fixture.forge,
      draftService,
      planService,
    );
    const resumed = await restarted.publish(fixture.projectId, partial.id);

    expect(resumed.state).toBe("admitted");
    expect(resumed.members.every((member) => member.issueNumber !== null)).toBe(true);
    const childBodies = (await fixture.forge.listIssues(REPO, "ALL")).filter((issue) =>
      bodyOf(issue).includes(`create_issue:${partial.id}:child:C1`),
    );
    expect(childBodies).toHaveLength(1);
  });

  test("AC3: an accepted-but-unacknowledged create reconciles by exact correlation and never duplicates", async () => {
    const forge = new AmbiguousCreateForge({ [REPO]: 501 });
    fixture = await buildFixture(forge);
    forge.ambiguousOnCreate = 2;
    forge.failNextListAfterAmbiguous = true;
    const draft = await approveDraft(21);
    const scoped = fixture.client.forProject(fixture.projectId);

    const ambiguous = await scoped.publishDraft(draft.id);
    expect(ambiguous.state).toBe("unknown");
    expect(ambiguous.intents.some((intent) => intent.state === "unknown")).toBe(true);
    expect((await scoped.plans()).length).toBe(0);

    const reconciled = await scoped.reconcileDraftPublication(ambiguous.id);
    expect(reconciled.state).toBe("admitted");
    const markers = (await fixture.forge.listIssues(REPO, "ALL")).flatMap((issue) =>
      bodyOf(issue).match(/create_issue:[^ ]+:child:C1/)?.[0]
        ? [bodyOf(issue).match(/create_issue:[^ ]+:child:C1/)![0]]
        : [],
    );
    expect(new Set(markers).size).toBe(1);
    expect(markers).toHaveLength(1);
  });

  test("AC3: a crashed create with unreadable correlation never retries the remote mutation", async () => {
    const forge = new AmbiguousCreateForge({ [REPO]: 501 });
    fixture = await buildFixture(forge);
    forge.ambiguousOnCreate = 2;
    forge.failNextListAfterAmbiguous = true;
    const draft = await approveDraft(21);
    const scoped = fixture.client.forProject(fixture.projectId);
    const partial = await scoped.publishDraft(draft.id);
    const uncertain = partial.intents.find((intent) => intent.state === "unknown")!;
    expect(uncertain).toBeTruthy();
    const before = await forge.listIssues(REPO, "ALL");
    // Crash persistence: remote accepted, local intent never acknowledged completion.
    fixture.app.db
      .prepare("UPDATE publication_intents SET state = 'attempting' WHERE id = ?")
      .run(uncertain.id);
    const create = vi.spyOn(forge, "createIssue");
    const read = vi
      .spyOn(forge, "listIssues")
      .mockRejectedValue(new Error("remote correlation unavailable"));
    const blocked = await scoped.reconcileDraftPublication(partial.id);
    expect(create).not.toHaveBeenCalled();
    expect(blocked.state).toBe("unknown");
    expect(blocked.planId).toBeNull();
    read.mockRestore();
    expect(await forge.listIssues(REPO, "ALL")).toHaveLength(before.length);
    const recovered = await scoped.reconcileDraftPublication(partial.id);
    expect(recovered.state).toBe("admitted");
    const matches = (await forge.listIssues(REPO, "ALL")).filter((issue) =>
      bodyOf(issue).includes(uncertain.operationKey),
    );
    expect(matches).toHaveLength(1);
    create.mockRestore();
  });

  test.each(["revise", "reject"] as const)(
    "AC1: all-created graphs remain fenced after draft %s before admission",
    async (decision) => {
      const forge = new SyntheticForgeAdapter({ [REPO]: 501 });
      fixture = await buildFixture(forge);
      const relationship = vi
        .spyOn(forge, "addSubIssue")
        .mockRejectedValue(new Error("relationship outage"));
      const relationshipRead = vi
        .spyOn(forge, "getSubIssues")
        .mockRejectedValue(new Error("relationship unreadable"));
      const draft = await approveDraft(21);
      const scoped = fixture.client.forProject(fixture.projectId);
      const partial = await scoped.publishDraft(draft.id);
      expect(partial.members.every((member) => member.issueNumber !== null)).toBe(true);
      expect(partial.planId).toBeNull();
      relationship.mockRestore();
      relationshipRead.mockRestore();
      if (decision === "revise") {
        await scoped.reviseDraft(draft.id, {
          answers: [],
          instructions: "Change the approved scope",
        });
      } else {
        await scoped.decideDraft(draft.id, {
          revision_id: draft.latest_revision.id,
          decision: "reject",
          reason: "Revoke publication approval",
        });
      }
      await expect(scoped.reconcileDraftPublication(partial.id)).rejects.toMatchObject({
        code:
          decision === "revise"
            ? "draft_publication_stale_revision"
            : "draft_publication_not_approved",
      });
      expect(await scoped.plans()).toHaveLength(0);
      expect((await scoped.draftPublication(partial.id)).planId).toBeNull();
    },
  );

  test("AC2/AC3: unsupported native relationships fall back to canonical textual references", async () => {
    const forge = new SyntheticForgeAdapter({ [REPO]: 501 });
    // Simulate a forge that supports no native relationship creation.
    (forge as unknown as Record<string, unknown>).addSubIssue = undefined;
    (forge as unknown as Record<string, unknown>).addIssueDependency = undefined;
    fixture = await buildFixture(forge);
    const draft = await approveDraft(21);

    const publication = await fixture.client.forProject(fixture.projectId).publishDraft(draft.id);

    expect(publication.state).toBe("admitted");
    const relationships = publication.relationships;
    expect(relationships.length).toBeGreaterThan(0);
    expect(
      relationships.every(
        (relationship) =>
          relationship.state === "fallback_textual" && relationship.source === "textual",
      ),
    ).toBe(true);
    expect(
      relationships.every((relationship) => relationship.detail?.includes("unsupported")),
    ).toBe(true);

    const root = publication.members.find((member) => member.nodeKey === "root")!;
    const tickets = publication.members.filter((member) => member.role === "ticket");
    const second = await forge.getIssue(REPO, tickets[1]!.issueNumber!);
    expect(bodyOf(second)).toContain(`Part of #${root.issueNumber}`);
    expect(bodyOf(second)).toContain(`Depends on: #${tickets[0]!.issueNumber}`);

    const planId = (await fixture.client.forProject(fixture.projectId).plans())[0]!.id;
    const plan = await fixture.client.forProject(fixture.projectId).plan(planId);
    expect(plan.authority).toBe("admitted");
    expect(
      plan.dependencies.find(
        (dependency) => dependency.target_issue_number === tickets[0]!.issueNumber,
      ),
    ).toMatchObject({ source: "textual", target_role: "internal" });
  });

  test("AC1: published contract text is sanitized before it crosses the remote boundary", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const forge = new SyntheticForgeAdapter({ [REPO]: 501 });
    fixture = await buildFixture(forge, () =>
      standalonePlan({
        scope: `Add a button using ${secret} from /Users/secret/project/config.ts`,
        boundary: {
          ...boundary,
          touchpoints: "/Users/secret/project/apps/backend/src/feature.ts",
        },
      }),
    );
    const draft = await approveDraft(22);
    const publication = await fixture.client.forProject(fixture.projectId).publishDraft(draft.id);
    expect(publication.state).toBe("admitted");
    const issue = await forge.getIssue(REPO, publication.members[0]!.issueNumber!);
    expect(bodyOf(issue)).not.toContain(secret);
    expect(bodyOf(issue)).not.toContain("/Users/secret");
    expect(bodyOf(issue)).toContain("[REDACTED_GH_TOKEN]");
    expect(bodyOf(issue)).toContain("[LOCAL_PATH]");
  });
});

function plannerMetadata() {
  return {
    transport: "agent" as const,
    prompt: "draft",
    provider: "offline",
    model: "offline",
    effort: null,
    accepted_ref: null,
  };
}
