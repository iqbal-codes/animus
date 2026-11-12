import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntakeService } from "../../apps/backend/src/intake";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { computeGraphHash, graphFromManifest, PlanService } from "../../apps/backend/src/plans";

const REPO = "owner/repo";
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;

interface TicketBodyOptions {
  partOf?: number | null;
  criteria?: string[];
  rawCriteria?: string[];
  coverage?: string;
  dependsOn?: number[];
  extra?: string;
}

function ticketBody(options: TicketBodyOptions = {}): string {
  const criteriaLines =
    options.rawCriteria ??
    (options.criteria ?? ["first criterion", "second criterion"]).map(
      (criterion, index) => `AC${index + 1}: ${criterion}`,
    );
  const lines = [];
  if (options.partOf) lines.push(`Part of #${options.partOf}`, "");
  if (options.coverage) lines.push(`Source acceptance coverage: ${options.coverage}`, "");
  lines.push(
    "## Source and problem",
    "",
    "Prepared ticket source.",
    "",
    "## Outcome",
    "",
    "Prepared ticket outcome.",
    "",
    "## Invariants",
    "",
    "- Keep the invariant.",
    "",
    "## Acceptance criteria",
    "",
    ...criteriaLines.map((criterionLine) => `- [ ] ${criterionLine}`),
    "",
    "## Boundary",
    "",
    "Prepared ticket boundary.",
  );
  if (options.dependsOn && options.dependsOn.length > 0) {
    lines.push("", `Depends on: ${options.dependsOn.map((n) => `#${n}`).join(", ")}`);
  } else {
    lines.push("", "Depends on: None");
  }
  if (options.extra) lines.push("", options.extra);
  return lines.join("\n");
}

function specBody(criteria: string[]): string {
  return [
    "## Source and problem",
    "",
    "Prepared specification source.",
    "",
    "## Outcome",
    "",
    "Prepared specification outcome.",
    "",
    "## Invariants",
    "",
    "- Planning record, never dispatched directly.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((criterion, index) => `- [ ] AC${index + 1} — ${criterion}`),
    "",
    "## Boundary",
    "",
    "Prepared specification boundary.",
  ].join("\n");
}

describe("prepared spec and ticket plan admission", () => {
  let root: string;
  let dbPath: string;
  let db: ReturnType<typeof initializeDatabase>;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let projectId: string;
  let checkoutPath: string;
  let work: IntakeService;
  let plans: PlanService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-plan-"));
    process.env.ANIMUS_HOME = join(root, "animus-home");
    dbPath = join(root, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({ [REPO]: 901 });
    registry = new ProjectRegistryService(db, forge);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    execFileSync("git", [
      "-C",
      checkoutPath,
      "remote",
      "add",
      "origin",
      `https://github.com/${REPO}.git`,
    ]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", checkoutPath, "config", "user.name", "Test"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "--allow-empty", "-q", "-m", "base"]);
    execFileSync("git", ["-C", checkoutPath, "branch", "-M", "main"]);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    work = new IntakeService(db, forge);
    plans = new PlanService(db, forge);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  function writeSchedule(maxLaps: number): void {
    mkdirSync(join(checkoutPath, ".factory"), { recursive: true });
    writeFileSync(
      join(checkoutPath, ".factory", "schedule.json"),
      JSON.stringify({ max_laps: maxLaps }),
    );
  }

  function addIssue(
    number: number,
    body: string,
    labels: string[] = ["ready-for-agent"],
    state = "OPEN",
  ) {
    forge.addIssue(REPO, {
      number,
      title: `Issue ${number}`,
      body,
      state,
      labels: labels.map((name) => ({ name })),
      comments: [],
    });
  }

  async function importAll() {
    return await work.evaluateProjectBacklog(projectId, true);
  }

  async function workIdFor(issueNumber: number): Promise<string> {
    const backlog = await importAll();
    const issue = backlog.issues.find((item) => item.number === issueNumber);
    if (!issue?.work) throw new Error(`work missing for #${issueNumber}`);
    return issue.work.id;
  }

  test("AC1: a fully discovered spec graph is admitted from frozen revisions without redecomposition", async () => {
    addIssue(100, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(101, ticketBody({ partOf: 100, coverage: "AC1", criteria: ["child one criterion"] }));
    addIssue(
      102,
      ticketBody({
        partOf: 100,
        coverage: "AC2",
        criteria: ["child two criterion"],
        dependsOn: [101],
      }),
    );
    await importAll();
    await forge.addIssueDependency(REPO, 102, 101);

    const rootWorkId = await workIdFor(100);
    const plan = await plans.importPlan(projectId, { work_id: rootWorkId, kind: "spec" });

    expect(plan.kind).toBe("spec");
    expect(plan.authority).toBe("admitted");
    expect(plan.dispatchable).toBe(true);
    expect(plan.holds).toEqual([]);
    expect(
      plan.members.map((member) => member.issue_number).sort((left, right) => left - right),
    ).toEqual([100, 101, 102]);
    expect(plan.members.find((member) => member.issue_number === 100)?.role).toBe("spec");
    expect(plan.members.find((member) => member.issue_number === 100)?.gate_profile).toBe("final");
    expect(plan.members.find((member) => member.issue_number === 101)?.gate_profile).toBe("child");

    const imported = db
      .prepare(
        `SELECT w.id, w.issue_number, r.id AS revision_id, r.content_hash
         FROM work_items w JOIN work_revisions r ON r.work_id = w.id
         WHERE w.project_id = ? ORDER BY w.issue_number`,
      )
      .all(projectId) as Array<{
      id: string;
      issue_number: number;
      revision_id: string;
      content_hash: string;
    }>;
    const manifest = plan.manifest;
    expect(manifest).not.toBeNull();
    expect(manifest!.graph_hash).toBe(plan.graph_hash);
    expect(computeGraphHash(graphFromManifest(manifest!))).toBe(manifest!.graph_hash);
    expect(manifest!.members).toHaveLength(3);
    for (const row of imported) {
      const member = manifest!.members.find((item) => item.issue_number === row.issue_number)!;
      expect(member.work_id).toBe(row.id);
      expect(member.revision_id).toBe(row.revision_id);
      expect(member.content_hash).toBe(row.content_hash);
    }
    expect(manifest!.targets).toEqual({
      delivery_branch: "main",
      integration_branch: "factory/spec-100-integration",
      final_pr_base: "main",
    });
    expect(manifest!.merge_policy).toEqual({
      child: "auto_after_gates",
      standalone: "manual",
      final: "manual",
    });
    expect(manifest!.budgets.max_laps).toBeGreaterThan(0);
    expect(manifest!.ac_coverage).toEqual([
      {
        parent_ac_key: "AC1",
        child_work_ids: [plan.members.find((m) => m.issue_number === 101)!.work_id],
      },
      {
        parent_ac_key: "AC2",
        child_work_ids: [plan.members.find((m) => m.issue_number === 102)!.work_id],
      },
    ]);

    expect(plan.decisions).toHaveLength(1);
    expect(plan.decisions[0]).toMatchObject({
      sequence: 1,
      action: "import",
      outcome: "admitted",
      source: "import_authorization",
    });
    expect(plan.accepted_revision?.work_id).toBe(rootWorkId);
    expect(
      plan.acceptance_criteria.filter((criterion) => criterion.work_id === rootWorkId),
    ).toHaveLength(2);

    const listed = plans.listPlans(projectId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: plan.id,
      kind: "spec",
      authority: "admitted",
      root_issue_number: 100,
      member_count: 3,
      ticket_count: 2,
    });

    const reloaded = plans.getPlan(projectId, plan.id);
    expect(reloaded).toEqual(plan);

    const evidence = JSON.parse(
      (
        db.prepare("SELECT evidence FROM plan_decisions WHERE plan_id = ?").get(plan.id) as {
          evidence: string;
        }
      ).evidence,
    ) as {
      rules_version: string;
      members: Array<{
        issue_number: number;
        ready_for_agent: boolean;
        blocking_labels: string[];
        exclusion_labels: string[];
        outcome: string;
      }>;
    };
    expect(evidence.rules_version).toBe("prepared-plan-v1");
    const parentEvidence = evidence.members.find((member) => member.issue_number === 100);
    expect(parentEvidence).toMatchObject({
      ready_for_agent: true,
      blocking_labels: [],
      exclusion_labels: [],
      outcome: "admitted",
    });
  });

  test("AC3: cyclic internal dependencies hold the plan with an explicit cycle", async () => {
    addIssue(200, specBody(["parent first", "parent second"]), ["ready-for-agent", "spec"]);
    addIssue(201, ticketBody({ partOf: 200, coverage: "AC1", dependsOn: [202] }));
    addIssue(202, ticketBody({ partOf: 200, coverage: "AC2", dependsOn: [201] }));
    await importAll();
    const rootWorkId = await workIdFor(200);

    const plan = await plans.importPlan(projectId, { work_id: rootWorkId, kind: "spec" });

    expect(plan.authority).toBe("held");
    expect(plan.dispatchable).toBe(false);
    expect(plan.manifest).toBeNull();
    expect(plan.accepted_revision).toBeNull();
    expect(plan.holds).toContainEqual(
      expect.objectContaining({
        code: "dependency_cycle",
        severity: "blocking",
        detail: expect.stringContaining("#201 ->"),
      }),
    );
    expect(plan.decisions[0]).toMatchObject({ action: "import", outcome: "held" });
  });

  test("AC3: a spec without discovered children stays held instead of falling back to standalone", async () => {
    addIssue(300, specBody(["only criterion"]), ["ready-for-agent", "spec"]);
    await importAll();
    const rootWorkId = await workIdFor(300);

    const plan = await plans.importPlan(projectId, { work_id: rootWorkId, kind: "spec" });

    expect(plan.kind).toBe("spec");
    expect(plan.authority).toBe("held");
    expect(plan.dispatchable).toBe(false);
    expect(plan.members).toHaveLength(1);
    expect(plan.members[0]).toMatchObject({
      issue_number: 300,
      role: "spec",
      gate_profile: "final",
    });
    expect(plan.holds).toContainEqual(
      expect.objectContaining({ code: "incomplete_child_discovery", severity: "blocking" }),
    );
    expect(plan.manifest).toBeNull();
  });

  test("AC3: inconsistent parent/child ownership and unresolved references fail closed", async () => {
    addIssue(400, ticketBody({ partOf: 399 }), ["ready-for-agent"]);
    addIssue(401, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(402, ticketBody({ partOf: 401, coverage: "AC1" }));
    addIssue(403, ticketBody({ partOf: 499, coverage: "AC2" }));
    await forge.addSubIssue(REPO, 401, 403);
    await importAll();

    const standalone = await plans.importPlan(projectId, {
      work_id: await workIdFor(400),
      kind: "standalone",
    });
    expect(standalone.authority).toBe("held");
    expect(standalone.holds).toContainEqual(
      expect.objectContaining({
        code: "inconsistent_parent_child_ownership",
        severity: "blocking",
      }),
    );

    const spec = await plans.importPlan(projectId, {
      work_id: await workIdFor(401),
      kind: "spec",
    });
    expect(spec.members.map((member) => member.issue_number)).not.toContain(403);
    expect(spec.holds).toContainEqual(
      expect.objectContaining({
        code: "inconsistent_parent_child_ownership",
        severity: "blocking",
      }),
    );

    addIssue(500, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(501, ticketBody({ partOf: 500, coverage: "AC1", dependsOn: [999] }));
    addIssue(502, ticketBody({ partOf: 500, coverage: "AC2" }));
    await importAll();
    const unresolved = await plans.importPlan(projectId, {
      work_id: await workIdFor(500),
      kind: "spec",
    });
    expect(unresolved.authority).toBe("held");
    expect(unresolved.holds).toContainEqual(
      expect.objectContaining({
        code: "unresolved_reference",
        severity: "blocking",
        detail: expect.stringContaining("#999"),
      }),
    );
  });

  test("AC4: operator approval authorizes the whole plan and later GitHub labels cannot override revocation", async () => {
    addIssue(600, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(601, ticketBody({ partOf: 600, coverage: "AC1" }), []);
    addIssue(602, ticketBody({ partOf: 600, coverage: "AC2" }));
    await importAll();

    const held = await plans.importPlan(projectId, {
      work_id: await workIdFor(600),
      kind: "spec",
    });
    expect(held.authority).toBe("held");
    expect(held.manifest).toBeNull();
    expect(held.holds).toContainEqual(
      expect.objectContaining({ code: "unlabeled_awaiting_triage", severity: "blocking" }),
    );

    const approved = plans.approvePlan(projectId, held.id, {
      actor: "operator-1",
      reason: "Scope reviewed",
    });
    expect(approved.authority).toBe("admitted");
    expect(approved.dispatchable).toBe(true);
    expect(approved.manifest).not.toBeNull();
    expect(approved.decisions.map((decision) => decision.action)).toEqual(["import", "approve"]);
    expect(approved.decisions[1]).toMatchObject({
      sequence: 2,
      outcome: "admitted",
      source: "operator",
      actor: "operator-1",
    });

    const revoked = plans.revokePlan(projectId, held.id, {
      actor: "operator-1",
      reason: "Scope withdrawn",
    });
    expect(revoked.authority).toBe("revoked");
    expect(revoked.dispatchable).toBe(false);
    expect(revoked.accepted_revision?.revision_id).toBe(approved.accepted_revision?.revision_id);
    expect(revoked.decisions.map((decision) => decision.action)).toEqual([
      "import",
      "approve",
      "revoke",
    ]);

    addIssue(601, ticketBody({ partOf: 600, coverage: "AC1" }), ["ready-for-agent"]);
    await importAll();
    const afterLabelEdit = plans.getPlan(projectId, held.id);
    expect(afterLabelEdit.authority).toBe("revoked");
    expect(afterLabelEdit.decisions.at(-1)?.action).toBe("revoke");

    addIssue(600, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(601, ticketBody({ partOf: 600, coverage: "AC1" }), ["ready-for-agent"]);
    await importAll();
    const reimported = await plans.importPlan(projectId, {
      work_id: await workIdFor(600),
      kind: "spec",
    });
    expect(reimported.id).toBe(held.id);
    expect(reimported.authority).toBe("revoked");
  });

  test("AC5: known prerequisite work is queued for verified integration instead of re-triage", async () => {
    addIssue(700, ticketBody({ dependsOn: [701] }), ["ready-for-agent"]);
    addIssue(701, ticketBody({ criteria: ["prerequisite criterion"] }), ["ready-for-agent"]);
    await importAll();

    const dependentWork = await workIdFor(700);
    const prerequisiteWork = await workIdFor(701);
    const prerequisite = await plans.importPlan(projectId, {
      work_id: prerequisiteWork,
      kind: "standalone",
    });
    expect(prerequisite.authority).toBe("admitted");

    const plan = await plans.importPlan(projectId, {
      work_id: dependentWork,
      kind: "standalone",
    });
    expect(plan.authority).toBe("admitted");
    expect(plan.dispatchable).toBe(false);
    expect(plan.holds).toContainEqual(
      expect.objectContaining({
        code: "dependency_pending_integration",
        severity: "conditional",
        detail: expect.stringContaining("no re-triage required"),
      }),
    );
    expect(plan.dependencies).toContainEqual(
      expect.objectContaining({ target_issue_number: 701, target_role: "external" }),
    );

    execFileSync("git", ["-C", checkoutPath, "branch", "factory/dep-701", "HEAD"]);
    work.recordBranchIntegration(projectId, 701, "factory/dep-701");

    const integrated = plans.getPlan(projectId, plan.id);
    expect(integrated.holds).toEqual([]);
    expect(integrated.dispatchable).toBe(true);
    expect(integrated.accepted_revision?.work_id).toBe(dependentWork);
  });

  test("AC2/AC4: blocking and exclusion labels stay in initial evidence and cannot be overridden", async () => {
    addIssue(900, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(901, ticketBody({ partOf: 900, coverage: "AC1" }), ["ready-for-agent", "needs-info"]);
    addIssue(902, ticketBody({ partOf: 900, coverage: "AC2" }));
    await importAll();

    const blocked = await plans.importPlan(projectId, {
      work_id: await workIdFor(900),
      kind: "spec",
    });
    expect(blocked.authority).toBe("held");
    expect(blocked.holds).toContainEqual(
      expect.objectContaining({ code: "held_by_label", severity: "blocking" }),
    );
    const evidence = JSON.parse(
      (
        db.prepare("SELECT evidence FROM plan_decisions WHERE plan_id = ?").get(blocked.id) as {
          evidence: string;
        }
      ).evidence,
    ) as {
      members: Array<{
        issue_number: number;
        ready_for_agent: boolean;
        blocking_labels: string[];
        outcome: string;
      }>;
    };
    expect(evidence.members.find((member) => member.issue_number === 901)).toMatchObject({
      ready_for_agent: true,
      blocking_labels: ["needs-info"],
      outcome: "held",
    });

    const rejected = plans.approvePlan(projectId, blocked.id, { actor: "operator" });
    expect(rejected.authority).toBe("held");
    expect(rejected.decisions.map((decision) => decision.outcome)).toEqual(["held", "held"]);

    addIssue(910, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(911, ticketBody({ partOf: 910, coverage: "AC1" }), ["ready-for-agent", "wontfix"]);
    addIssue(912, ticketBody({ partOf: 910, coverage: "AC2" }));
    await importAll();
    const excluded = await plans.importPlan(projectId, {
      work_id: await workIdFor(910),
      kind: "spec",
    });
    expect(excluded.authority).toBe("held");
    expect(excluded.holds).toContainEqual(
      expect.objectContaining({ code: "excluded_by_label", severity: "blocking" }),
    );
    expect(plans.approvePlan(projectId, excluded.id).authority).toBe("held");
  });

  test("AC3/AC5: partially discovered child graphs hold explicitly instead of dropping missing children", async () => {
    addIssue(920, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(921, ticketBody({ partOf: 920, coverage: "AC1" }));
    addIssue(922, ticketBody({ partOf: 920, coverage: "AC2" }));
    await importAll();

    const originalSubIssues = forge.getSubIssues.bind(forge);
    forge.getSubIssues = async (repo: string, parentNumber: number) =>
      parentNumber === 920 ? [999] : originalSubIssues(repo, parentNumber);

    const plan = await plans.importPlan(projectId, {
      work_id: await workIdFor(920),
      kind: "spec",
    });
    expect(plan.authority).toBe("held");
    expect(plan.members.map((member) => member.issue_number)).toEqual([920, 921, 922]);
    expect(plan.holds).toContainEqual(
      expect.objectContaining({
        code: "incomplete_child_discovery",
        severity: "blocking",
        detail: expect.stringContaining("#999"),
      }),
    );
  });

  test("AC3: a nested parent spec cannot dispatch as a child ticket", async () => {
    addIssue(960, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(961, ticketBody({ partOf: 960, coverage: "AC1" }));
    addIssue(962, ticketBody({ partOf: 961, coverage: "AC1" }));
    addIssue(963, ticketBody({ partOf: 960, coverage: "AC2" }));
    await importAll();

    const plan = await plans.importPlan(projectId, {
      work_id: await workIdFor(960),
      kind: "spec",
    });
    expect(plan.authority).toBe("held");
    expect(plan.members.find((member) => member.issue_number === 961)?.role).toBe("ticket");
    expect(plan.members.map((member) => member.issue_number)).not.toContain(962);
    expect(plan.holds).toContainEqual(
      expect.objectContaining({
        code: "inconsistent_parent_child_ownership",
        severity: "blocking",
        detail: expect.stringContaining("#962"),
      }),
    );
  });

  test("AC4/AC5: a resolved discovery hold can be re-imported while admitted or revoked authority stays sticky", async () => {
    addIssue(950, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(951, ticketBody({ partOf: 950, coverage: "AC1", dependsOn: [999] }));
    addIssue(952, ticketBody({ partOf: 950, coverage: "AC2" }));
    await importAll();

    const blocked = await plans.importPlan(projectId, {
      work_id: await workIdFor(950),
      kind: "spec",
    });
    expect(blocked.authority).toBe("held");
    expect(blocked.holds).toContainEqual(
      expect.objectContaining({ code: "unresolved_reference", severity: "blocking" }),
    );

    addIssue(999, ticketBody({ criteria: ["prerequisite criterion"] }), ["ready-for-agent"]);
    const recovered = await plans.importPlan(projectId, {
      work_id: await workIdFor(950),
      kind: "spec",
    });
    expect(recovered.id).not.toBe(blocked.id);
    expect(recovered.authority).toBe("admitted");
    expect(recovered.dispatchable).toBe(false);
    expect(recovered.holds).toContainEqual(
      expect.objectContaining({ code: "dependency_pending_integration", severity: "conditional" }),
    );
    expect(plans.getPlan(projectId, blocked.id).authority).toBe("held");

    const revoked = plans.revokePlan(projectId, recovered.id, { reason: "stop" });
    expect(revoked.authority).toBe("revoked");
    const sticky = await plans.importPlan(projectId, {
      work_id: await workIdFor(950),
      kind: "spec",
    });
    expect(sticky.id).toBe(recovered.id);
    expect(sticky.authority).toBe("revoked");
    expect(
      plans.listPlans(projectId).filter((plan) => plan.root_issue_number === 950),
    ).toHaveLength(2);
  });

  test("AC5: repeated import is idempotent and plan history is append-only", async () => {
    addIssue(800, ticketBody(), ["ready-for-agent"]);
    await importAll();
    const workId = await workIdFor(800);

    const first = await plans.importPlan(projectId, { work_id: workId, kind: "standalone" });
    const second = await plans.importPlan(projectId, { work_id: workId, kind: "standalone" });
    expect(second).toEqual(first);
    expect(plans.listPlans(projectId)).toHaveLength(1);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM plan_decisions").get() as { count: number },
    ).toEqual({ count: 1 });

    expect(() =>
      db
        .prepare("UPDATE plan_decisions SET reason = ? WHERE plan_id = ?")
        .run("tampered", first.id),
    ).toThrow(/plan_decisions_immutable/);
    expect(() => db.prepare("DELETE FROM plan_manifests WHERE plan_id = ?").run(first.id)).toThrow(
      /plan_manifests_immutable/,
    );
    expect(() => db.prepare("DELETE FROM plan_members WHERE plan_id = ?").run(first.id)).toThrow(
      /plan_members_immutable/,
    );
  });

  test("B1: duplicate acceptance-criterion keys hold explicitly instead of aborting storage", async () => {
    addIssue(1020, ticketBody({ rawCriteria: ["AC1: first copy", "AC1: second copy"] }), [
      "ready-for-agent",
    ]);
    await importAll();

    const plan = await plans.importPlan(projectId, {
      work_id: await workIdFor(1020),
      kind: "standalone",
    });

    expect(plan.authority).toBe("held");
    expect(plan.dispatchable).toBe(false);
    expect(plan.holds).toContainEqual(
      expect.objectContaining({
        code: "duplicate_acceptance_criteria",
        severity: "blocking",
        detail: expect.stringContaining("AC1"),
      }),
    );
    expect(
      plan.acceptance_criteria.filter((criterion) => criterion.work_id === plan.root_work_id),
    ).toHaveLength(1);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM plan_acceptance_criteria WHERE plan_id = ?")
        .get(plan.id),
    ).toEqual({ count: 1 });
    expect(plans.listPlans(projectId).map((summary) => summary.id)).toContain(plan.id);
  });

  test("B2: approving a held standalone plan preserves the import-time budget and graph identity", async () => {
    writeSchedule(7);
    addIssue(1030, ticketBody({ criteria: ["only criterion"] }), []);
    await importAll();

    const held = await plans.importPlan(projectId, {
      work_id: await workIdFor(1030),
      kind: "standalone",
    });
    expect(held.authority).toBe("held");
    expect(held.manifest).toBeNull();
    expect(held.holds).toContainEqual(
      expect.objectContaining({ code: "unlabeled_awaiting_triage", severity: "blocking" }),
    );

    writeSchedule(3);
    const approved = plans.approvePlan(projectId, held.id, { actor: "operator" });
    expect(approved.authority).toBe("admitted");
    expect(approved.dispatchable).toBe(true);
    const manifest = approved.manifest!;
    expect(manifest.budgets).toEqual({ max_laps: 7 });
    expect(manifest.graph_hash).toBe(approved.graph_hash);
    expect(computeGraphHash(graphFromManifest(manifest))).toBe(manifest.graph_hash);
  });

  test("B2: approving a held spec plan preserves coverage, budget and graph identity", async () => {
    writeSchedule(7);
    addIssue(1040, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(1041, ticketBody({ partOf: 1040, coverage: "AC1" }), ["ready-for-agent"]);
    addIssue(1042, ticketBody({ partOf: 1040, coverage: "AC2" }), []);
    await importAll();

    const held = await plans.importPlan(projectId, {
      work_id: await workIdFor(1040),
      kind: "spec",
    });
    expect(held.authority).toBe("held");
    expect(held.manifest).toBeNull();

    writeSchedule(3);
    const approved = plans.approvePlan(projectId, held.id, { actor: "operator" });
    expect(approved.authority).toBe("admitted");
    expect(approved.dispatchable).toBe(true);
    const manifest = approved.manifest!;
    expect(manifest.budgets).toEqual({ max_laps: 7 });
    expect(manifest.graph_hash).toBe(approved.graph_hash);
    expect(manifest.ac_coverage.map((group) => group.parent_ac_key)).toEqual(["AC1", "AC2"]);
    expect(computeGraphHash(graphFromManifest(manifest))).toBe(manifest.graph_hash);
  });

  test("B4: a spec with undiscoverable native children is held instead of admitted", async () => {
    addIssue(1050, specBody(["only criterion"]), ["ready-for-agent", "spec"]);
    addIssue(1051, ticketBody({ partOf: 1050, coverage: "AC1" }), ["ready-for-agent"]);
    addIssue(1052, ticketBody({ criteria: ["native child criterion"] }), ["ready-for-agent"]);
    await forge.addSubIssue(REPO, 1050, 1052);
    await importAll();

    const original = forge.getSubIssues.bind(forge);
    (forge as { getSubIssues?: unknown }).getSubIssues = undefined;
    try {
      const plan = await plans.importPlan(projectId, {
        work_id: await workIdFor(1050),
        kind: "spec",
      });
      expect(plan.authority).toBe("held");
      expect(plan.dispatchable).toBe(false);
      expect(plan.members.map((member) => member.issue_number)).toEqual([1050, 1051]);
      expect(plan.holds).toContainEqual(
        expect.objectContaining({
          code: "incomplete_child_discovery",
          severity: "blocking",
          detail: expect.stringContaining("Native sub-issue discovery is unavailable"),
        }),
      );
    } finally {
      forge.getSubIssues = original;
    }
  });

  test("B4: a native child discovery transport failure holds the spec", async () => {
    addIssue(1060, specBody(["only criterion"]), ["ready-for-agent", "spec"]);
    addIssue(1061, ticketBody({ partOf: 1060, coverage: "AC1" }), ["ready-for-agent"]);
    await importAll();

    const original = forge.getSubIssues.bind(forge);
    forge.getSubIssues = async () => {
      throw new Error("native discovery offline");
    };
    try {
      const plan = await plans.importPlan(projectId, {
        work_id: await workIdFor(1060),
        kind: "spec",
      });
      expect(plan.authority).toBe("held");
      expect(plan.dispatchable).toBe(false);
      expect(plan.holds).toContainEqual(
        expect.objectContaining({
          code: "incomplete_child_discovery",
          severity: "blocking",
          detail: expect.stringContaining("Native sub-issue discovery failed"),
        }),
      );
    } finally {
      forge.getSubIssues = original;
    }
  });

  test("AC5: prerequisite integration must reach the plan's frozen target, not an arbitrary branch", async () => {
    addIssue(1070, ticketBody({ dependsOn: [1071] }), ["ready-for-agent"]);
    addIssue(1071, ticketBody({ criteria: ["prerequisite criterion"] }), ["ready-for-agent"]);
    await importAll();

    const dependent = await plans.importPlan(projectId, {
      work_id: await workIdFor(1070),
      kind: "standalone",
    });
    expect(dependent.dispatchable).toBe(false);

    execFileSync("git", ["-C", checkoutPath, "checkout", "-q", "-b", "random/isolated"]);
    writeFileSync(join(checkoutPath, "isolated.txt"), "isolated");
    execFileSync("git", ["-C", checkoutPath, "add", "isolated.txt"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "-q", "-m", "isolated"]);
    const isolatedSha = execFileSync("git", ["-C", checkoutPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    execFileSync("git", ["-C", checkoutPath, "checkout", "-q", "main"]);
    work.recordBranchIntegration(projectId, 1071, "random/isolated", isolatedSha);

    const stillHeld = plans.getPlan(projectId, dependent.id);
    expect(stillHeld.dispatchable).toBe(false);
    expect(stillHeld.holds).toContainEqual(
      expect.objectContaining({
        code: "dependency_pending_integration",
        severity: "conditional",
      }),
    );

    writeFileSync(join(checkoutPath, "integrated.txt"), "integrated");
    execFileSync("git", ["-C", checkoutPath, "add", "integrated.txt"]);
    execFileSync("git", ["-C", checkoutPath, "commit", "-q", "-m", "integrated"]);
    const mainSha = execFileSync("git", ["-C", checkoutPath, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();
    work.recordBranchIntegration(projectId, 1071, "main", mainSha);

    const released = plans.getPlan(projectId, dependent.id);
    expect(released.dispatchable).toBe(true);
    expect(released.holds).toEqual([]);
  });

  test("AC4: revocation cannot be resurrected by history replay, re-import or stale approval", async () => {
    addIssue(1080, specBody(["first", "second"]), ["ready-for-agent", "spec"]);
    addIssue(1081, ticketBody({ partOf: 1080, coverage: "AC1" }), ["ready-for-agent"]);
    addIssue(1082, ticketBody({ partOf: 1080, coverage: "AC2" }), ["ready-for-agent"]);
    await importAll();

    const admitted = await plans.importPlan(projectId, {
      work_id: await workIdFor(1080),
      kind: "spec",
    });
    expect(admitted.authority).toBe("admitted");

    const revoked = plans.revokePlan(projectId, admitted.id, {
      actor: "operator",
      reason: "withdrawn",
    });
    expect(revoked.authority).toBe("revoked");
    expect(revoked.dispatchable).toBe(false);

    const stale = plans.approvePlan(projectId, admitted.id, {
      actor: "operator",
      reason: "replayed approval",
    });
    expect(stale.authority).toBe("revoked");
    expect(stale.decisions.map((decision) => decision.action)).toEqual(["import", "revoke"]);

    addIssue(1081, ticketBody({ partOf: 1080, coverage: "AC1" }), ["ready-for-agent"]);
    await importAll();
    const reimported = await plans.importPlan(projectId, {
      work_id: await workIdFor(1080),
      kind: "spec",
    });
    expect(reimported.id).toBe(admitted.id);
    expect(reimported.authority).toBe("revoked");
    expect(reimported.dispatchable).toBe(false);

    const reauthorized = plans.approvePlan(projectId, admitted.id, {
      actor: "operator",
      reason: "new scope authorization",
      expected_sequence: revoked.decisions.at(-1)!.sequence,
    });
    expect(reauthorized.authority).toBe("admitted");
    expect(reauthorized.dispatchable).toBe(true);
    expect(reauthorized.decisions.map((decision) => decision.action)).toEqual([
      "import",
      "revoke",
      "approve",
    ]);
    expect(reauthorized.decisions.at(-1)).toMatchObject({
      sequence: 3,
      action: "approve",
      outcome: "admitted",
      source: "operator",
    });
  });
});
