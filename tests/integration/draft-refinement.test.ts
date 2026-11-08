import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftDecisionSubmission, DraftPlan } from "@animus/contracts/operator";
import { createFactoryClient } from "@animus/client";
import {
  DraftService,
  type DraftPlanner,
  type DraftPlanningRequest,
} from "../../apps/backend/src/draft";
import { IntakeService } from "../../apps/backend/src/intake";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { planDraft } from "../../scripts/loop/draft";
import { runDraftCommand } from "../../scripts/cli/commands/operations";
import type { AgentTransport } from "../../scripts/loop/types";

const REPO = "owner/repo";

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
    "- **Touchpoints**: src/feature.ts",
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

const boundary = {
  touchpoints: "apps/backend/src/feature.ts",
  known_callers: "none",
  test_seam: "tests/integration/feature.test.ts",
  exclusions: "unrelated work",
};

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
          { id: "AC1", description: "Second slice behavior.", verification: "Test" },
        ],
        verification_requirements: ["bun run test"],
        boundary,
        depends_on: [],
        body: canonicalBody(["AC1"]),
        depends_on_indices: [0],
        covers_parent_ac_ids: ["AC2"],
      },
    ],
    ...overrides,
  } as DraftPlan;
}

interface PlannerFixture {
  planner: DraftPlanner;
  calls: () => number;
  requests: DraftPlanningRequest[];
  transportCalls: () => number;
  transportRequests: () => Array<Record<string, unknown>>;
}

function plannerFixture(outputs: Array<DraftPlan | Error>): PlannerFixture {
  const requests: DraftPlanningRequest[] = [];
  const transportRequests: Array<Record<string, unknown>> = [];
  let transportCalls = 0;
  const transport: AgentTransport = async (request) => {
    transportRequests.push(request as unknown as Record<string, unknown>);
    const output = outputs[transportCalls];
    transportCalls++;
    if (!output) throw new Error("No fake transport output remaining");
    if (output instanceof Error) throw output;
    return { exitCode: 0, stdout: JSON.stringify(output), stderr: "" };
  };

  const planner: DraftPlanner = async (request) => {
    requests.push(request);
    const result = await planDraft(
      {
        root: request.checkout_path,
        repo: request.repo_name,
        stateRoot: request.state_root,
        workId: request.work_id,
        source: request.work.revision.source,
        sourceRevisionId: request.work.revision.id,
        sourceContentHash: request.work.revision.content_hash,
        provenance: {
          issue_number: request.work.revision.provenance.issue_number,
          source_url: request.work.revision.provenance.source_url,
        },
        prior: request.prior
          ? {
              questions: request.prior.revision.questions,
              answers: request.prior.revision.answers,
              instructions: request.prior.instructions,
              kind: request.prior.revision.kind,
            }
          : null,
      },
      {
        transport,
        env: { FACTORY_LOOP_PROVIDER: "claude", FACTORY_LOOP_MODEL: "test-model" },
      },
    );
    return result;
  };

  return {
    planner,
    calls: () => requests.length,
    requests,
    transportCalls: () => transportCalls,
    transportRequests: () => transportRequests,
  };
}

function makeCheckout(root: string): string {
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Draft Test"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "draft@test.local"], { cwd: checkout });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], {
    cwd: checkout,
  });
  mkdirSync(join(checkout, ".agents/skills/animus-triage"), { recursive: true });
  writeFileSync(
    join(checkout, ".agents/skills/animus-triage/SKILL.md"),
    "# animus-triage\nTriage playbook",
    "utf-8",
  );
  mkdirSync(join(checkout, ".factory/hooks"), { recursive: true });
  writeFileSync(
    join(checkout, ".factory/hooks/loop-guard.ts"),
    "export default function registerLoopGuard() {}",
    "utf-8",
  );
  writeFileSync(join(checkout, "README.md"), "# Product\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: checkout });
  return checkout;
}

describe("local draft refinement and operator review", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let projectId: string;
  let checkout: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.PI_OFFLINE;
    delete process.env.FACTORY_LOOP_PROVIDER;
    delete process.env.FACTORY_LOOP_MODEL;
    root = mkdtempSync(join(tmpdir(), "animus-draft-"));
    dbPath = join(root, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({ [REPO]: 501 });
    registry = new ProjectRegistryService(db, forge);
    checkout = makeCheckout(root);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkout,
    });
    projectId = project.id;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  async function importWork(issueNumber = 7, body = "Please add a small button.") {
    forge.addIssue(REPO, {
      number: issueNumber,
      title: "Add a small button",
      body,
      state: "OPEN",
      labels: [{ name: "needs-triage" }],
      comments: [{ id: "c1", author: "reporter", body: "It should be blue." }],
    });
    const intake = new IntakeService(db, forge);
    const result = await intake.evaluateProjectBacklog(projectId, true);
    return result.issues.find((issue) => issue.number === issueNumber)!.work!;
  }

  test("AC1: a clear small request becomes a local standalone draft without GitHub writes", async () => {
    const work = await importWork();
    const fixture = plannerFixture([standalonePlan()]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });
    const createIssue = vi.spyOn(forge, "createIssue");
    const updateIssue = vi.spyOn(forge, "updateIssue");
    const comment = vi.spyOn(forge, "createIssueComment");

    const record = await service.refine(projectId, { work_id: work.id, answers: [] });

    expect(record.status).toBe("needs_review");
    expect(record.latest_revision.kind).toBe("standalone");
    expect(record.latest_revision.revision_number).toBe(1);
    expect(record.source).toEqual(work.revision.source);
    expect(record.source_provenance).toEqual(work.revision.provenance);
    expect(record.authorization).toEqual({
      approved: false,
      approved_revision_id: null,
      can_publish: false,
    });
    expect(fixture.transportCalls()).toBe(1);
    expect(fixture.requests[0]!.work.revision.content_hash).toBe(work.revision.content_hash);
    const transportRequest = fixture.transportRequests()[0] as { argv?: string[]; cwd?: string };
    const prompt = (transportRequest.argv ?? []).join(" ");
    expect(transportRequest.cwd).toBe(checkout);
    expect(prompt).toContain("Add a small button");
    expect(prompt).toContain("Please add a small button.");
    expect(prompt).toContain("Ask the operator only about unresolved human intent");
    expect(createIssue).not.toHaveBeenCalled();
    expect(updateIssue).not.toHaveBeenCalled();
    expect(comment).not.toHaveBeenCalled();
  });

  test("AC1/AC3: a large request becomes an explicit spec with genuine dependencies and parent AC coverage", async () => {
    const work = await importWork(8, "This is a large multi-slice feature.");
    const fixture = plannerFixture([specPlan()]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const record = await service.refine(projectId, { work_id: work.id, answers: [] });
    const plan = record.latest_revision.plan;
    expect(record.status).toBe("needs_review");
    expect(plan.kind).toBe("spec");
    if (plan.kind !== "spec") throw new Error("expected spec");
    expect(plan.children.map((child) => child.id)).toEqual(["C1", "C2"]);
    expect(plan.children[1]!.depends_on_indices).toEqual([0]);
    expect(plan.children[0]!.covers_parent_ac_ids).toEqual(["AC1"]);
    expect(plan.children[1]!.covers_parent_ac_ids).toEqual(["AC2"]);
  });

  test("AC2: product questions stay local, answers create a new revision, and original source is preserved", async () => {
    const work = await importWork(9, "Make the button nicer.");
    const clarification: DraftPlan = {
      kind: "clarification",
      reason: "The desired color and placement are product decisions.",
      questions: [
        {
          id: "q1",
          question: "Which color should the button use?",
          reason: "Repository code cannot choose the brand decision.",
        },
      ],
    };
    const fixture = plannerFixture([clarification, standalonePlan()]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const first = await service.refine(projectId, { work_id: work.id, answers: [] });
    expect(first.status).toBe("needs_clarification");
    expect(first.latest_revision.questions).toHaveLength(1);
    expect(first.latest_revision.questions[0]!.id).toBe("q1");
    expect(() =>
      service.decide(projectId, first.id, {
        revision_number: 1,
        decision: "approve",
        reason: "looks good",
      }),
    ).toThrow(expect.objectContaining({ code: "draft_not_approvable" }));

    const second = await service.revise(projectId, first.id, {
      answers: [{ question_id: "q1", answer: "Use the brand blue." }],
    });
    expect(second.latest_revision.revision_number).toBe(2);
    expect(second.status).toBe("needs_review");
    expect(second.latest_revision.answers).toEqual([
      {
        question_id: "q1",
        question: "Which color should the button use?",
        answer: "Use the brand blue.",
      },
    ]);
    expect(second.source).toEqual(work.revision.source);
    expect(second.source_content_hash).toBe(work.revision.content_hash);
    expect(fixture.requests[1]!.prior?.answers[0]!.answer).toBe("Use the brand blue.");
  });

  test("AC4: decisions are revision-bound and later scope changes invalidate approval", async () => {
    const work = await importWork(10);
    const fixture = plannerFixture([
      standalonePlan(),
      standalonePlan({ title: "Add the revised small button" }),
    ]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const first = await service.refine(projectId, { work_id: work.id, answers: [] });
    const approved = service.decide(projectId, first.id, {
      revision_number: 1,
      decision: "approve",
      reason: "Scope is correct",
    });
    expect(approved.status).toBe("approved");
    // Publication approval is not execution admission: an approved but
    // unpublished draft may publish, but carries no dispatch authority at all.
    expect(approved.authorization).toEqual({
      approved: true,
      approved_revision_id: first.latest_revision.id,
      can_publish: true,
    });
    expect(approved.authorization).not.toHaveProperty("can_dispatch");

    const revised = await service.revise(projectId, first.id, {
      answers: [],
      instructions: "Tighten the scope",
    });
    expect(revised.latest_revision.revision_number).toBe(2);
    expect(revised.status).toBe("needs_review");
    expect(revised.authorization.approved).toBe(false);
    expect(revised.authorization.can_publish).toBe(false);
    expect(() =>
      service.decide(projectId, first.id, {
        revision_number: 1,
        decision: "approve",
        reason: "old approval",
      }),
    ).toThrow(expect.objectContaining({ code: "draft_stale_revision" }));
  });

  test("AC4: reject and request-changes remain explicit and a revise decision feeds the next revision", async () => {
    const work = await importWork(11);
    const fixture = plannerFixture([standalonePlan(), standalonePlan()]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });
    const first = await service.refine(projectId, { work_id: work.id, answers: [] });

    const rejected = service.decide(projectId, first.id, {
      revision_number: 1,
      decision: "reject",
      reason: "Not the requested scope",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.authorization.can_publish).toBe(false);

    const changes = service.decide(projectId, first.id, {
      revision_number: 1,
      decision: "revise",
      reason: "Change the boundary",
      instructions: "Keep the existing API stable.",
    });
    expect(changes.status).toBe("changes_requested");

    await service.revise(projectId, first.id, { answers: [] });
    expect(fixture.requests[1]!.prior?.instructions).toBe("Keep the existing API stable.");
  });

  test("AC4: revise instructions stop applying once the decision no longer targets the current revision", async () => {
    const work = await importWork(17);
    const fixture = plannerFixture([
      standalonePlan(),
      standalonePlan({ title: "Revised once" }),
      standalonePlan({ title: "Revised twice" }),
      standalonePlan({ title: "Revised three times" }),
    ]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const first = await service.refine(projectId, { work_id: work.id, answers: [] });
    // Operator asks for a change on revision 1 with explicit instructions.
    service.decide(projectId, first.id, {
      revision_number: 1,
      decision: "revise",
      reason: "Change the boundary",
      instructions: "INSTR-FROM-REV1",
    });

    // Revision 2 inherits the revision-1 instructions exactly once.
    const r2 = await service.revise(projectId, first.id, { answers: [] });
    expect(r2.latest_revision.revision_number).toBe(2);
    expect(fixture.requests[1]!.prior?.instructions).toBe("INSTR-FROM-REV1");
    expect(r2.latest_revision.instructions).toBe("INSTR-FROM-REV1");

    // The revise decision still targets revision 1, which is no longer the
    // current revision, so revision 3 must not re-inherit the stale text.
    const r3 = await service.revise(projectId, first.id, { answers: [] });
    expect(r3.latest_revision.revision_number).toBe(3);
    expect(fixture.requests[2]!.prior?.instructions).toBeUndefined();
    expect(r3.latest_revision.instructions).toBeNull();

    // A fresh revise decision on the current revision supplies new instructions.
    service.decide(projectId, first.id, {
      revision_number: 3,
      decision: "revise",
      reason: "Second pass",
      instructions: "INSTR-FROM-REV3",
    });
    const r4 = await service.revise(projectId, first.id, { answers: [] });
    expect(r4.latest_revision.revision_number).toBe(4);
    expect(fixture.requests[3]!.prior?.instructions).toBe("INSTR-FROM-REV3");
    expect(r4.latest_revision.instructions).toBe("INSTR-FROM-REV3");
  });

  test("AC4: revise instructions are not resurfaced after an approval supersedes them", async () => {
    const work = await importWork(18);
    const fixture = plannerFixture([
      standalonePlan(),
      standalonePlan({ title: "Revision two" }),
      standalonePlan({ title: "Revision three" }),
    ]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const first = await service.refine(projectId, { work_id: work.id, answers: [] });
    service.decide(projectId, first.id, {
      revision_number: 1,
      decision: "revise",
      reason: "Needs work",
      instructions: "STALE-INSTRUCTIONS",
    });
    await service.revise(projectId, first.id, { answers: [] });
    expect(fixture.requests[1]!.prior?.instructions).toBe("STALE-INSTRUCTIONS");

    // The operator now approves revision 2, superseding the revise decision.
    service.decide(projectId, first.id, {
      revision_number: 2,
      decision: "approve",
      reason: "This scope is correct",
    });
    // Explicit instructions supplied here are honored; the stale revise text is not inherited.
    const r3 = await service.revise(projectId, first.id, {
      answers: [],
      instructions: "FRESH-INSTRUCTIONS",
    });
    expect(r3.latest_revision.instructions).toBe("FRESH-INSTRUCTIONS");
    expect(fixture.requests[2]!.prior?.instructions).toBe("FRESH-INSTRUCTIONS");

    // Without new instructions, approval does not replay the old revise text.
    const fixture2 = plannerFixture([standalonePlan({ title: "Revision four" })]);
    const service2 = new DraftService(db, {
      planner: fixture2.planner,
      stateRoot: join(root, "state"),
    });
    const r4 = await service2.revise(projectId, first.id, { answers: [] });
    expect(r4.latest_revision.revision_number).toBe(4);
    expect(fixture2.requests[0]!.prior?.instructions).toBeUndefined();
    expect(r4.latest_revision.instructions).toBeNull();
  });

  test("AC3: a standard-complete prepared ticket is not decomposed or sent to the model again", async () => {
    const preparedBody = canonicalBody(["AC1"]);
    const work = await importWork(12, preparedBody);
    const fixture = plannerFixture([new Error("transport must not run")]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const record = await service.refine(projectId, { work_id: work.id, answers: [] });
    expect(fixture.transportCalls()).toBe(0);
    expect(record.latest_revision.kind).toBe("standalone");
    expect(record.latest_revision.plan.kind).toBe("standalone");
    if (record.latest_revision.plan.kind !== "standalone") throw new Error("expected standalone");
    expect(record.latest_revision.plan.prepared).toBe(true);
    expect(record.latest_revision.plan.title).toBe("Add a small button");
  });

  test("AC3: a prepared parent spec is routed to plan admission rather than re-decomposed as standalone", async () => {
    // Canonical parent-spec body with no `## Verification` section and no `Part of`.
    const specBody = [
      "## Source and problem",
      "A substantial feature spanning several slices.",
      "",
      "## Outcome",
      "The feature is delivered end to end.",
      "",
      "## Invariants",
      "- Existing behavior remains intact.",
      "",
      "## Acceptance criteria",
      "- [ ] AC1: First parent behavior.",
      "- [ ] AC2: Second parent behavior.",
      "",
      "## Boundary",
      "- **Touchpoints**: entire feature",
      "- **Known callers**: none",
      "- **Test seam**: tests/integration/feature.test.ts",
      "- **Exclusions**: unrelated work",
      "",
      "Source acceptance coverage: AC1",
      "",
      "Depends on: None",
    ].join("\n");
    const work = await importWork(31, specBody);
    const fixture = plannerFixture([new Error("transport must not run")]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({ code: "draft_prepared_work" });
    await expect(service.refine(projectId, { work_id: work.id, answers: [] })).rejects.toThrow(
      /plan admission|prepared/i,
    );
    expect(service.list(projectId)).toEqual([]);
    expect(fixture.transportCalls()).toBe(0);
  });

  test("AC3: a canonical body without a Verification section is refused, not re-planned", async () => {
    const noVerification = canonicalBody(["AC1"]).replace(
      /## Verification[\s\S]*?(?=Depends on:)/,
      "",
    );
    const work = await importWork(34, noVerification);
    const fixture = plannerFixture([new Error("transport must not run")]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({ code: "draft_prepared_work" });
    expect(service.list(projectId)).toEqual([]);
    expect(fixture.transportCalls()).toBe(0);
  });

  test("AC3: a prepared child ticket is routed to plan admission rather than refined as standalone", async () => {
    const childBody = ["Part of #900", "", canonicalBody(["AC1"])].join("\n");
    const work = await importWork(32, childBody);
    const fixture = plannerFixture([new Error("transport must not run")]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({ code: "draft_prepared_work" });
    await expect(service.refine(projectId, { work_id: work.id, answers: [] })).rejects.toThrow(
      /Part of #900/,
    );
    expect(service.list(projectId)).toEqual([]);
    expect(fixture.transportCalls()).toBe(0);
  });

  test("AC1: acceptance criterion AC1 is not satisfied by the substring inside AC10", async () => {
    const bodyWithAc10 = canonicalBody(["AC10"]);
    const planWithAc1 = {
      ...standalonePlan(),
      acceptance_criteria: [{ id: "AC1", description: "Only AC1.", verification: "Test" }],
      body: bodyWithAc10,
    } as DraftPlan;
    const work = await importWork(33);
    const fixture = plannerFixture([planWithAc1]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({ code: "draft_invalid_plan" });
    expect(service.list(projectId)).toEqual([]);
  });

  test("AC5: invalid spec coverage and missing answers fail closed without persistence", async () => {
    const work = await importWork(13);
    const invalid = specPlan();
    if (invalid.kind !== "spec") throw new Error("expected spec");
    invalid.children[0]!.covers_parent_ac_ids = ["AC9"];
    const fixture = plannerFixture([invalid]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({
      code: "draft_invalid_plan",
    });
    expect(service.list(projectId)).toEqual([]);

    const validFixture = plannerFixture([standalonePlan()]);
    const validService = new DraftService(db, {
      planner: validFixture.planner,
      stateRoot: join(root, "state"),
    });
    const draft = await validService.refine(projectId, { work_id: work.id, answers: [] });
    await expect(
      validService.revise(projectId, draft.id, {
        answers: [{ question_id: "q-unknown", answer: "x" }],
      }),
    ).rejects.toMatchObject({ code: "draft_answer_mismatch" });
  });

  test("AC5: technical repository questions are investigated rather than asked as product clarification", async () => {
    const work = await importWork(
      16,
      "Where is the button component implemented? Add it to the existing toolbar.",
    );
    const fixture = plannerFixture([standalonePlan()]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    const record = await service.refine(projectId, { work_id: work.id, answers: [] });
    expect(record.latest_revision.kind).toBe("standalone");
    expect(record.latest_revision.questions).toEqual([]);
    const prompt = ((fixture.transportRequests()[0] as { argv?: string[] }).argv ?? []).join(" ");
    expect(prompt).toContain("Never ask where code lives");
    expect(prompt).toContain("Discover repository facts first");
  });

  test("AC5: draft planning accepts only the draft plan schema, not legacy triage actions", async () => {
    const work = await importWork(15);
    // The old compatibility shortcut re-derived acceptance criteria, coverage and
    // verification heuristically from a triage action. It must not exist: a
    // legacy action payload is an invalid draft plan and persists nothing.
    const fixture = plannerFixture([
      {
        action: "promote_single_ticket",
        title: "Implement the button",
        body: canonicalBody(["AC1"]),
        reason: "Small bounded change",
        authority: "agent",
      } as unknown as DraftPlan,
    ]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({ code: "draft_invalid_plan" });
    expect(service.list(projectId)).toEqual([]);
  });

  test("AC5: planner failures do not create drafts or mutate the imported source", async () => {
    const work = await importWork(14);
    const fixture = plannerFixture([new Error("planning transport offline")]);
    const service = new DraftService(db, {
      planner: fixture.planner,
      stateRoot: join(root, "state"),
    });

    await expect(
      service.refine(projectId, { work_id: work.id, answers: [] }),
    ).rejects.toMatchObject({
      code: "draft_planning_failed",
    });
    expect(service.list(projectId)).toEqual([]);
    expect(work.revision.source.body).toBe("Please add a small button.");
  });
});

describe("draft visibility through backend HTTP, client and CLI", () => {
  let root: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;
  let workId: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    delete process.env.PI_OFFLINE;
    delete process.env.FACTORY_LOOP_PROVIDER;
    delete process.env.FACTORY_LOOP_MODEL;
    root = mkdtempSync(join(tmpdir(), "animus-draft-http-"));
    const checkout = makeCheckout(root);
    forge = new SyntheticForgeAdapter({ [REPO]: 777 });
    forge.addIssue(REPO, {
      number: 21,
      title: "Clarify the onboarding step",
      body: "Please improve onboarding.",
      state: "OPEN",
      labels: [{ name: "needs-triage" }],
      comments: [],
    });
    const fixture = plannerFixture([
      {
        kind: "clarification",
        reason: "The desired onboarding outcome is a product decision.",
        questions: [
          {
            id: "q1",
            question: "Which onboarding outcome matters most?",
            reason: "The repository cannot infer product priority.",
          },
        ],
      },
    ]);
    app = await createBackendApp({
      stateDir: join(root, "state"),
      startMonitor: false,
      forge,
      draftPlanner: fixture.planner,
    });
    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkout,
    });
    projectId = project.id;
    const intake = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${projectId}/intake?refresh=true`),
    );
    expect(intake.status).toBe(200);
    const body = (await intake.json()) as { issues: Array<{ work: { id: string } }> };
    workId = body.issues[0]!.work.id;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await app.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function backendFetch(application: BackendApp) {
    return async (input: string, init?: RequestInit) => application.fetch(new Request(input, init));
  }

  test("AC5: HTTP, client and CLI expose real questions and draft content", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });
    const scoped = client.forProject(projectId);

    const record = await scoped.refineDraft({ work_id: workId, answers: [] });
    expect(record.status).toBe("needs_clarification");
    expect(record.latest_revision.questions[0]?.question).toContain("onboarding");

    const list = await scoped.drafts();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(record.id);
    expect((await scoped.draft(record.id)).latest_revision.questions).toHaveLength(1);
    expect((await scoped.workDraft(workId)).id).toBe(record.id);

    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      expect(
        await runDraftCommand({
          subcommand: "get",
          positionals: ["draft", "get", record.id],
          projectId,
          factoryUrl: "http://127.0.0.1",
          fetch: backendFetch(app),
        }),
      ).toBe(0);
      expect(logs.join("\n")).toContain("needs_clarification");
      expect(logs.join("\n")).toContain("Which onboarding outcome matters most?");
    } finally {
      spy.mockRestore();
    }
  });

  test("AC4: unapproved drafts cannot publish and HTTP decisions stay revision-bound", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: backendFetch(app),
    });
    const scoped = client.forProject(projectId);
    const record = await scoped.refineDraft({ work_id: workId, answers: [] });

    await expect(
      scoped.decideDraft(record.id, {
        revision_number: 1,
        decision: "approve",
        reason: "approve the question",
      } satisfies DraftDecisionSubmission),
    ).rejects.toMatchObject({ code: "draft_not_approvable" });

    const fresh = await scoped.draft(record.id);
    expect(fresh.authorization.can_publish).toBe(false);
    expect(fresh.authorization).not.toHaveProperty("can_dispatch");
  });
});
