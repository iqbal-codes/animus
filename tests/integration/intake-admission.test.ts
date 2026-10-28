import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import {
  IntakeService,
  TargetBindingError,
  handleProjectIntakeRoute,
  parseTicketSections,
  formatTicketMarkdown,
  computeDiff,
  computeLabelEffects,
} from "../../apps/backend/src/intake";
import { createFactoryClient } from "@labq/client";
import {
  intakePreviewResultSchema,
  intakePublishResultSchema,
  evaluatedIssueSchema,
  targetBindingResultSchema,
  branchIntegrationResultSchema,
} from "@labq/contracts/operator";

type DatabaseInstance = ReturnType<typeof initializeDatabase>;

describe("Structured Intake, Admission Gate & Exact-Target Enforcement (Issue #61)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseInstance;
  let forge: SyntheticForgeAdapter;
  let registry: ProjectRegistryService;
  let intake: IntakeService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "labq-intake-test-"));
    dbPath = join(tempDir, "state", "console.db");
    db = initializeDatabase(dbPath);
    forge = new SyntheticForgeAdapter({
      "owner/repo-alpha": 101,
      "owner/repo-beta": 102,
    });
    registry = new ProjectRegistryService(db, forge);
    intake = new IntakeService(db, forge);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockCheckout(name: string, remoteRepo = "owner/repo-alpha"): string {
    const checkoutPath = join(tempDir, name);
    mkdirSync(join(checkoutPath, ".git"), { recursive: true });
    writeFileSync(
      join(checkoutPath, ".git", "config"),
      `[remote "origin"]\n  url = https://github.com/${remoteRepo}.git\n`,
    );
    return checkoutPath;
  }

  describe("AC1 (Parent AC07): Structured Intake, Parser & Diff Previews", () => {
    test("parser extracts Archon / Software Factory contract sections and formats markdown cleanly", () => {
      const markdown = `Part of #58

## Source and problem
Spec #58 section Intake. Problem with unverified admission.

## Outcome
Structured intake with admission gate.

## Invariants
- Admission precedes execution.
- Exact-target binding.

## Acceptance criteria
- [ ] AC1: Structured diff preview verified.
- [ ] AC2: Admission gate verifies dependencies.

## Boundary
Excludes execution engine.

Depends on: #59, #60
`;

      const parsed = parseTicketSections(markdown);
      expect(parsed.partOf).toBe(58);
      expect(parsed.sourceProblem).toContain("Spec #58 section Intake");
      expect(parsed.outcome).toBe("Structured intake with admission gate.");
      expect(parsed.invariants).toEqual(["Admission precedes execution.", "Exact-target binding."]);
      expect(parsed.acceptanceCriteria).toEqual([
        "AC1: Structured diff preview verified.",
        "AC2: Admission gate verifies dependencies.",
      ]);
      expect(parsed.boundary).toContain("Excludes execution engine.");
      expect(parsed.dependsOn).toEqual([59, 60]);

      // Formatter round-trip
      const formatted = formatTicketMarkdown(parsed);
      expect(formatted).toContain("Part of #58");
      expect(formatted).toContain("## Source and problem");
      expect(formatted).toContain("Depends on: #59, #60");

      // computeDiff utility
      const diff = computeDiff("Title Alpha", "Title Beta");
      expect(diff).toContain("- Title Alpha");
      expect(diff).toContain("+ Title Beta");

      const noDiff = computeDiff("Same", "Same");
      expect(noDiff).toBeNull();

      // computeLabelEffects
      const effects = computeLabelEffects(
        ["ready-for-agent", "needs-info"],
        ["ready-for-agent", "wontfix"],
      );
      expect(effects.added_labels).toEqual(["wontfix"]);
      expect(effects.removed_labels).toEqual(["needs-info"]);
    });

    test("generates structured preview for proposed new ticket with target repo and label effects", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      const preview = await intake.previewProjectIntake(project.id, {
        title: "feat(auth): add OAuth2 provider",
        body: `## Source and problem\nNeed SSO.\n\n## Outcome\nOAuth2 enabled.\n\nDepends on: None`,
        labels: ["ready-for-agent"],
      });

      expect(preview.target_repo).toBe("owner/repo-alpha");
      expect(preview.target_issue_number).toBeNull();
      expect(preview.title).toBe("feat(auth): add OAuth2 provider");
      expect(preview.title_diff).toBeNull();
      expect(preview.body_diff).toBeNull();
      expect(preview.label_effects.added_labels).toEqual(["ready-for-agent"]);
      expect(preview.label_effects.removed_labels).toEqual([]);
      expect(preview.admission_preview.status).toBe("admitted");
      expect(preview.admission_preview.reason).toBe("admitted_ready");
      expect(intakePreviewResultSchema.parse(preview)).toEqual(preview);
    });

    test("generates structured diff preview for updating existing ticket with title/body diff and label effects", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 42,
        title: "feat(auth): old title",
        state: "OPEN",
        body: "Old body description\nDepends on: None",
        labels: [{ name: "needs-info" }],
      });

      const preview = await intake.previewProjectIntake(project.id, {
        issue_number: 42,
        title: "feat(auth): new updated title",
        body: "New updated body description\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      expect(preview.target_repo).toBe("owner/repo-alpha");
      expect(preview.target_issue_number).toBe(42);
      expect(preview.title_diff).toContain("- feat(auth): old title");
      expect(preview.title_diff).toContain("+ feat(auth): new updated title");
      expect(preview.body_diff).toContain("- Old body description");
      expect(preview.body_diff).toContain("+ New updated body description");
      expect(preview.label_effects.added_labels).toEqual(["ready-for-agent"]);
      expect(preview.label_effects.removed_labels).toEqual(["needs-info"]);
      expect(preview.admission_preview.status).toBe("admitted");
      expect(preview.admission_preview.reason).toBe("admitted_ready");
    });

    test("publishes new ticket to target repo and evaluates admission immediately", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      const published = await intake.publishProjectTicket(project.id, {
        title: "feat(queue): implement durable redis queue",
        body: "## Source and problem\nQueue needed.\n\nDepends on: None",
        labels: ["ready-for-agent"],
      });

      expect(published.repo).toBe("owner/repo-alpha");
      expect(published.issue.number).toBe(1);
      expect(published.issue.title).toBe("feat(queue): implement durable redis queue");
      expect(published.issue.admission_status).toBe("admitted");
      expect(published.issue.reason).toBe("admitted_ready");
      expect(intakePublishResultSchema.parse(published)).toEqual(published);

      // Verify issue exists on forge
      const onForge = await forge.getIssue("owner/repo-alpha", 1);
      expect(onForge?.title).toBe("feat(queue): implement durable redis queue");
    });

    test("updates existing ticket on forge and re-evaluates admission", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 5,
        title: "WIP Task",
        state: "OPEN",
        body: "Under review\nDepends on: None",
        labels: [{ name: "needs-info" }],
      });

      // Initially held
      const initial = await intake.getProjectIssue(project.id, 5);
      expect(initial.admission_status).toBe("held");
      expect(initial.reason).toBe("held_by_label");

      // Update to ready-for-agent
      const updated = await intake.updateProjectTicket(project.id, 5, {
        title: "Ready Task",
        labels: ["ready-for-agent"],
      });

      expect(updated.title).toBe("Ready Task");
      expect(updated.admission_status).toBe("admitted");
      expect(updated.reason).toBe("admitted_ready");
      expect(evaluatedIssueSchema.parse(updated)).toEqual(updated);
    });

    test("parent spec and planning-only records remain planning-only and held", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 58,
        title: "Spec: Web console multi-repository architecture",
        state: "OPEN",
        body: "Parent planning document.\nDepends on: None",
        labels: [{ name: "needs-triage" }],
      });

      const issue = await intake.getProjectIssue(project.id, 58);
      expect(issue.admission_status).toBe("held");
      expect(issue.reason).toBe("held_by_label");
    });
  });

  describe("AC2 (Parent AC08, P1): Canonical Admission Gate", () => {
    test("admits open issue with ready-for-agent, zero blocking/exclusion labels, and satisfied dependencies", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 10,
        title: "Prereq Task",
        state: "CLOSED",
      });
      forge.addIssue("owner/repo-alpha", {
        number: 11,
        title: "Executable Task",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "Depends on: #10",
      });

      const issue = await intake.getProjectIssue(project.id, 11);
      expect(issue.admission_status).toBe("admitted");
      expect(issue.reason).toBe("admitted_ready");
    });

    test("admits child issue when open dependency has verified integrated_to_branch status", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      // Dependency #10 is still OPEN on GitHub!
      forge.addIssue("owner/repo-alpha", {
        number: 10,
        title: "Unmerged Prerequisite",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
      });
      forge.addIssue("owner/repo-alpha", {
        number: 11,
        title: "Subticket Waiting on #10",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "Depends on: #10",
      });

      // Initially #11 is held waiting on #10
      const initial = await intake.getProjectIssue(project.id, 11);
      expect(initial.admission_status).toBe("held");
      expect(initial.reason).toBe("waiting_on_dependency:#10");
      expect(initial.unsatisfied_dependencies).toEqual([10]);

      // Record verified branch integration for #10 in project Alpha
      const integration = intake.recordBranchIntegration(
        project.id,
        10,
        "feat/spec-integration-branch",
        "abc12345def",
      );
      expect(integration.branch).toBe("feat/spec-integration-branch");
      expect(branchIntegrationResultSchema.parse(integration)).toEqual(integration);

      // Now #11 evaluates again with verified integrated_to_branch status -> ADMITTED!
      const afterIntegration = await intake.getProjectIssue(project.id, 11);
      expect(afterIntegration.admission_status).toBe("admitted");
      expect(afterIntegration.reason).toBe("admitted_ready");
      expect(afterIntegration.unsatisfied_dependencies).toEqual([]);
    });

    test("blocks admission on blocking labels (needs-info, ready-for-human, needs-triage)", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      for (const blockingLabel of ["needs-info", "ready-for-human", "needs-triage"]) {
        forge.addIssue("owner/repo-alpha", {
          number: 21,
          title: `Task with ${blockingLabel}`,
          state: "OPEN",
          labels: [{ name: "ready-for-agent" }, { name: blockingLabel }],
        });

        const issue = await intake.getProjectIssue(project.id, 21);
        expect(issue.admission_status).toBe("held");
        expect(issue.reason).toBe("held_by_label");
      }
    });

    test("strictly excludes issue on wontfix label even if ready-for-agent is present", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 30,
        title: "Rejected Feature",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }, { name: "wontfix" }],
      });

      const issue = await intake.getProjectIssue(project.id, 30);
      expect(issue.admission_status).toBe("excluded");
      expect(issue.reason).toBe("excluded_by_label");
    });

    test("holds issue when active claim exists in comments or body", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      // Claim in comments
      forge.addIssue("owner/repo-alpha", {
        number: 40,
        title: "Claimed Issue",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        comments: [{ body: "Loop claim: run lap-claim-8822" }],
      });

      const issue = await intake.getProjectIssue(project.id, 40);
      expect(issue.admission_status).toBe("held");
      expect(issue.reason).toBe("actively_claimed");

      // Claim in body
      forge.addIssue("owner/repo-alpha", {
        number: 41,
        title: "Body Claimed Issue",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "Loop claim: run lap-claim-9911\nDepends on: None",
      });

      const bodyClaimed = await intake.getProjectIssue(project.id, 41);
      expect(bodyClaimed.admission_status).toBe("held");
      expect(bodyClaimed.reason).toBe("actively_claimed");
    });

    test("legacy factory:* labels have zero authority", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 50,
        title: "Legacy Label Issue",
        state: "OPEN",
        labels: [{ name: "factory:ready" }],
      });

      const issue = await intake.getProjectIssue(project.id, 50);
      expect(issue.admission_status).toBe("held");
      expect(issue.reason).toBe("missing_ready_label");
    });
  });

  describe("AC3 (Parent AC08, P1): Exact Target Binding & Fail-Closed Enforcement", () => {
    test("verifies exact target binding when remote forge matches admitted state", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 100,
        title: "Ready Task",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
      });

      const bound = await intake.bindProjectTarget(project.id, 100, {
        expected_state: "OPEN",
        expected_labels: ["ready-for-agent"],
        expected_admission_status: "admitted",
      });

      expect(bound.bound).toBe(true);
      expect(bound.project_id).toBe(project.id);
      expect(bound.repo_name).toBe("owner/repo-alpha");
      expect(bound.issue_number).toBe(100);
      expect(bound.state).toBe("OPEN");
      expect(bound.admission_status).toBe("admitted");
      expect(targetBindingResultSchema.parse(bound)).toEqual(bound);
    });

    test("fails closed (rejects with target_drift) if remote issue state changes to CLOSED before dispatch", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 101,
        title: "Race Condition Issue",
        state: "CLOSED", // changed to closed remotely!
        labels: [{ name: "ready-for-agent" }],
      });

      await expect(
        intake.bindProjectTarget(project.id, 101, {
          expected_state: "OPEN",
          expected_labels: ["ready-for-agent"],
          expected_admission_status: "admitted",
        }),
      ).rejects.toThrow(TargetBindingError);
    });

    test("fails closed if remote issue labels change between admission and dispatch", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      // Operator remotely added needs-info after admission was evaluated
      forge.addIssue("owner/repo-alpha", {
        number: 102,
        title: "Mutated Labels Issue",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }, { name: "needs-info" }],
      });

      let errorCaught: TargetBindingError | null = null;
      try {
        await intake.bindProjectTarget(project.id, 102, {
          expected_state: "OPEN",
          expected_labels: ["ready-for-agent"],
          expected_admission_status: "admitted",
        });
      } catch (err: any) {
        errorCaught = err;
      }

      expect(errorCaught).not.toBeNull();
      expect(errorCaught?.code).toBe("target_drift");
      expect(errorCaught?.message).toContain("Label drift");
    });

    test("fails closed if active claim was added remotely before dispatch", async () => {
      const checkoutPath = createMockCheckout("co-alpha", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Alpha Project",
        checkout_path: checkoutPath,
      });

      forge.addIssue("owner/repo-alpha", {
        number: 103,
        title: "Claimed mid-flight",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        comments: [{ body: "Loop claim: run another-runner-999" }],
      });

      let errorCaught: TargetBindingError | null = null;
      try {
        await intake.bindProjectTarget(project.id, 103, {
          expected_state: "OPEN",
          expected_labels: ["ready-for-agent"],
          expected_admission_status: "admitted",
        });
      } catch (err: any) {
        errorCaught = err;
      }

      expect(errorCaught).not.toBeNull();
      expect(errorCaught?.code).toBe("target_drift");
      expect(errorCaught?.message).toContain("Admission status drift");
    });
  });

  describe("AC4 (Parent AC08, P1): Cross-Repository Edge Cases & Target Partitioning", () => {
    test("validates issues sharing identical numbers across distinct project repositories are never conflated", async () => {
      // Register Project Alpha (repo-alpha)
      const checkoutAlpha = createMockCheckout("co-alpha", "owner/repo-alpha");
      const projectAlpha = await registry.registerProject({
        method: "local_checkout",
        name: "Project Alpha",
        checkout_path: checkoutAlpha,
      });

      // Register Project Beta (repo-beta)
      const checkoutBeta = createMockCheckout("co-beta", "owner/repo-beta");
      const projectBeta = await registry.registerProject({
        method: "local_checkout",
        name: "Project Beta",
        checkout_path: checkoutBeta,
      });

      // Both repositories have Issue #10 and Issue #20!
      // In Repo Beta: Issue #10 is CLOSED. Issue #20 depends on #10.
      forge.addIssue("owner/repo-beta", {
        number: 10,
        title: "Beta Prereq",
        state: "CLOSED",
      });
      forge.addIssue("owner/repo-beta", {
        number: 20,
        title: "Beta Dependent Task",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "Depends on: #10",
      });

      // In Repo Alpha: Issue #10 is OPEN! Issue #20 depends on #10.
      forge.addIssue("owner/repo-alpha", {
        number: 10,
        title: "Alpha Prereq (Still Open!)",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
      });
      forge.addIssue("owner/repo-alpha", {
        number: 20,
        title: "Alpha Dependent Task",
        state: "OPEN",
        labels: [{ name: "ready-for-agent" }],
        body: "Depends on: #10",
      });

      // 1. Evaluate Project Alpha: Issue #20 MUST BE HELD!
      // Beta's closed #10 must NEVER satisfy Alpha's dependency #10!
      const alphaIssue20 = await intake.getProjectIssue(projectAlpha.id, 20);
      expect(alphaIssue20.admission_status).toBe("held");
      expect(alphaIssue20.reason).toBe("waiting_on_dependency:#10");
      expect(alphaIssue20.unsatisfied_dependencies).toEqual([10]);

      // 2. Evaluate Project Beta: Issue #20 MUST BE ADMITTED!
      const betaIssue20 = await intake.getProjectIssue(projectBeta.id, 20);
      expect(betaIssue20.admission_status).toBe("admitted");
      expect(betaIssue20.reason).toBe("admitted_ready");
      expect(betaIssue20.unsatisfied_dependencies).toEqual([]);

      // 3. Branch integration in Project Beta does NOT satisfy Project Alpha
      intake.recordBranchIntegration(projectBeta.id, 10, "feat/beta-branch");
      const alphaStillHeld = await intake.getProjectIssue(projectAlpha.id, 20);
      expect(alphaStillHeld.admission_status).toBe("held");

      // 4. Branch integration in Project Alpha satisfies Alpha, leaves Beta unaffected
      intake.recordBranchIntegration(projectAlpha.id, 10, "feat/alpha-branch");
      const alphaNowAdmitted = await intake.getProjectIssue(projectAlpha.id, 20);
      expect(alphaNowAdmitted.admission_status).toBe("admitted");
      expect(alphaNowAdmitted.reason).toBe("admitted_ready");

      // 5. Querying single issue #10 returns distinct objects from distinct repos
      const alpha10 = await intake.getProjectIssue(projectAlpha.id, 10);
      const beta10 = await intake.getProjectIssue(projectBeta.id, 10);
      expect(alpha10.title).toBe("Alpha Prereq (Still Open!)");
      expect(beta10.title).toBe("Beta Prereq");
    });
  });

  describe("Client SDK Integration (@labq/client)", () => {
    test("client scoped project handles preview, publish, update, binding, and branch integration", async () => {
      const mockEvaluated = {
        number: 77,
        title: "Client Ticket",
        state: "OPEN",
        admission_status: "admitted" as const,
        reason: "admitted_ready",
        labels: ["ready-for-agent"],
        dependencies: [],
        unsatisfied_dependencies: [],
      };

      const mockPreview = {
        target_repo: "owner/client-repo",
        target_issue_number: 77,
        title: "Client Ticket",
        title_diff: null,
        body: "Ticket body",
        body_diff: null,
        label_effects: {
          current_labels: ["needs-info"],
          proposed_labels: ["ready-for-agent"],
          added_labels: ["ready-for-agent"],
          removed_labels: ["needs-info"],
        },
        admission_preview: {
          status: "admitted" as const,
          reason: "admitted_ready",
          dependencies: [],
          unsatisfied_dependencies: [],
          blocking_labels: [],
          exclusion_labels: [],
          active_claim: false,
        },
      };

      const mockBinding = {
        bound: true,
        project_id: "proj_client_test",
        repo_name: "owner/client-repo",
        issue_number: 77,
        state: "OPEN",
        labels: ["ready-for-agent"],
        admission_status: "admitted" as const,
        bound_at: "2026-10-28T12:00:00Z",
      };

      const mockBranchIntegration = {
        project_id: "proj_client_test",
        issue_number: 77,
        branch: "feat/oauth-flow",
        commit_sha: "c0ffee",
        integrated_at: "2026-10-28T12:05:00Z",
      };

      const client = createFactoryClient({
        baseUrl: "http://localhost:8080",
        fetch: async (input, init) => {
          const url = String(input);
          const method = init?.method ?? "GET";

          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/preview") &&
            method === "POST"
          ) {
            return Response.json(mockPreview);
          }
          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/publish") &&
            method === "POST"
          ) {
            return Response.json({
              repo: "owner/client-repo",
              issue: mockEvaluated,
              created_at: "2026-10-28T12:00:00Z",
            });
          }
          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/77/update") &&
            method === "POST"
          ) {
            return Response.json(mockEvaluated);
          }
          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/77/bind") &&
            method === "POST"
          ) {
            return Response.json(mockBinding);
          }
          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/77/integrate") &&
            method === "POST"
          ) {
            return Response.json(mockBranchIntegration);
          }
          if (
            url.endsWith("/api/v1/projects/proj_client_test/intake/77/integration") &&
            method === "GET"
          ) {
            return Response.json(mockBranchIntegration);
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });

      const scoped = client.forProject("proj_client_test");

      // 1. Preview
      const preview = await scoped.previewIntake({
        issue_number: 77,
        title: "Client Ticket",
        body: "Ticket body",
        labels: ["ready-for-agent"],
      });
      expect(preview.admission_preview.status).toBe("admitted");
      expect(preview.target_repo).toBe("owner/client-repo");

      // 2. Publish
      const published = await scoped.publishTicket({
        title: "New Spec",
        body: "Spec content",
        labels: ["ready-for-agent"],
      });
      expect(published.issue.number).toBe(77);
      expect(published.repo).toBe("owner/client-repo");

      // 3. Update
      const updated = await scoped.updateTicket(77, {
        title: "Updated Title",
        labels: ["ready-for-agent"],
      });
      expect(updated.number).toBe(77);

      // 4. Exact target binding
      const bound = await scoped.bindTarget(77, {
        expected_state: "OPEN",
        expected_labels: ["ready-for-agent"],
        expected_admission_status: "admitted",
      });
      expect(bound.bound).toBe(true);
      expect(bound.issue_number).toBe(77);

      // 5. Record branch integration
      const integrated = await scoped.recordBranchIntegration(77, {
        branch: "feat/oauth-flow",
        commit_sha: "c0ffee",
      });
      expect(integrated.branch).toBe("feat/oauth-flow");

      // 6. Get branch integration
      const fetchedIntegration = await scoped.getBranchIntegration(77);
      expect(fetchedIntegration.branch).toBe("feat/oauth-flow");
    });
  });

  describe("HTTP Routes & Scoped Handler (handleProjectIntakeRoute)", () => {
    test("handles full REST intake lifecycle via HTTP request objects", async () => {
      const checkoutPath = createMockCheckout("co-http", "owner/repo-alpha");
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "HTTP Project",
        checkout_path: checkoutPath,
      });

      // 1. GET /api/v1/projects/:projectId/intake
      const getReq = new Request(`http://localhost/api/v1/projects/${project.id}/intake`);
      const getRes = await handleProjectIntakeRoute(
        getReq,
        project.id,
        [project.id, "intake"],
        intake,
      );
      expect(getRes?.status).toBe(200);
      const backlogData = await getRes?.json();
      expect(backlogData.repo).toBe("owner/repo-alpha");

      // 2. POST /api/v1/projects/:projectId/intake/preview
      const previewReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "feat: preview ticket",
            body: "Ticket content\nDepends on: None",
            labels: ["ready-for-agent"],
          }),
        },
      );
      const previewRes = await handleProjectIntakeRoute(
        previewReq,
        project.id,
        [project.id, "intake", "preview"],
        intake,
      );
      expect(previewRes?.status).toBe(200);
      const previewData = await previewRes?.json();
      expect(previewData.admission_preview.status).toBe("admitted");

      // 3. POST /api/v1/projects/:projectId/intake/publish
      const publishReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "feat: published ticket",
            body: "Body text\nDepends on: None",
            labels: ["ready-for-agent"],
          }),
        },
      );
      const publishRes = await handleProjectIntakeRoute(
        publishReq,
        project.id,
        [project.id, "intake", "publish"],
        intake,
      );
      expect(publishRes?.status).toBe(200);
      const publishData = await publishRes?.json();
      const issueNum = publishData.issue.number;
      expect(typeof issueNum).toBe("number");

      // 4. GET /api/v1/projects/:projectId/intake/:number
      const singleReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}`,
      );
      const singleRes = await handleProjectIntakeRoute(
        singleReq,
        project.id,
        [project.id, "intake", String(issueNum)],
        intake,
      );
      expect(singleRes?.status).toBe(200);
      const singleData = await singleRes?.json();
      expect(singleData.title).toBe("feat: published ticket");

      // 5. PATCH /api/v1/projects/:projectId/intake/:number
      const patchReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "feat: updated title via PATCH",
          }),
        },
      );
      const patchRes = await handleProjectIntakeRoute(
        patchReq,
        project.id,
        [project.id, "intake", String(issueNum)],
        intake,
      );
      expect(patchRes?.status).toBe(200);
      const patchData = await patchRes?.json();
      expect(patchData.title).toBe("feat: updated title via PATCH");

      // 6. POST /api/v1/projects/:projectId/intake/:number/update
      const updatePostReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}/update`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "feat: updated title via POST update",
            labels: ["ready-for-agent"],
          }),
        },
      );
      const updatePostRes = await handleProjectIntakeRoute(
        updatePostReq,
        project.id,
        [project.id, "intake", String(issueNum), "update"],
        intake,
      );
      expect(updatePostRes?.status).toBe(200);

      // 7. POST /api/v1/projects/:projectId/intake/:number/bind
      const bindReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_state: "OPEN",
            expected_labels: ["ready-for-agent"],
            expected_admission_status: "admitted",
          }),
        },
      );
      const bindRes = await handleProjectIntakeRoute(
        bindReq,
        project.id,
        [project.id, "intake", String(issueNum), "bind"],
        intake,
      );
      expect(bindRes?.status).toBe(200);
      const bindData = await bindRes?.json();
      expect(bindData.bound).toBe(true);

      // 8. Fail-closed target binding drift via HTTP -> returns 409
      const driftBindReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}/bind`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expected_state: "OPEN",
            expected_labels: ["wrong-label"],
            expected_admission_status: "admitted",
          }),
        },
      );
      const driftBindRes = await handleProjectIntakeRoute(
        driftBindReq,
        project.id,
        [project.id, "intake", String(issueNum), "bind"],
        intake,
      );
      expect(driftBindRes?.status).toBe(409);
      const driftData = await driftBindRes?.json();
      expect(driftData.error).toBe("target_drift");

      // 9. POST /api/v1/projects/:projectId/intake/:number/integrate
      const integrateReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}/integrate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branch: "feat/issue-branch",
            commit_sha: "1234567890abcdef",
          }),
        },
      );
      const integrateRes = await handleProjectIntakeRoute(
        integrateReq,
        project.id,
        [project.id, "intake", String(issueNum), "integrate"],
        intake,
      );
      expect(integrateRes?.status).toBe(200);

      // 10. GET /api/v1/projects/:projectId/intake/:number/integration
      const getIntegrateReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/${issueNum}/integration`,
      );
      const getIntegrateRes = await handleProjectIntakeRoute(
        getIntegrateReq,
        project.id,
        [project.id, "intake", String(issueNum), "integration"],
        intake,
      );
      expect(getIntegrateRes?.status).toBe(200);
      const integData = await getIntegrateRes?.json();
      expect(integData.branch).toBe("feat/issue-branch");
      expect(integData.commit_sha).toBe("1234567890abcdef");

      // 11. Refusal on invalid payload -> returns 400
      const invalidReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invalid: "payload" }),
        },
      );
      const invalidRes = await handleProjectIntakeRoute(
        invalidReq,
        project.id,
        [project.id, "intake", "preview"],
        intake,
      );
      expect(invalidRes?.status).toBe(400);

      // 12. Nonexistent issue -> returns 404
      const notFoundReq = new Request(
        `http://localhost/api/v1/projects/${project.id}/intake/999999`,
      );
      const notFoundRes = await handleProjectIntakeRoute(
        notFoundReq,
        project.id,
        [project.id, "intake", "999999"],
        intake,
      );
      expect(notFoundRes?.status).toBe(404);
    });
  });
});
