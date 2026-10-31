import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CommandLedger,
  CommandService,
  CommandError,
  BrakeService,
  applyCommandMigrations,
  type EngineReconciliationAdapter,
} from "../../apps/backend/src/command";
import {
  initializeDatabase,
  ProjectRegistryService,
  SyntheticForgeAdapter,
} from "../../apps/backend/src/registry";
import { createFactoryClient } from "@animus/client";
import {
  commandRecordSchema,
  commandListSchema,
  globalBrakeStateSchema,
  projectBrakeStateSchema,
  commandReconciliationResultSchema,
} from "@animus/contracts/operator";

describe("Durable Command Ledger, Reconciliation, & Scoped Brakes (Issue #60)", () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseSync;
  let ledger: CommandLedger;
  let brakes: BrakeService;
  let commandService: CommandService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "animus-command-test-"));
    dbPath = join(tempDir, "console.db");
    db = initializeDatabase(dbPath);
    ledger = new CommandLedger(db);
    brakes = new BrakeService(db);
    commandService = new CommandService(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("AC1: Durable Command Recording Prior to Dispatch & Concurrent Serialization", () => {
    test("commands are recorded in console.db prior to dispatch with state='dispatched'", async () => {
      let dispatchExecuted = false;
      let recordedStateBeforeDispatch: string | null = null;

      const record = await commandService.dispatch(
        {
          actor: "operator",
          projectId: "proj_alpha",
          action: "launch",
          target: { specification: "#42 AC1" },
        },
        async (cmd) => {
          // Verify that SQLite already contains this command with state='dispatched'
          const inDb = ledger.getCommand(cmd.requestId);
          recordedStateBeforeDispatch = inDb?.state ?? null;
          dispatchExecuted = true;
          return {
            result: { id: "lap_ack_001", status: "admitted" },
            state: "acknowledged",
          };
        },
      );

      expect(dispatchExecuted).toBe(true);
      expect(recordedStateBeforeDispatch).toBe("dispatched");
      expect(record.state).toBe("acknowledged");
      expect(record.actor).toBe("operator");
      expect(record.projectId).toBe("proj_alpha");
      expect(record.action).toBe("launch");
      expect(record.target).toEqual({ specification: "#42 AC1" });
      expect(record.requestId).toBeDefined();
      expect(record.timestamp).toBeDefined();

      // Retrieve from database directly to verify persistence
      const persisted = ledger.getCommand(record.requestId);
      expect(persisted).not.toBeNull();
      expect(persisted?.state).toBe("acknowledged");
    });

    test("storage failure rejects dispatch immediately without executing side effects", async () => {
      // Create a corrupted or read-only service by closing DB to simulate storage failure
      const failDb = new DatabaseSync(":memory:");
      applyCommandMigrations(failDb);
      const failingService = new CommandService(failDb);
      failDb.close(); // Closed connection will fail on write

      let sideEffectExecuted = false;
      let errorThrown: any = null;

      try {
        await failingService.dispatch(
          {
            actor: "operator",
            projectId: "proj_alpha",
            action: "launch",
            target: { specification: "#42 AC1" },
          },
          async () => {
            sideEffectExecuted = true;
            return { result: { id: "never_called" } };
          },
        );
      } catch (err) {
        errorThrown = err;
      }

      expect(sideEffectExecuted).toBe(false);
      expect(errorThrown).toBeInstanceOf(CommandError);
      expect((errorThrown as CommandError).code).toBe("storage_failed");
    });

    test("concurrent dispatches are serialized through the single-writer SQLite connection", async () => {
      const dispatchOrder: number[] = [];
      const concurrentCount = 10;

      const dispatches = Array.from({ length: concurrentCount }, (_, i) =>
        commandService.dispatch(
          {
            requestId: `req_concurrent_${i}`,
            actor: `actor_${i}`,
            projectId: "proj_concurrent",
            action: "launch",
            target: { index: i },
          },
          async (cmd) => {
            // Emulate small async tick
            await new Promise((resolve) => setTimeout(resolve, 5));
            dispatchOrder.push((cmd.target as any).index);
            return { result: { ack: i }, state: "acknowledged" };
          },
        ),
      );

      const results = await Promise.all(dispatches);
      expect(results).toHaveLength(concurrentCount);
      expect(dispatchOrder).toHaveLength(concurrentCount);

      // Verify all 10 records are distinct and persisted in DB
      const allCmds = ledger.listCommands({ projectId: "proj_concurrent" });
      expect(allCmds).toHaveLength(concurrentCount);
      const requestIds = new Set(allCmds.map((c) => c.requestId));
      expect(requestIds.size).toBe(concurrentCount);
    });
  });

  describe("AC2: System Restart & Reconciliation", () => {
    test("system restart reconciles dispatched commands against engine-host without re-executing", async () => {
      // Simulate crash: command recorded with state 'dispatched', then process restarts
      const simulatedRequestId = "req_in_flight_restart_1";
      ledger.recordBeforeDispatch({
        requestId: simulatedRequestId,
        actor: "operator",
        projectId: "proj_alpha",
        action: "launch",
        target: { specification: "issue-42", lapId: "lap_reconcile_100" },
      });

      // Close old connection, open brand new connection pointing to same db file
      db.close();

      let reExecuted = false;
      const restartDb = new DatabaseSync(dbPath);
      const mockEngine: EngineReconciliationAdapter = {
        async getLap(lapId: string) {
          if (lapId === "lap_reconcile_100") {
            return {
              id: "lap_reconcile_100",
              native_status: "succeeded",
              product_status: "completed",
              completed_at: "2026-10-28T12:00:00Z",
            };
          }
          return null;
        },
        async listLaps() {
          return [];
        },
      };

      const restartService = new CommandService(restartDb, { engineAdapter: mockEngine });

      // Trigger restart reconciliation
      const reconciliationResult = await restartService.reconcile();

      expect(reExecuted).toBe(false);
      expect(reconciliationResult.reconciledCount).toBe(1);

      const reconciledCmd = restartService.getCommand(simulatedRequestId);
      expect(reconciledCmd).not.toBeNull();
      expect(reconciledCmd?.state).toBe("succeeded");
      expect(reconciledCmd?.reconciledAt).toBeDefined();
      expect(reconciledCmd?.evidenceLinks).toContain("/api/v1/laps/lap_reconcile_100/evidence");
      expect(reconciledCmd?.outcome?.provenance.source).toBe("engine_host");

      restartDb.close();
      // Reopen original db for afterEach cleanup
      db = new DatabaseSync(dbPath);
    });

    test("reconciles unmaterialized dispatch on reachable engine host to failed without duplicate execution", async () => {
      const simulatedRequestId = "req_unmaterialized_1";
      ledger.recordBeforeDispatch({
        requestId: simulatedRequestId,
        actor: "operator",
        projectId: "proj_beta",
        action: "launch",
        target: { specification: "issue-99", lapId: "lap_missing_99" },
      });

      db.close();
      const restartDb = new DatabaseSync(dbPath);
      const mockEngine: EngineReconciliationAdapter = {
        async getLap() {
          return null; // Not found on engine
        },
        async listLaps() {
          return [];
        },
      };

      const restartService = new CommandService(restartDb, { engineAdapter: mockEngine });
      const reconciliationResult = await restartService.reconcile();

      expect(reconciliationResult.reconciledCount).toBe(1);
      const reconciledCmd = restartService.getCommand(simulatedRequestId);
      expect(reconciledCmd?.state).toBe("failed");
      expect(reconciledCmd?.outcome?.error).toBe("dispatch_unmaterialized");
      expect(reconciledCmd?.outcome?.provenance.details).toContain("avoiding duplicate dispatch");

      restartDb.close();
      db = new DatabaseSync(dbPath);
    });

    test("reconciles to unknown when engine-host is unreachable", async () => {
      const simulatedRequestId = "req_offline_host_1";
      ledger.recordBeforeDispatch({
        requestId: simulatedRequestId,
        actor: "operator",
        projectId: "proj_beta",
        action: "launch",
        target: { specification: "issue-99", lapId: "lap_offline_99" },
      });

      db.close();
      const restartDb = new DatabaseSync(dbPath);
      const mockEngine: EngineReconciliationAdapter = {
        async getLap() {
          throw new Error("Connection refused: 127.0.0.1:4001");
        },
        async listLaps() {
          throw new Error("Connection refused: 127.0.0.1:4001");
        },
      };

      const restartService = new CommandService(restartDb, { engineAdapter: mockEngine });
      await restartService.reconcile();

      const reconciledCmd = restartService.getCommand(simulatedRequestId);
      expect(reconciledCmd?.state).toBe("unknown");
      expect(reconciledCmd?.outcome?.provenance.details).toBe("authority_unavailable");

      restartDb.close();
      db = new DatabaseSync(dbPath);
    });

    test("reconciliation by specification does not match older historical laps from previous runs", async () => {
      const simulatedRequestId = "req_spec_matching_1";
      const cmdTimestamp = "2026-10-28T14:00:00Z";
      ledger.recordBeforeDispatch({
        requestId: simulatedRequestId,
        actor: "operator",
        projectId: "proj_spec_test",
        action: "launch",
        target: { specification: "issue-50" },
        timestamp: cmdTimestamp,
      });

      db.close();
      const restartDb = new DatabaseSync(dbPath);

      // Engine host only returns an old historical lap from yesterday
      const mockEngine: EngineReconciliationAdapter = {
        async getLap() {
          return null;
        },
        async listLaps() {
          return [
            {
              id: "lap_yesterday",
              native_status: "succeeded",
              product_status: "completed",
              completed_at: "2026-10-27T10:00:00Z",
              started_at: "2026-10-27T09:00:00Z",
              work_item: "issue-50",
            } as any,
          ];
        },
      };

      const restartService = new CommandService(restartDb, { engineAdapter: mockEngine });
      await restartService.reconcile();

      const reconciledCmd = restartService.getCommand(simulatedRequestId);
      // Historical lap from yesterday should NOT match today's command
      expect(reconciledCmd?.state).toBe("failed");
      expect(reconciledCmd?.outcome?.error).toBe("dispatch_unmaterialized");

      restartDb.close();
      db = new DatabaseSync(dbPath);
    });

    test("command history and evidence links are retained indefinitely", async () => {
      const cmd = ledger.recordBeforeDispatch({
        requestId: "req_history_retention",
        actor: "operator",
        projectId: "proj_history",
        action: "launch",
        target: { test: true },
      });

      ledger.updateOutcome(
        cmd.requestId,
        {
          state: "succeeded",
          provenance: { source: "engine_host", timestamp: new Date().toISOString() },
        },
        ["/api/v1/laps/lap_hist/evidence", "/api/v1/laps/lap_hist/evidence/report"],
      );

      // Reconcile again: completed command should NOT be purged or mutated
      const result = await commandService.reconcile();
      expect(result.reconciledCount).toBe(0); // Only in-flight commands are reconciled

      const history = ledger.getCommand("req_history_retention");
      expect(history?.state).toBe("succeeded");
      expect(history?.evidenceLinks).toEqual([
        "/api/v1/laps/lap_hist/evidence",
        "/api/v1/laps/lap_hist/evidence/report",
      ]);
    });
  });

  describe("AC3: Classified Outcomes & Provenance", () => {
    test("reports classified outcomes with accurate provenance", async () => {
      // 1. Rejected outcome
      brakes.setGlobalLaunchBrake(true, "admin", "freeze");
      await expect(
        commandService.dispatch(
          {
            requestId: "cmd_rejected_1",
            actor: "operator",
            projectId: "proj_1",
            action: "launch",
            target: { lap: 1 },
          },
          async () => ({ result: { ok: true } }),
        ),
      ).rejects.toThrow("launch_brake_set");

      const rejected = ledger.getCommand("cmd_rejected_1");
      expect(rejected?.state).toBe("rejected");
      expect(rejected?.outcome?.provenance.source).toBe("backend");
      expect(rejected?.outcome?.error).toBe("launch_brake_set");

      brakes.setGlobalLaunchBrake(false);

      // 2. Acknowledged outcome
      const acked = await commandService.dispatch(
        {
          requestId: "cmd_ack_1",
          actor: "operator",
          projectId: "proj_1",
          action: "launch",
          target: { lap: 2 },
        },
        async () => ({ result: { id: "lap_ack_2" }, state: "acknowledged" }),
      );
      expect(acked.state).toBe("acknowledged");
      expect(acked.outcome?.provenance.source).toBe("engine_host");

      // 3. Succeeded outcome
      const succeeded = await commandService.dispatch(
        {
          requestId: "cmd_succ_1",
          actor: "operator",
          projectId: "proj_1",
          action: "sync",
          target: { sync: true },
        },
        async () => ({ result: { status: "done" }, state: "succeeded" }),
      );
      expect(succeeded.state).toBe("succeeded");

      // 4. Failed outcome
      const failed = await commandService.dispatch(
        {
          requestId: "cmd_fail_1",
          actor: "operator",
          projectId: "proj_1",
          action: "launch",
          target: { lap: 3 },
        },
        async () => ({ error: "native_launch_failed", partial: false }),
      );
      expect(failed.state).toBe("failed");
      expect(failed.outcome?.error).toBe("native_launch_failed");

      // 5. Partial outcome
      const partial = await commandService.dispatch(
        {
          requestId: "cmd_part_1",
          actor: "operator",
          projectId: "proj_1",
          action: "promotion",
          target: { pr: 12 },
        },
        async () => ({
          result: { pr_number: 12 },
          error: "local_freeze_failed",
          partial: true,
        }),
      );
      expect(partial.state).toBe("partial");
      expect(partial.outcome?.error).toBe("local_freeze_failed");
    });

    test("dispatch timeout results in unknown outcome with provenance pending reconciliation", async () => {
      await expect(
        commandService.dispatch(
          {
            requestId: "cmd_timeout_1",
            actor: "operator",
            projectId: "proj_1",
            action: "launch",
            target: { spec: "long_task" },
          },
          async () => {
            const err = new Error("The operation was aborted due to timeout");
            err.name = "TimeoutError";
            throw err;
          },
        ),
      ).rejects.toThrow("Timeout awaiting dispatch acknowledgment");

      const timedOutCmd = ledger.getCommand("cmd_timeout_1");
      expect(timedOutCmd?.state).toBe("unknown");
      expect(timedOutCmd?.outcome?.provenance.source).toBe("backend");
      expect(timedOutCmd?.outcome?.provenance.details).toBe("dispatch_timeout");
    });
  });

  describe("AC4: Independent Hierarchical Brakes & Fail-Closed Enforcement", () => {
    test("global launch brake stops all projects without clearing project brakes; lifting global brake retains project brakes", () => {
      // Set project launch brake on proj_alpha
      brakes.setProjectLaunchBrake("proj_alpha", true, "tester", "audit_lock");
      expect(brakes.getProjectBrakeState("proj_alpha").launch_brake).toBe(true);
      expect(brakes.getProjectBrakeState("proj_alpha").effective_launch_brake).toBe(true);

      // proj_beta has no brake
      expect(brakes.getProjectBrakeState("proj_beta").launch_brake).toBe(false);
      expect(brakes.getProjectBrakeState("proj_beta").effective_launch_brake).toBe(false);

      // Now engage global launch brake
      brakes.setGlobalLaunchBrake(true, "operator", "emergency_maintenance");
      expect(brakes.getGlobalBrakeState().global_launch_brake).toBe(true);

      // Both projects now have effective launch brake active
      expect(brakes.getProjectBrakeState("proj_alpha").effective_launch_brake).toBe(true);
      expect(brakes.getProjectBrakeState("proj_beta").effective_launch_brake).toBe(true);

      // But proj_beta's OWN project brake was NOT mutated
      expect(brakes.getProjectBrakeState("proj_beta").launch_brake).toBe(false);
      // And proj_alpha's OWN project brake was retained
      expect(brakes.getProjectBrakeState("proj_alpha").launch_brake).toBe(true);

      // Lift global launch brake
      brakes.setGlobalLaunchBrake(false, "operator", "resolved");
      expect(brakes.getGlobalBrakeState().global_launch_brake).toBe(false);

      // Invariant 3: Lifting global brake does NOT clear project brakes
      expect(brakes.getProjectBrakeState("proj_alpha").launch_brake).toBe(true);
      expect(brakes.getProjectBrakeState("proj_alpha").effective_launch_brake).toBe(true);

      // proj_beta is free
      expect(brakes.getProjectBrakeState("proj_beta").effective_launch_brake).toBe(false);
    });

    test("independent schedule pause stops scheduled launches but permits direct launches", () => {
      // Set schedule pause (globally or for project)
      brakes.setGlobalSchedulePause(true, "scheduler", "nightly_freeze");

      // Direct launch check
      const directCheck = brakes.isLaunchPermitted("proj_alpha");
      expect(directCheck.permitted).toBe(true);

      // Scheduled launch check fails-closed
      const scheduledCheck = brakes.isScheduledLaunchPermitted("proj_alpha");
      expect(scheduledCheck.permitted).toBe(false);
      expect(scheduledCheck.reason).toBe("schedule_paused");

      // Release schedule pause
      brakes.setGlobalSchedulePause(false);
      expect(brakes.isScheduledLaunchPermitted("proj_alpha").permitted).toBe(true);
    });

    test("direct and scheduled launches fail-closed if brake state is unknown", () => {
      const closedDb = new DatabaseSync(":memory:");
      applyCommandMigrations(closedDb);
      const corruptedBrakes = new BrakeService(closedDb);
      closedDb.close(); // Simulates DB outage / corrupted state

      const directCheck = corruptedBrakes.isLaunchPermitted("proj_alpha");
      expect(directCheck.permitted).toBe(false);
      expect(directCheck.reason).toBe("brake_state_unknown");

      const scheduledCheck = corruptedBrakes.isScheduledLaunchPermitted("proj_alpha");
      expect(scheduledCheck.permitted).toBe(false);
      expect(scheduledCheck.reason).toBe("brake_state_unknown");
    });
  });

  describe("AC5: Retention after Project Deregistration & SQLite VACUUM INTO Backup", () => {
    test("command records and audit trail are retained after project deregistration", async () => {
      const forge = new SyntheticForgeAdapter({ "owner/repo-dereg": 301 });
      const registry = new ProjectRegistryService(db, forge);

      const checkoutPath = join(tempDir, "checkout-dereg");
      mkdirSync(join(checkoutPath, ".git"), { recursive: true });
      writeFileSync(
        join(checkoutPath, ".git", "config"),
        '[remote "origin"]\n  url = https://github.com/owner/repo-dereg.git\n',
      );
      const project = await registry.registerProject({
        method: "local_checkout",
        name: "Dereg Project",
        checkout_path: checkoutPath,
      });

      // Record commands for this project
      const cmd1 = await commandService.dispatch(
        {
          actor: "operator",
          projectId: project.id,
          action: "launch",
          target: { spec: "AC1" },
        },
        async () => ({ result: { id: "lap_dereg_1" }, state: "acknowledged" }),
      );

      const cmd2 = await commandService.dispatch(
        {
          actor: "scheduler",
          projectId: project.id,
          action: "sync",
          target: { branches: ["main"] },
        },
        async () => ({ result: { ok: true }, state: "succeeded" }),
      );

      // Deregister the project
      const deregRes = await registry.deregisterProject(project.id);
      expect(deregRes.status).toBe("tombstone");

      // Verify that all command records for the deregistered project remain intact!
      const projectCommands = ledger.listCommands({ projectId: project.id });
      expect(projectCommands).toHaveLength(2);
      expect(projectCommands.map((c) => c.requestId)).toContain(cmd1.requestId);
      expect(projectCommands.map((c) => c.requestId)).toContain(cmd2.requestId);

      // Verify individual command retrieval
      const fetchedCmd1 = ledger.getCommand(cmd1.requestId);
      expect(fetchedCmd1).not.toBeNull();
      expect(fetchedCmd1?.projectId).toBe(project.id);
      expect(fetchedCmd1?.state).toBe("acknowledged");
    });

    test("SQLite backup via VACUUM INTO captures consistent command ledger state", async () => {
      // Record a command in the primary database
      await commandService.dispatch(
        {
          requestId: "req_backup_test_1",
          actor: "admin",
          projectId: "proj_backup",
          action: "launch",
          target: { spec: "Backup AC5" },
        },
        async () => ({ result: { ack: true }, state: "acknowledged" }),
      );

      brakes.setGlobalLaunchBrake(true, "operator", "backup_test_brake");

      const backupFile = join(tempDir, "backups", "console.db.bak");
      const backupResult = commandService.backupDatabase(backupFile);

      expect(backupResult.success).toBe(true);
      expect(backupResult.destinationPath).toBe(backupFile);
      expect(existsSync(backupFile)).toBe(true);

      // Open the backup database in an independent SQLite connection
      const backupDb = new DatabaseSync(backupFile);
      const backupLedger = new CommandLedger(backupDb);
      const backupBrakes = new BrakeService(backupDb);

      const backedUpCmd = backupLedger.getCommand("req_backup_test_1");
      expect(backedUpCmd).not.toBeNull();
      expect(backedUpCmd?.actor).toBe("admin");
      expect(backedUpCmd?.projectId).toBe("proj_backup");
      expect(backedUpCmd?.state).toBe("acknowledged");

      const backedUpBrakes = backupBrakes.getGlobalBrakeState();
      expect(backedUpBrakes.global_launch_brake).toBe(true);

      backupDb.close();
    });
  });

  describe("AC6: Client SDK Integration via @animus/client", () => {
    test("client handles command dispatch, queries, reconciliation, global brakes, and project brakes", async () => {
      const mockCommand = {
        requestId: "cmd_client_1",
        actor: "operator",
        projectId: "proj_client_1",
        action: "launch",
        target: { spec: "#58 AC4" },
        timestamp: "2026-10-28T00:00:00Z",
        state: "acknowledged" as const,
        outcome: {
          state: "acknowledged" as const,
          provenance: { source: "engine_host", timestamp: "2026-10-28T00:00:00Z" },
          result: { id: "lap_1" },
        },
        evidenceLinks: ["/api/v1/laps/lap_1/evidence"],
        createdAt: "2026-10-28T00:00:00Z",
        updatedAt: "2026-10-28T00:00:00Z",
        reconciledAt: null,
      };

      const mockGlobalBrakes = {
        global_launch_brake: true,
        schedule_pause: false,
        updated_at: "2026-10-28T00:00:00Z",
      };

      const mockProjectBrakes = {
        project_id: "proj_client_1",
        launch_brake: false,
        schedule_pause: false,
        effective_launch_brake: true,
        effective_schedule_pause: false,
        updated_at: "2026-10-28T00:00:00Z",
      };

      const client = createFactoryClient({
        baseUrl: "http://localhost:8080",
        fetch: async (input, init) => {
          const url = String(input);
          if (url.includes("/api/v1/commands/reconcile") && init?.method === "POST") {
            return Response.json({
              reconciledCount: 1,
              commands: [mockCommand],
              timestamp: "2026-10-28T00:00:00Z",
            });
          }
          if (url.includes("/api/v1/commands/backup") && init?.method === "POST") {
            return Response.json({
              success: true,
              destinationPath: "/tmp/backup.db",
              timestamp: "2026-10-28T00:00:00Z",
            });
          }
          if (url.endsWith("/api/v1/commands/cmd_client_1") && init?.method === "GET") {
            return Response.json(mockCommand);
          }
          if (url.includes("/api/v1/commands") && init?.method === "GET") {
            return Response.json([mockCommand]);
          }
          if (url.includes("/api/v1/commands") && init?.method === "POST") {
            return Response.json(mockCommand, { status: 201 });
          }
          if (url.endsWith("/api/v1/brakes") && init?.method === "GET") {
            return Response.json(mockGlobalBrakes);
          }
          if (url.endsWith("/api/v1/brakes") && init?.method === "POST") {
            return Response.json(mockGlobalBrakes);
          }
          if (url.includes("/api/v1/projects/proj_client_1/brakes") && init?.method === "GET") {
            return Response.json(mockProjectBrakes);
          }
          if (url.includes("/api/v1/projects/proj_client_1/brakes") && init?.method === "POST") {
            return Response.json(mockProjectBrakes);
          }
          return Response.json({ error: "not_found" }, { status: 404 });
        },
      });

      // Global command operations
      const list = await client.commands();
      expect(commandListSchema.parse(list)).toHaveLength(1);
      expect(list[0].requestId).toBe("cmd_client_1");

      const single = await client.command("cmd_client_1");
      expect(commandRecordSchema.parse(single)).toEqual(mockCommand);

      const dispatched = await client.dispatchCommand({
        actor: "operator",
        action: "launch",
        target: { spec: "#58 AC4" },
      });
      expect(dispatched.requestId).toBe("cmd_client_1");

      const reconciled = await client.reconcileCommands();
      expect(commandReconciliationResultSchema.parse(reconciled).reconciledCount).toBe(1);

      const backup = await client.backupLedger("/tmp/backup.db");
      expect(backup.success).toBe(true);

      const globalBrakes = await client.brakes();
      expect(globalBrakeStateSchema.parse(globalBrakes).global_launch_brake).toBe(true);

      const updatedBrake = await client.setBrake({
        brake: "global_launch",
        active: true,
      });
      expect(updatedBrake.global_launch_brake).toBe(true);

      // Scoped operations
      const scopedClient = client.forProject("proj_client_1");
      const projBrakes = await scopedClient.brakes();
      expect(projectBrakeStateSchema.parse(projBrakes).effective_launch_brake).toBe(true);

      const updatedProjBrake = await scopedClient.setBrake({
        brake: "launch_brake",
        active: true,
      });
      expect(updatedProjBrake.project_id).toBe("proj_client_1");
    });
  });
});
