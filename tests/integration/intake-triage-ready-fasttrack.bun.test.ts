import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import type { DraftPlanner } from "../../apps/backend/src/draft";

const REPO = "owner/repo";

function canonicalTicket(title: string, criteria: string[] = ["AC1: First criterion"]): string {
  return [
    "## Source and problem",
    "",
    `Problem description for ${title}`,
    "",
    "## Outcome",
    "",
    `Target outcome for ${title}`,
    "",
    "## Invariants",
    "",
    "- Zero regressions on existing contracts.",
    "",
    "## Acceptance criteria",
    "",
    ...criteria.map((c) => `- [ ] ${c}`),
    "",
    "## Boundary",
    "",
    "Only affects local target module.",
    "",
    "## Verification",
    "",
    "- bun test",
    "",
    "Depends on: None",
  ].join("\n");
}

describe("Intake -> Triage -> Ready Fast-Track & Direct Jobs", () => {
  let root: string;
  let checkoutPath: string;
  let app: BackendApp;
  let forge: SyntheticForgeAdapter;
  let projectId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-fasttrack-"));
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init"], { cwd: checkoutPath });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: checkoutPath });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: checkoutPath });

    mkdirSync(join(checkoutPath, ".agents/skills/animus-triage"), { recursive: true });
    writeFileSync(
      join(checkoutPath, ".agents/skills/animus-triage/SKILL.md"),
      "# animus-triage\nTriage playbook",
      "utf-8",
    );

    forge = new SyntheticForgeAdapter({ [REPO]: 101 });
    execFileSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], {
      cwd: checkoutPath,
    });

    const mockDraftPlanner: DraftPlanner = async (req) => ({
      plan: {
        kind: "standalone",
        title: req.work.revision.source.title,
        scope: "Implement the requested change.",
        outcome: "Requirements are fully met.",
        invariants: ["Zero regressions."],
        acceptance_criteria: [
          { id: "AC1", description: "First criterion", verification: "bun test" },
        ],
        verification_requirements: ["bun test"],
        boundary: {
          touchpoints: "apps/backend/src/target.ts",
          known_callers: "none",
          test_seam: "tests/integration/target.test.ts",
          exclusions: "unrelated work",
        },
        depends_on: [],
        body: canonicalTicket(req.work.revision.source.title),
        prepared: false,
      },
      metadata: {
        transport: "prepared",
        prompt: "Plan draft for task",
        provider: "test",
        model: "test",
        effort: "medium",
        accepted_ref: "HEAD",
      },
    });

    app = await createBackendApp({
      forge,
      stateDir: root,
      origin: "http://127.0.0.1",
      draftPlanner: mockDraftPlanner,
    });

    const registry = new ProjectRegistryService(app.db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "FastTrack Project",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("AC1: Canonical issue with ready-for-agent is automatically fast-tracked to an admitted plan", async () => {
    forge.addIssue(REPO, {
      number: 42,
      title: "Canonical Pre-decomposed Ticket",
      state: "OPEN",
      body: canonicalTicket("Canonical Pre-decomposed Ticket"),
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });

    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: (input, init) => app.fetch(input, init),
    }).forProject(projectId);

    // Call intake
    const intake = await client.intake({ refresh: true });
    expect(intake.issues).toHaveLength(1);
    expect(intake.issues[0]!.admission_status).toBe("admitted");

    // Board query immediately reflects it in Ready lane
    const board = await client.board();
    const readyCards = board.lanes.find((c) => c.id === "ready")?.cards ?? [];
    expect(readyCards.some((c) => c.issueNumber === 42)).toBe(true);
  });

  test("AC2: Direct job creation via API creates local work item without touching GitHub forge", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: (input, init) => app.fetch(input, init),
    }).forProject(projectId);

    const issuesBefore = await forge.listIssues(REPO);

    const result = await client.createJob({
      title: "Direct Job from Animus",
      prompt: "Please add validation middleware for user authentication",
    });

    expect(result.work).toBeDefined();
    expect(result.issue_number).toBeGreaterThanOrEqual(10001);
    expect(result.work.revision.source.title).toBe("Direct Job from Animus");

    // No GitHub issues were created
    const issuesAfter = await forge.listIssues(REPO);
    expect(issuesAfter).toHaveLength(issuesBefore.length);

    // Board reflects the job in triage lane awaiting draft refinement
    const board = await client.board();
    const triageCards = board.lanes.find((c) => c.id === "triage")?.cards ?? [];
    expect(triageCards.some((c) => c.issueNumber === result.issue_number)).toBe(true);
  });

  test("AC3: Direct draft admission admits to plan without creating remote GitHub issues", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1",
      fetch: (input, init) => app.fetch(input, init),
    }).forProject(projectId);

    const createdJob = await client.createJob({
      title: "Self-contained Task",
      prompt: "Write unit test for math helper",
    });

    // Refine into a standalone draft
    const draft = await client.refineDraft({
      work_id: createdJob.work.id,
      answers: [],
    });
    expect(draft.latest_revision.kind).toBe("standalone");

    const issuesBefore = await forge.listIssues(REPO);

    // Directly admit the draft to plan
    const admittedPlan = await client.admitDraft(draft.id);
    expect(admittedPlan.authority).toBe("admitted");
    expect(admittedPlan.kind).toBe("standalone");

    // No issues created on forge
    const issuesAfter = await forge.listIssues(REPO);
    expect(issuesAfter).toHaveLength(issuesBefore.length);

    // Board query now shows it in the Ready lane!
    const board = await client.board();
    const readyCards = board.lanes.find((c) => c.id === "ready")?.cards ?? [];
    expect(readyCards.some((c) => c.issueNumber === createdJob.issue_number)).toBe(true);
  });
});
