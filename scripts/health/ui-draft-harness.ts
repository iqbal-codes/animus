/**
 * Runtime UI verification harness for the operator draft review surface.
 *
 * Boots the real backend application (same kernel the CLI and tests use) with:
 *   - a real temporary SQLite console database,
 *   - a real temporary git checkout and a synthetic (offline) forge,
 *   - the built web console served from apps/web/dist,
 * and seeds genuine drafts through the real draft planning transport seam.
 *
 * No production fixture mode and no mock UI store: the browser talks to the
 * same HTTP API the CLI uses. This script exists only for manual capture
 * evidence and is not part of the shipped runtime.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DraftPlan } from "@animus/contracts/operator";
import type { DraftPlanner, DraftPlanningRequest } from "../../apps/backend/src/draft";
import { createBackendApp, type BackendApp } from "../../apps/backend/src/main";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { IntakeService } from "../../apps/backend/src/intake";

const REPO = "owner/repo";
const root = fileURLToPath(new URL("../../", import.meta.url));
const webDir = join(root, "apps/web/dist");

const boundary = {
  touchpoints: "apps/web/src/features/drafts",
  known_callers: "App shell navigation, shared client",
  test_seam: "tests/integration/drafts-ui.test.tsx",
  exclusions: "real draft planning transport",
};

function standalonePlan(title: string, acIds: string[]): DraftPlan {
  const body = [
    "## Source and problem",
    "The reporter asked for a small, bounded console change.",
    "",
    "## Outcome",
    "The change is visible and verified.",
    "",
    "## Invariants",
    "- Existing console behavior remains intact.",
    "",
    "## Acceptance criteria",
    ...acIds.map((id) => `- [ ] ${id}: ${title} works.`),
    "",
    "## Boundary",
    "- **Touchpoints**: apps/web/src/features",
    "- **Known callers**: App shell navigation",
    "- **Test seam**: tests/integration/drafts-ui.test.tsx",
    "- **Exclusions**: real draft planning transport",
    "",
    "## Verification",
    "- targeted integration test",
    "",
    "Depends on: None",
  ].join("\n");
  return {
    kind: "standalone",
    title,
    scope: "Add a bounded console affordance.",
    outcome: "The affordance is available to operators.",
    invariants: ["Existing console behavior remains intact."],
    acceptance_criteria: acIds.map((id) => ({
      id,
      description: `${title} works.`,
      verification: "Targeted integration test",
    })),
    verification_requirements: ["targeted integration test"],
    boundary,
    depends_on: [],
    body,
    prepared: false,
  };
}

function specPlan(): DraftPlan {
  const parentBody = [
    "## Source and problem",
    "The request spans two dependent slices.",
    "",
    "## Outcome",
    "Both slices ship together.",
    "",
    "## Invariants",
    "- Delivery stays ordered.",
    "",
    "## Acceptance criteria",
    "- [ ] AC1: Queue renders real drafts.",
    "- [ ] AC2: Decisions bind to a revision.",
    "",
    "## Boundary",
    "- **Touchpoints**: console",
    "- **Known callers**: shell",
    "- **Test seam**: targeted tests",
    "- **Exclusions**: runtime planner",
    "",
    "## Verification",
    "- targeted integration test",
    "",
    "Depends on: None",
  ].join("\n");
  const childBody = (id: string) =>
    [
      "## Source and problem",
      "Slice of the console draft review feature.",
      "",
      "## Outcome",
      "Slice behaves.",
      "",
      "## Invariants",
      "- Slice does not regress.",
      "",
      "## Acceptance criteria",
      `- [ ] ${id}: Slice works.`,
      "",
      "## Boundary",
      "- **Touchpoints**: console",
      "- **Known callers**: shell",
      "- **Test seam**: targeted tests",
      "- **Exclusions**: runtime planner",
      "",
      "## Verification",
      "- targeted integration test",
      "",
      "Depends on: None",
    ].join("\n");
  return {
    kind: "spec",
    title: "Ship the console draft review surface",
    scope: "A queue and detail surface for imported work.",
    outcome: "Operators review and decide on drafts.",
    invariants: ["Delivery stays ordered."],
    acceptance_criteria: [
      { id: "AC1", description: "Queue renders real drafts.", verification: "Targeted test" },
      { id: "AC2", description: "Decisions bind to a revision.", verification: "Targeted test" },
    ],
    verification_requirements: ["targeted integration test"],
    boundary,
    depends_on: [],
    body: parentBody,
    children: [
      {
        id: "C1",
        title: "Render the draft queue",
        scope: "Queue.",
        outcome: "Queue is visible.",
        invariants: ["No fixture data."],
        acceptance_criteria: [
          { id: "AC1", description: "Queue renders.", verification: "Targeted test" },
        ],
        verification_requirements: ["targeted test"],
        boundary,
        depends_on: [],
        body: childBody("AC1"),
        depends_on_indices: [],
        covers_parent_ac_ids: ["AC1"],
      },
      {
        id: "C2",
        title: "Bind decisions to revisions",
        scope: "Decisions.",
        outcome: "Decisions are revision-bound.",
        invariants: ["Stale decisions refuse."],
        acceptance_criteria: [
          { id: "AC2", description: "Decisions bind.", verification: "Targeted test" },
        ],
        verification_requirements: ["targeted test"],
        boundary,
        depends_on: [],
        body: childBody("AC2"),
        depends_on_indices: [0],
        covers_parent_ac_ids: ["AC2"],
      },
    ],
  };
}

function clarificationPlan(): DraftPlan {
  return {
    kind: "clarification",
    reason: "The desired onboarding outcome is a product decision.",
    questions: [
      {
        id: "q1",
        question: "Which onboarding outcome matters most?",
        reason: "The repository cannot infer product priority.",
      },
      {
        id: "q2",
        question: "Should the change ship behind a flag?",
        reason: "Rollout policy is an operator decision.",
      },
    ],
  };
}

const plans: Record<number, DraftPlan> = {
  21: clarificationPlan(),
  22: standalonePlan("Add a keyboard shortcut to open drafts", ["AC1", "AC2"]),
  23: specPlan(),
};

const resolvedPlans: Record<number, DraftPlan> = {
  21: standalonePlan("Clarify onboarding with a guided first step", ["AC1", "AC2"]),
};

const revisedPlans: Record<number, DraftPlan> = {
  21: standalonePlan("Clarify onboarding with a revised guided first step", ["AC1", "AC2"]),
  23: { ...specPlan(), title: "Ship the revised console draft review surface" } as DraftPlan,
};

const planner: DraftPlanner = async (request: DraftPlanningRequest) => {
  const issueNumber = request.work.revision.provenance.issue_number;
  // Once the operator has answered the clarification, produce the reviewable
  // plan — a realistic two-step refinement through the real planning seam.
  const answered = (request.prior?.answers.length ?? 0) > 0;
  const revising = (request.prior?.instructions ?? "").trim().length > 0;
  const plan =
    (revising ? revisedPlans[issueNumber] : undefined) ??
    (answered ? resolvedPlans[issueNumber] : undefined) ??
    plans[issueNumber];
  if (!plan) throw new Error(`No runtime harness plan for issue ${issueNumber}`);
  return {
    plan,
    metadata: {
      transport: "agent",
      prompt: "draft",
      provider: "harness",
      model: "harness",
      effort: null,
      accepted_ref: null,
    },
  };
};

function makeCheckout(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Harness"], { cwd: path });
  execFileSync("git", ["config", "user.email", "harness@test.local"], { cwd: path });
  execFileSync("git", ["remote", "add", "origin", `https://github.com/${REPO}.git`], { cwd: path });
  writeFileSync(join(path, "README.md"), "# Harness product\n", "utf-8");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["commit", "-q", "-m", "baseline"], { cwd: path });
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), "animus-ui-harness-"));
  const checkout = join(stateDir, "checkout");
  makeCheckout(checkout);

  const forge = new SyntheticForgeAdapter({ [REPO]: 501 });
  const issues: Array<{ number: number; title: string; body: string }> = [
    { number: 21, title: "Improve onboarding clarity", body: "Please improve onboarding." },
    {
      number: 22,
      title: "Add a keyboard shortcut to open drafts",
      body: "Operators should reach drafts quickly from the keyboard.",
    },
    {
      number: 23,
      title: "Ship the console draft review surface",
      body: "Build a real queue and detail surface for reviewing drafts.",
    },
  ];
  for (const issue of issues) {
    forge.addIssue(REPO, {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: "OPEN",
      labels: [{ name: "needs-triage" }],
      comments: [],
    });
  }

  const app: BackendApp = await createBackendApp({
    stateDir,
    startMonitor: false,
    forge,
    draftPlanner: planner,
    webDir,
    config: { buildId: "ui-harness" },
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

  // Seed one draft per issue through the real HTTP API, then approve one so the
  // capture shows an approved, publishable revision next to pending review.
  const refine = async (issueNumber: number) => {
    const workId = workByIssue.get(issueNumber);
    if (!workId) throw new Error(`No work imported for issue ${issueNumber}`);
    const response = await app.fetch(
      new Request(`http://127.0.0.1/api/v1/projects/${project.id}/drafts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ work_id: workId, answers: [] }),
      }),
    );
    if (response.status !== 200) {
      throw new Error(
        `Draft refine ${issueNumber} failed: ${response.status} ${await response.text()}`,
      );
    }
    return (await response.json()) as { id: string; latest_revision: { id: string } };
  };

  const approved = await refine(22);
  await app.fetch(
    new Request(`http://127.0.0.1/api/v1/projects/${project.id}/drafts/${approved.id}/decisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({
        revision_id: approved.latest_revision.id,
        decision: "approve",
        reason: "Scope matches the request",
      }),
    }),
  );
  await refine(21);
  await refine(23);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return app.fetch(request);
    },
    websocket: app.websocket,
  });

  console.log(
    JSON.stringify({ url: server.url.origin, project_id: project.id, state_dir: stateDir }),
  );

  const shutdown = async () => {
    await server.stop(true);
    await app.stop();
    rmSync(stateDir, { recursive: true, force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

await main();
