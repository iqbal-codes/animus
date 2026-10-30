import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

describe("Unified Launcher, Private Access, Closed CI Gates, and Snapshot Rollback (Issue #65)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `factory-dist-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("AC1 (Parent AC21): Unified Launcher & Coordinated Processes", () => {
    test("launcher starts backend and engine-host as coordinated application", async () => {
      const { FactoryLauncher } = await import("../../apps/launcher/src/launcher");
      const launcher = new FactoryLauncher({
        host: "127.0.0.1",
        port: 0,
        enginePort: 0,
        stateDir: tempDir,
      });

      // Verify launcher status before start
      expect(launcher.getStatus().state).toBe("stopped");

      // Mock start with simulated processes
      const result = await launcher.startSimulated({
        backendOk: true,
        engineHostOk: true,
      });

      expect(result.status).toBe("running");
      expect(result.backendUrl).toContain("127.0.0.1");
      expect(result.engineHostUrl).toContain("127.0.0.1");
      expect(launcher.getStatus().state).toBe("running");

      // Graceful coordinated shutdown
      const shutdownResult = await launcher.stop();
      expect(shutdownResult.status).toBe("stopped");
      expect(shutdownResult.stopped).toContain("backend");
      expect(shutdownResult.stopped).toContain("engine-host");
      expect(launcher.getStatus().state).toBe("stopped");
    });

    test("launcher reports partial startup failure per process when one fails", async () => {
      const { FactoryLauncher } = await import("../../apps/launcher/src/launcher");
      const launcher = new FactoryLauncher({
        host: "127.0.0.1",
        port: 0,
        enginePort: 0,
        stateDir: tempDir,
      });

      // Simulate engine-host succeeding but backend failing during coordinated startup
      const partialResult = await launcher.startSimulated({
        backendOk: false,
        engineHostOk: true,
      });

      expect(partialResult.status).toBe("partial_startup_failure");
      expect(partialResult.failed).toContain("backend");
      expect(partialResult.succeeded).toContain("engine-host");
      // Fails closed and cleans up surviving process
      expect(launcher.getStatus().state).toBe("stopped");
    });

    test("launcher reports partial shutdown failure per process if shutdown times out or errors", async () => {
      const { FactoryLauncher } = await import("../../apps/launcher/src/launcher");
      const launcher = new FactoryLauncher({
        host: "127.0.0.1",
        port: 0,
        enginePort: 0,
        stateDir: tempDir,
      });

      await launcher.startSimulated({ backendOk: true, engineHostOk: true });
      expect(launcher.getStatus().state).toBe("running");

      // Simulate partial shutdown failure (e.g. engine-host hangs on shutdown)
      const stopResult = await launcher.stopSimulated({
        backendStopOk: true,
        engineHostStopOk: false,
      });

      expect(stopResult.status).toBe("partial_shutdown_failure");
      expect(stopResult.stopped).toContain("backend");
      expect(stopResult.failed).toContain("engine-host");
    });

    test("backend serves static web console on localhost origin with SPA fallback if webDir configured", async () => {
      const { handleStaticWebRoute } = await import("../../apps/backend/src/web-static");

      // Returns null when webDir is undefined or does not exist (headless mode)
      expect(
        await handleStaticWebRoute(new Request("http://127.0.0.1:3000/"), undefined),
      ).toBeNull();
      expect(
        await handleStaticWebRoute(
          new Request("http://127.0.0.1:3000/"),
          join(tempDir, "nonexistent"),
        ),
      ).toBeNull();

      // Create mock web dist
      const mockWebDist = join(tempDir, "web-dist");
      mkdirSync(join(mockWebDist, "assets"), { recursive: true });
      writeFileSync(
        join(mockWebDist, "index.html"),
        "<!DOCTYPE html><html><body>Factory Console</body></html>",
      );
      writeFileSync(join(mockWebDist, "assets", "index-test.js"), "console.log('web-bundle');");

      // Test serving index.html on root
      const rootReq = new Request("http://127.0.0.1:3000/");
      const rootRes = await handleStaticWebRoute(rootReq, mockWebDist);
      expect(rootRes).not.toBeNull();
      expect(rootRes!.status).toBe(200);
      expect(rootRes!.headers.get("Content-Type")).toContain("text/html");
      const rootText = await rootRes!.text();
      expect(rootText).toContain("Factory Console");

      // Test serving static assets with proper MIME type
      const assetReq = new Request("http://127.0.0.1:3000/assets/index-test.js");
      const assetRes = await handleStaticWebRoute(assetReq, mockWebDist);
      expect(assetRes).not.toBeNull();
      expect(assetRes!.status).toBe(200);
      expect(assetRes!.headers.get("Content-Type")).toContain("application/javascript");
      const assetText = await assetRes!.text();
      expect(assetText).toContain("console.log('web-bundle');");

      // Test SPA fallback: unknown client routes serve index.html
      const spaReq = new Request("http://127.0.0.1:3000/projects/proj-123/specs");
      const spaRes = await handleStaticWebRoute(spaReq, mockWebDist);
      expect(spaRes).not.toBeNull();
      expect(spaRes!.status).toBe(200);
      expect(spaRes!.headers.get("Content-Type")).toContain("text/html");
      const spaText = await spaRes!.text();
      expect(spaText).toContain("Factory Console");

      // API routes should NOT be intercepted by static web handler
      const apiReq = new Request("http://127.0.0.1:3000/api/v1/health");
      const apiRes = await handleStaticWebRoute(apiReq, mockWebDist);
      expect(apiRes).toBeNull();
    });
  });

  describe("AC2 (Parent AC22): Private Access Mode, Session Secret, & CSRF", () => {
    test("enforces session secret mode 0600 on creation and verification", async () => {
      const { ensureSessionSecret } = await import("../../apps/backend/src/security");
      const secretFile = join(tempDir, "session.secret");

      // Creates file with mode 0600
      const secret1 = ensureSessionSecret(secretFile);
      expect(secret1.length).toBeGreaterThanOrEqual(32);
      expect(existsSync(secretFile)).toBe(true);

      const stat = statSync(secretFile);
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o600);

      // Subsequent read preserves secret
      const secret2 = ensureSessionSecret(secretFile);
      expect(secret2).toBe(secret1);

      // If permissions are overly permissive (e.g. 0644), it tightens to 0600
      chmodSync(secretFile, 0o644);
      const secret3 = ensureSessionSecret(secretFile);
      expect(secret3).toBe(secret1);
      const tightenedMode = statSync(secretFile).mode & 0o777;
      expect(tightenedMode).toBe(0o600);
    });

    test("default bind is loopback (127.0.0.1) and rejects non-loopback when remote access is false", async () => {
      const { validateBindAddress } = await import("../../apps/backend/src/security");

      // Loopback is allowed by default
      expect(() => validateBindAddress("127.0.0.1", false)).not.toThrow();
      expect(() => validateBindAddress("::1", false)).not.toThrow();

      // Non-loopback addresses are rejected when remote access is disabled
      expect(() => validateBindAddress("0.0.0.0", false)).toThrow(/bind_loopback_required/);
      expect(() => validateBindAddress("192.168.1.100", false)).toThrow(/bind_loopback_required/);
      expect(() => validateBindAddress("10.0.0.1", false)).toThrow(/bind_loopback_required/);
      expect(() => validateBindAddress("8.8.8.8", false)).toThrow(/bind_loopback_required/);
    });

    test("when FACTORY_REMOTE_ACCESS=true, allows private IP bind and rejects public IP or 0.0.0.0", async () => {
      const { validateBindAddress } = await import("../../apps/backend/src/security");

      // Private RFC1918 addresses and Tailscale CGNAT addresses are allowed
      expect(() => validateBindAddress("10.0.0.5", true)).not.toThrow();
      expect(() => validateBindAddress("172.20.10.2", true)).not.toThrow();
      expect(() => validateBindAddress("192.168.1.50", true)).not.toThrow();
      expect(() => validateBindAddress("100.80.90.100", true)).not.toThrow(); // Tailscale
      expect(() => validateBindAddress("127.0.0.1", true)).not.toThrow();

      // Public IPs and wildcard 0.0.0.0 are strictly rejected
      expect(() => validateBindAddress("0.0.0.0", true)).toThrow(/private_ip_required/);
      expect(() => validateBindAddress("::", true)).toThrow(/private_ip_required/);
      expect(() => validateBindAddress("1.1.1.1", true)).toThrow(/private_ip_required/);
      expect(() => validateBindAddress("142.250.190.46", true)).toThrow(/private_ip_required/);
    });

    test("enforces static operator token authentication when remote access is enabled", async () => {
      const { authenticateOperatorRequest } = await import("../../apps/backend/src/security");
      const validToken = "operator_secret_token_1234567890abcdef1234567890";

      // When remote access is off, local loopback requests pass
      const localReq = new Request("http://127.0.0.1:3000/api/v1/projects");
      expect(authenticateOperatorRequest(localReq, { remoteAccess: false })).toBe(true);

      // When remote access is on, unauthenticated request fails closed with 401
      const unauthReq = new Request("http://10.0.0.5:3000/api/v1/projects");
      expect(() =>
        authenticateOperatorRequest(unauthReq, { remoteAccess: true, operatorToken: validToken }),
      ).toThrow(/unauthorized/);

      // Request with wrong token fails closed
      const wrongTokenReq = new Request("http://10.0.0.5:3000/api/v1/projects", {
        headers: { Authorization: "Bearer wrong_token_value_000000000000000000" },
      });
      expect(() =>
        authenticateOperatorRequest(wrongTokenReq, {
          remoteAccess: true,
          operatorToken: validToken,
        }),
      ).toThrow(/unauthorized/);

      // Request with valid Bearer token passes
      const bearerReq = new Request("http://10.0.0.5:3000/api/v1/projects", {
        headers: { Authorization: `Bearer ${validToken}` },
      });
      expect(
        authenticateOperatorRequest(bearerReq, { remoteAccess: true, operatorToken: validToken }),
      ).toBe(true);

      // Request with valid X-Operator-Token passes
      const headerReq = new Request("http://10.0.0.5:3000/api/v1/projects", {
        headers: { "X-Operator-Token": validToken },
      });
      expect(
        authenticateOperatorRequest(headerReq, { remoteAccess: true, operatorToken: validToken }),
      ).toBe(true);
    });

    test("enforces strict CSRF protection on state-changing requests", async () => {
      const { validateCsrfProtection } = await import("../../apps/backend/src/security");

      // GET/HEAD requests are not state-changing
      const getReq = new Request("http://127.0.0.1:3000/api/v1/projects", { method: "GET" });
      expect(() => validateCsrfProtection(getReq)).not.toThrow();

      // POST with matching origin passes
      const validPostReq = new Request("http://127.0.0.1:3000/api/v1/projects", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:3000",
          Origin: "http://127.0.0.1:3000",
        },
      });
      expect(() => validateCsrfProtection(validPostReq)).not.toThrow();

      // POST with cross-site Sec-Fetch-Site is rejected
      const crossSiteReq = new Request("http://127.0.0.1:3000/api/v1/projects", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:3000",
          "Sec-Fetch-Site": "cross-site",
          Origin: "http://malicious-site.com",
        },
      });
      expect(() => validateCsrfProtection(crossSiteReq)).toThrow(/csrf_rejected/);

      // POST with mismatched Origin is rejected
      const mismatchOriginReq = new Request("http://127.0.0.1:3000/api/v1/projects", {
        method: "POST",
        headers: {
          Host: "127.0.0.1:3000",
          Origin: "http://evil-attacker.com",
        },
      });
      expect(() => validateCsrfProtection(mismatchOriginReq)).toThrow(/csrf_rejected/);
    });

    test("forge credentials remain strictly server-side and never leak into client responses", async () => {
      const { sanitizeForTelemetry } = await import("../../apps/backend/src/security");

      const sensitivePayload = {
        projectId: "proj-123",
        forgeToken: "ghp_secretTokenForGitHub1234567890abcdef",
        apiKey: "sk-secretApiKeyFromOpenAI9876543210fedcba",
        password: "SuperSecretPassword123",
        name: "test-project",
      };

      const sanitized = sanitizeForTelemetry(sensitivePayload);
      expect(sanitized).not.toHaveProperty("forgeToken");
      expect(sanitized).not.toHaveProperty("apiKey");
      expect(sanitized).not.toHaveProperty("password");
      expect(sanitized.projectId).toBe("proj-123");
      expect(sanitized.name).toBe("test-project");
    });
  });

  describe("AC3 (Parent AC23): Offline Test Suite & Synthetic Engine Adapter", () => {
    test("SyntheticEngineAdapter handles diagnostics, catalog, laps, and execution offline without network", async () => {
      const { SyntheticEngineAdapter } =
        await import("../../packages/contracts/src/synthetic-engine");
      const adapter = new SyntheticEngineAdapter({
        status: "healthy",
        revision: "5c4f5e484262185926b37b070457fabb9bfedae0",
      });

      // Diagnostics check
      const diag = adapter.getDiagnostics();
      expect(diag.status).toBe("healthy");
      expect(diag.revision_required).toBe("5c4f5e484262185926b37b070457fabb9bfedae0");
      expect(diag.file_count).toBeGreaterThan(0);

      // Catalog check
      const catalog = adapter.getCatalog();
      expect(catalog.workflows.length).toBeGreaterThan(0);
      expect(catalog.workflows.some((w) => w.name === "archon-loop")).toBe(true);

      // Launch simulated lap
      const ack = adapter.launchLap({ specification: "Test offline specification" });
      expect(ack.id).toBeDefined();
      expect(ack.status).toBe("pending");

      // Verify lap list includes the launched lap
      const laps = adapter.getLaps();
      expect(laps.some((l) => l.id === ack.id)).toBe(true);

      // Verify lap detail & evidence
      const detail = adapter.getLapDetail(ack.id);
      expect(detail.id).toBe(ack.id);
      const evidence = adapter.getLapEvidence(ack.id);
      expect(evidence.id).toBe(ack.id);
      expect(evidence.runtime_verification.verdict).toBe("PASS");
    });
  });

  describe("AC4 (Parent AC20, AC24): Executable Architecture Check & CI Pipeline", () => {
    test("architecture check script enforces boundary rules and fails on illegal imports", async () => {
      const { checkArchitectureRules } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;

      // Clean workspace must pass
      const result = checkArchitectureRules(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations.length).toBe(0);

      // Deliberate forbidden import in contracts must fail closed
      const illegalCode = 'import { initializeDatabase } from "@labq/backend";';
      const contractViolations = checkArchitectureRules.scanSnippet(
        "packages/contracts/src/fake.ts",
        illegalCode,
      );
      expect(contractViolations.length).toBeGreaterThan(0);
      expect(contractViolations[0]).toContain("packages/contracts cannot import applications");

      // Deliberate Node builtin in client must fail closed
      const clientIllegalCode = 'import fs from "node:fs";';
      const clientViolations = checkArchitectureRules.scanSnippet(
        "packages/client/src/fake.ts",
        clientIllegalCode,
      );
      expect(clientViolations.length).toBeGreaterThan(0);
      expect(clientViolations[0]).toContain("packages/client cannot import Node built-ins");
    });

    test("GitHub Actions CI configuration defines sequential fail-closed gates with frozen Bun", () => {
      const ciPath = join(process.cwd(), ".github/workflows/ci.yml");
      expect(existsSync(ciPath)).toBe(true);
      const content = readFileSync(ciPath, "utf-8");

      // Enforces frozen Bun install
      expect(content).toContain("bun install --frozen-lockfile");

      // Enforces sequential gates: static -> verification -> build
      expect(content).toContain("gate-static");
      expect(content).toContain("gate-verify");
      expect(content).toContain("gate-build");

      // Gate dependency ensures sequential fail-closed behavior
      expect(content).toContain("needs: [gate-static]");
      expect(content).toContain("needs: [gate-verify]");
    });
  });

  describe("AC5 (Parent AC25, AC06): Unified Release Packaging & SQLite Pre-Migration Snapshot Rollback", () => {
    test("release packager outputs immutable SemVer + Git SHA bundles for macOS and Linux matrix", async () => {
      const { packageReleaseBundle } = await import("../../scripts/release/package");
      const outDir = join(tempDir, "releases");
      mkdirSync(outDir, { recursive: true });

      const targets = [
        { platform: "darwin", arch: "arm64" },
        { platform: "darwin", arch: "x64" },
        { platform: "linux", arch: "x64" },
        { platform: "linux", arch: "arm64" },
      ] as const;

      for (const target of targets) {
        const bundle = await packageReleaseBundle({
          version: "0.2.0",
          gitSha: "a7338e65fa30a37748d0acde86a6fc6c0fc3ba49",
          platform: target.platform,
          arch: target.arch,
          outDir,
        });

        expect(bundle.bundlePath).toBeDefined();
        expect(existsSync(bundle.bundlePath)).toBe(true);
        expect(bundle.manifest.version).toBe("0.2.0");
        expect(bundle.manifest.gitSha).toBe("a7338e65fa30a37748d0acde86a6fc6c0fc3ba49");
        expect(bundle.manifest.platform).toBe(target.platform);
        expect(bundle.manifest.arch).toBe(target.arch);

        const bundleContent = JSON.parse(readFileSync(bundle.bundlePath, "utf-8"));
        expect(bundleContent.components).toEqual(["backend", "engine-host", "launcher", "cli"]);
      }
    });

    test("pre-migration SQLite snapshot (console.db.pre-vX.X.X.bak) is created automatically before schema upgrade", async () => {
      const { runDatabaseMigrationWithSnapshot } =
        await import("../../apps/backend/src/registry/migration");
      const dbPath = join(tempDir, "console.db");

      // Create v1 database with initial table and data
      const db1 = new DatabaseSync(dbPath);
      db1.exec("PRAGMA user_version = 1;");
      db1.exec("CREATE TABLE test_data (id TEXT PRIMARY KEY, value TEXT);");
      db1.exec("INSERT INTO test_data VALUES ('item-1', 'initial-state');");
      db1.close();

      // Run migration to v2: should automatically create pre-v1.0.0.bak snapshot
      const migrationResult = runDatabaseMigrationWithSnapshot({
        dbPath,
        currentVersion: "1.0.0",
        targetVersion: "2.0.0",
        migrate: (db) => {
          db.exec("ALTER TABLE test_data ADD COLUMN description TEXT DEFAULT 'none';");
          db.exec("PRAGMA user_version = 2;");
        },
      });

      expect(migrationResult.success).toBe(true);
      expect(migrationResult.snapshotPath).toBeDefined();
      expect(existsSync(migrationResult.snapshotPath)).toBe(true);
      expect(migrationResult.snapshotPath).toContain("console.db.pre-v1.0.0.bak");

      // Verify target db was upgraded
      const db2 = new DatabaseSync(dbPath);
      const userVersion = db2.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(userVersion.user_version).toBe(2);
      db2.close();

      // Verify snapshot has original schema and data intact
      const snapshotDb = new DatabaseSync(migrationResult.snapshotPath);
      const snapshotVersion = snapshotDb.prepare("PRAGMA user_version;").get() as {
        user_version: number;
      };
      expect(snapshotVersion.user_version).toBe(1);
      const row = snapshotDb.prepare("SELECT * FROM test_data WHERE id = 'item-1';").get() as any;
      expect(row.value).toBe("initial-state");
      expect(row).not.toHaveProperty("description");
      snapshotDb.close();
    });

    test("pre-migration failure preserves existing data and halts dispatch", async () => {
      const { runDatabaseMigrationWithSnapshot } =
        await import("../../apps/backend/src/registry/migration");
      const dbPath = join(tempDir, "console-fail.db");

      // Initial database
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA user_version = 1;");
      db.exec("CREATE TABLE test_fail (id TEXT PRIMARY KEY);");
      db.exec("INSERT INTO test_fail VALUES ('preserve-me');");
      db.close();

      // Intentionally failing migration
      expect(() => {
        runDatabaseMigrationWithSnapshot({
          dbPath,
          currentVersion: "1.0.0",
          targetVersion: "2.0.0",
          migrate: () => {
            throw new Error("intentional_migration_syntax_error");
          },
        });
      }).toThrow(/intentional_migration_syntax_error/);

      // Database should remain at version 1 with data intact
      const checkDb = new DatabaseSync(dbPath);
      const version = checkDb.prepare("PRAGMA user_version;").get() as { user_version: number };
      expect(version.user_version).toBe(1);
      const row = checkDb.prepare("SELECT * FROM test_fail WHERE id = 'preserve-me';").get() as any;
      expect(row.id).toBe("preserve-me");
      checkDb.close();
    });

    test("rollback command atomically restores previous binary and pre-migration snapshot upon operator confirmation", async () => {
      const { rollbackDatabaseAndBinary } =
        await import("../../apps/backend/src/registry/migration");
      const dbPath = join(tempDir, "console-rb.db");
      const snapshotPath = join(tempDir, "console-rb.db.pre-v1.0.0.bak");

      // Setup snapshot (v1)
      const snapDb = new DatabaseSync(snapshotPath);
      snapDb.exec("PRAGMA user_version = 1;");
      snapDb.exec("CREATE TABLE rb_table (id TEXT PRIMARY KEY, state TEXT);");
      snapDb.exec("INSERT INTO rb_table VALUES ('key', 'v1-original');");
      snapDb.close();

      // Setup corrupted/unwanted current db (v2)
      const curDb = new DatabaseSync(dbPath);
      curDb.exec("PRAGMA user_version = 2;");
      curDb.exec("CREATE TABLE rb_table (id TEXT PRIMARY KEY, state TEXT, v2col TEXT);");
      curDb.exec("INSERT INTO rb_table VALUES ('key', 'v2-damaged', 'extra');");
      curDb.close();

      // Refuses rollback without explicit operator confirmation
      expect(() => {
        rollbackDatabaseAndBinary({
          dbPath,
          snapshotPath,
          confirm: false,
        });
      }).toThrow(/operator_confirmation_required/);

      // Rollback with operator confirmation restores v1 database
      const rollbackResult = rollbackDatabaseAndBinary({
        dbPath,
        snapshotPath,
        confirm: true,
      });

      expect(rollbackResult.restored).toBe(true);

      // Verify db is restored to v1
      const restoredDb = new DatabaseSync(dbPath);
      const restoredVersion = restoredDb.prepare("PRAGMA user_version;").get() as {
        user_version: number;
      };
      expect(restoredVersion.user_version).toBe(1);
      const restoredRow = restoredDb
        .prepare("SELECT * FROM rb_table WHERE id = 'key';")
        .get() as any;
      expect(restoredRow.state).toBe("v1-original");
      expect(restoredRow).not.toHaveProperty("v2col");
      restoredDb.close();
    });
  });

  describe("AC6 (Parent AC26): Operational Guidance Reconciliation to TypeScript/Bun", () => {
    test("operational guidance and runtime documentation use TypeScript/Bun commands", () => {
      const runtimeDoc = readFileSync(join(process.cwd(), "docs/runtime.md"), "utf-8");
      const readmeDoc = readFileSync(join(process.cwd(), "README.md"), "utf-8");

      // Verify guidance mentions Bun / TypeScript commands
      expect(runtimeDoc).toContain("bun");
      expect(readmeDoc).toContain("bun");

      // Reconciles legacy python commands
      expect(runtimeDoc).not.toContain("python3 app.py");
      expect(readmeDoc).not.toContain("python3 app.py");
    });
  });

  describe("Issue #85: Open-Source Governance, Community Templates, and Workspace Package Edges", () => {
    test("AC1: checkWorkspacePackageEdges validates clean repository edges cleanly", async () => {
      const { checkWorkspacePackageEdges } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      const result = checkWorkspacePackageEdges(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test("AC1 & AC4: checkWorkspacePackageEdges fails closed on forbidden dependency edges across workspace packages", async () => {
      const { checkWorkspacePackageEdges } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      const initCleanWorkspace = (root: string) => {
        const pkgs = [
          "packages/contracts",
          "packages/client",
          "apps/backend",
          "apps/engine-host",
          "apps/launcher",
        ];
        for (const p of pkgs) {
          const dir = join(root, p);
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, "package.json"), JSON.stringify({ name: p, dependencies: {} }));
        }
      };

      // 1. contracts -> @labq/backend
      {
        const caseDir = join(tempDir, "case-contracts-backend");
        initCleanWorkspace(caseDir);
        writeFileSync(
          join(caseDir, "packages/contracts/package.json"),
          JSON.stringify({
            name: "@labq/contracts",
            dependencies: { "@labq/backend": "workspace:*" },
          }),
        );
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(
          res.violations.some(
            (v: string) => v.includes("packages/contracts") && v.includes("@labq/backend"),
          ),
        ).toBe(true);
      }

      // 2. contracts -> @labq/client in devDependencies
      {
        const caseDir = join(tempDir, "case-contracts-client");
        initCleanWorkspace(caseDir);
        writeFileSync(
          join(caseDir, "packages/contracts/package.json"),
          JSON.stringify({
            name: "@labq/contracts",
            devDependencies: { "@labq/client": "workspace:*" },
          }),
        );
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(
          res.violations.some(
            (v: string) => v.includes("packages/contracts") && v.includes("@labq/client"),
          ),
        ).toBe(true);
      }

      // 3. client -> @labq/launcher in peerDependencies
      {
        const caseDir = join(tempDir, "case-client-launcher");
        initCleanWorkspace(caseDir);
        writeFileSync(
          join(caseDir, "packages/client/package.json"),
          JSON.stringify({
            name: "@labq/client",
            peerDependencies: { "@labq/launcher": "workspace:*" },
          }),
        );
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(
          res.violations.some(
            (v: string) => v.includes("packages/client") && v.includes("@labq/launcher"),
          ),
        ).toBe(true);
      }

      // 4. backend -> @labq/engine-host in optionalDependencies
      {
        const caseDir = join(tempDir, "case-backend-engine");
        initCleanWorkspace(caseDir);
        writeFileSync(
          join(caseDir, "apps/backend/package.json"),
          JSON.stringify({
            name: "@labq/backend",
            optionalDependencies: { "@labq/engine-host": "workspace:*" },
          }),
        );
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(
          res.violations.some(
            (v: string) => v.includes("apps/backend") && v.includes("@labq/engine-host"),
          ),
        ).toBe(true);
      }

      // 5. engine-host -> @labq/backend in dependencies
      {
        const caseDir = join(tempDir, "case-engine-backend");
        initCleanWorkspace(caseDir);
        writeFileSync(
          join(caseDir, "apps/engine-host/package.json"),
          JSON.stringify({
            name: "@labq/engine-host",
            dependencies: { "@labq/backend": "workspace:*" },
          }),
        );
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(
          res.violations.some(
            (v: string) => v.includes("apps/engine-host") && v.includes("@labq/backend"),
          ),
        ).toBe(true);
      }

      // 6. Missing package.json fails closed
      {
        const caseDir = join(tempDir, "case-missing-pkg");
        mkdirSync(caseDir, { recursive: true });
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(res.violations.length).toBeGreaterThan(0);
        expect(res.violations[0]).toContain("package.json missing");
      }

      // 7. Malformed package.json fails closed
      {
        const caseDir = join(tempDir, "case-malformed-pkg");
        initCleanWorkspace(caseDir);
        writeFileSync(join(caseDir, "packages/contracts/package.json"), "{ malformed json");
        const res = checkWorkspacePackageEdges(caseDir);
        expect(res.ok).toBe(false);
        expect(res.violations.some((v: string) => v.includes("failed to parse package.json"))).toBe(
          true,
        );
      }
    });

    test("AC2 & AC3: checkOpenSourceGovernanceFiles validates required governance baseline files on repository", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      const result = checkOpenSourceGovernanceFiles(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations).toHaveLength(0);

      // Verify specific governance file invariants directly
      const license = readFileSync(join(process.cwd(), "LICENSE"), "utf-8");
      expect(license).toContain("MIT License");
      expect(license).toContain("Permission is hereby granted");

      const contributing = readFileSync(join(process.cwd(), "CONTRIBUTING.md"), "utf-8");
      expect(contributing).toContain("26.8.1");
      expect(contributing).toContain("1.4.2");
      expect(contributing).toContain("labq-factory setup --local-only");
      expect(contributing).toContain("bun run check");
      expect(contributing).toContain("bun run test");
      expect(contributing).toContain("bun run verify");
      expect(contributing).toContain("@labq/contracts");
      expect(contributing).toContain("@labq/client");
      expect(contributing).toContain("apps/backend");
      expect(contributing).toContain("apps/engine-host");

      const security = readFileSync(join(process.cwd(), "SECURITY.md"), "utf-8");
      expect(security).toContain("Security Policy");
      expect(security).toContain("Reporting a Vulnerability");
      expect(security).toContain("127.0.0.1");

      const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf-8");
      expect(changelog).toContain("# Changelog");

      const gitattributes = readFileSync(join(process.cwd(), ".gitattributes"), "utf-8");
      expect(gitattributes).toContain("eol=lf");

      const renovate = JSON.parse(readFileSync(join(process.cwd(), "renovate.json"), "utf-8"));
      expect(renovate.lockFileMaintenance.enabled).toBe(true);
      expect(renovate.osvVulnerabilityAlerts).toBe(true);
      expect(
        renovate.packageRules.some(
          (r: any) => r.matchDepTypes?.includes("overrides") && r.major?.enabled === false,
        ),
      ).toBe(true);

      const prTmpl = readFileSync(join(process.cwd(), ".github/pull_request_template.md"), "utf-8");
      expect(prTmpl).toContain("## Evidence");
      expect(prTmpl).toContain("## Problem and Outcome");

      const bugTmpl = readFileSync(
        join(process.cwd(), ".github/ISSUE_TEMPLATE/bug_report.md"),
        "utf-8",
      );
      expect(bugTmpl).toContain("labels: needs-triage");
      expect(bugTmpl).not.toContain("ready-for-agent");
      expect(bugTmpl).toContain("## Source and problem");
      expect(bugTmpl).toContain("## Outcome");
      expect(bugTmpl).toContain("## Invariants");
      expect(bugTmpl).toContain("## Acceptance criteria");
      expect(bugTmpl).toContain("## Boundary");
      expect(bugTmpl).toContain("Depends on:");

      const featTmpl = readFileSync(
        join(process.cwd(), ".github/ISSUE_TEMPLATE/feature_request.md"),
        "utf-8",
      );
      expect(featTmpl).toContain("labels: needs-triage");
      expect(featTmpl).not.toContain("ready-for-agent");
      expect(featTmpl).toContain("## Source and problem");
      expect(featTmpl).toContain("## Outcome");
      expect(featTmpl).toContain("## Invariants");
      expect(featTmpl).toContain("## Acceptance criteria");
      expect(featTmpl).toContain("## Boundary");
      expect(featTmpl).toContain("Depends on:");
    });

    test("AC4: checkOpenSourceGovernanceFiles fails closed on missing or invalid governance files", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      // 1. Empty directory reports all missing files
      const emptyDir = join(tempDir, "case-empty-gov");
      mkdirSync(emptyDir, { recursive: true });
      const emptyRes = checkOpenSourceGovernanceFiles(emptyDir);
      expect(emptyRes.ok).toBe(false);
      expect(emptyRes.violations.length).toBeGreaterThanOrEqual(8);
      expect(emptyRes.violations.some((v: string) => v.includes("LICENSE"))).toBe(true);
      expect(emptyRes.violations.some((v: string) => v.includes("CONTRIBUTING.md"))).toBe(true);
      expect(emptyRes.violations.some((v: string) => v.includes("renovate.json"))).toBe(true);

      // 2. Invalid renovate configuration fails closed
      const badRenovateDir = join(tempDir, "case-bad-renovate");
      mkdirSync(badRenovateDir, { recursive: true });
      writeFileSync(
        join(badRenovateDir, "renovate.json"),
        JSON.stringify({
          lockFileMaintenance: { enabled: false },
          osvVulnerabilityAlerts: false,
        }),
      );
      const badRenovateRes = checkOpenSourceGovernanceFiles(badRenovateDir);
      expect(badRenovateRes.ok).toBe(false);
      expect(
        badRenovateRes.violations.some((v: string) =>
          v.includes("lockFileMaintenance.enabled: true"),
        ),
      ).toBe(true);
      expect(
        badRenovateRes.violations.some((v: string) => v.includes("osvVulnerabilityAlerts: true")),
      ).toBe(true);
      expect(
        badRenovateRes.violations.some((v: string) =>
          v.includes("disable major updates for overrides"),
        ),
      ).toBe(true);

      // 3. Issue template with illegal ready-for-agent label default fails closed
      const badTmplDir = join(tempDir, "case-bad-template");
      mkdirSync(join(badTmplDir, ".github/ISSUE_TEMPLATE"), { recursive: true });
      writeFileSync(
        join(badTmplDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        `---\nname: Bug\nlabels: ready-for-agent\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\nDepends on:\n`,
      );
      const badTmplRes = checkOpenSourceGovernanceFiles(badTmplDir);
      expect(badTmplRes.ok).toBe(false);
      expect(
        badTmplRes.violations.some((v: string) =>
          v.includes("NEVER default labels to 'ready-for-agent'"),
        ),
      ).toBe(true);
    });

    test("AC4 / Review Dispositions (D1-D4): checkOpenSourceGovernanceFiles enforces substantive validity against probes R1-R4", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      // Helper to initialize a fully valid governance directory
      function createValidGovDir(dirPath: string) {
        mkdirSync(join(dirPath, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dirPath, "LICENSE"),
          readFileSync(join(process.cwd(), "LICENSE"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "CONTRIBUTING.md"),
          readFileSync(join(process.cwd(), "CONTRIBUTING.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "SECURITY.md"),
          readFileSync(join(process.cwd(), "SECURITY.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "CHANGELOG.md"),
          readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".gitattributes"),
          readFileSync(join(process.cwd(), ".gitattributes"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "renovate.json"),
          readFileSync(join(process.cwd(), "renovate.json"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/pull_request_template.md"),
          readFileSync(join(process.cwd(), ".github/pull_request_template.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/ISSUE_TEMPLATE/bug_report.md"),
          readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/bug_report.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/ISSUE_TEMPLATE/feature_request.md"),
          readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/feature_request.md"), "utf-8"),
        );
      }

      // D1 (Probe R2): LICENSE replaced with only 'MIT License\n' (missing substantive grant and terms)
      const d1Dir = join(tempDir, "probe-r2-license");
      createValidGovDir(d1Dir);
      writeFileSync(join(d1Dir, "LICENSE"), "MIT License\n");
      const d1Res = checkOpenSourceGovernanceFiles(d1Dir);
      expect(d1Res.ok).toBe(false);
      expect(d1Res.violations).toContain("LICENSE does not specify a valid MIT license");

      // D2 (Probe R1): .gitattributes replaced with comment-only '# eol=lf\n'
      const d2Dir = join(tempDir, "probe-r1-gitattributes");
      createValidGovDir(d2Dir);
      writeFileSync(join(d2Dir, ".gitattributes"), "# eol=lf\n");
      const d2Res = checkOpenSourceGovernanceFiles(d2Dir);
      expect(d2Res.ok).toBe(false);
      expect(d2Res.violations).toContain(".gitattributes must enforce LF line endings (eol=lf)");

      // D3 (Probe R3): issue template removes labels from front matter and moves to markdown body comment
      const d3Dir = join(tempDir, "probe-r3-template");
      createValidGovDir(d3Dir);
      writeFileSync(
        join(d3Dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        `---\nname: Bug Report\nabout: Create a report\ntitle: "fix: "\n---\n<!-- labels: needs-triage -->\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\nDepends on:\n`,
      );
      const d3Res = checkOpenSourceGovernanceFiles(d3Dir);
      expect(d3Res.ok).toBe(false);
      expect(
        d3Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D4 (Probe R4): renovate.json appends a matching overrides rule with major.enabled=true
      const d4Dir = join(tempDir, "probe-r4-renovate");
      createValidGovDir(d4Dir);
      const renovateConfig = JSON.parse(
        readFileSync(join(process.cwd(), "renovate.json"), "utf-8"),
      );
      renovateConfig.packageRules.push({
        matchDepTypes: ["overrides"],
        major: { enabled: true },
      });
      writeFileSync(join(d4Dir, "renovate.json"), JSON.stringify(renovateConfig, null, 2));
      const d4Res = checkOpenSourceGovernanceFiles(d4Dir);
      expect(d4Res.ok).toBe(false);
      expect(
        d4Res.violations.some((v: string) =>
          v.includes("disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);
    });

    test("AC4 / Review Dispositions (D5-D7): checkOpenSourceGovernanceFiles enforces effective LF attributes, parsed front-matter labels, and broad Renovate overrides policies against probes R5-R7", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      function createValidGovDir(dirPath: string) {
        mkdirSync(join(dirPath, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dirPath, "LICENSE"),
          readFileSync(join(process.cwd(), "LICENSE"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "CONTRIBUTING.md"),
          readFileSync(join(process.cwd(), "CONTRIBUTING.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "SECURITY.md"),
          readFileSync(join(process.cwd(), "SECURITY.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "CHANGELOG.md"),
          readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".gitattributes"),
          readFileSync(join(process.cwd(), ".gitattributes"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, "renovate.json"),
          readFileSync(join(process.cwd(), "renovate.json"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/pull_request_template.md"),
          readFileSync(join(process.cwd(), ".github/pull_request_template.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/ISSUE_TEMPLATE/bug_report.md"),
          readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/bug_report.md"), "utf-8"),
        );
        writeFileSync(
          join(dirPath, ".github/ISSUE_TEMPLATE/feature_request.md"),
          readFileSync(join(process.cwd(), ".github/ISSUE_TEMPLATE/feature_request.md"), "utf-8"),
        );
      }

      // --- D5: Effective LF attributes in .gitattributes (Probe R5) ---
      // D5.1: Probe R5 - baseline LF followed by * text eol=crlf
      const d5Dir = join(tempDir, "probe-r5-gitattr-effective");
      createValidGovDir(d5Dir);
      writeFileSync(join(d5Dir, ".gitattributes"), "* text=auto eol=lf\n* text eol=crlf\n");
      const d5Res = checkOpenSourceGovernanceFiles(d5Dir);
      expect(d5Res.ok).toBe(false);
      expect(
        d5Res.violations.some((v: string) =>
          v.includes("conflicting non-LF line ending rule: '* text eol=crlf'"),
        ),
      ).toBe(true);
      expect(
        d5Res.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);

      // D5.2: Conflicting rule on specific extension
      const d5ExtDir = join(tempDir, "probe-r5-gitattr-ext");
      createValidGovDir(d5ExtDir);
      writeFileSync(join(d5ExtDir, ".gitattributes"), "* text=auto eol=lf\n*.sh text eol=crlf\n");
      const d5ExtRes = checkOpenSourceGovernanceFiles(d5ExtDir);
      expect(d5ExtRes.ok).toBe(false);
      expect(
        d5ExtRes.violations.some((v: string) =>
          v.includes("conflicting non-LF line ending rule: '*.sh text eol=crlf'"),
        ),
      ).toBe(true);
      expect(
        d5ExtRes.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);

      // D5.3: Non-LF native eol
      const d5NativeDir = join(tempDir, "probe-r5-gitattr-native");
      createValidGovDir(d5NativeDir);
      writeFileSync(join(d5NativeDir, ".gitattributes"), "* text=auto eol=native\n");
      const d5NativeRes = checkOpenSourceGovernanceFiles(d5NativeDir);
      expect(d5NativeRes.ok).toBe(false);
      expect(
        d5NativeRes.violations.some((v: string) =>
          v.includes("conflicting non-LF line ending rule: '* text=auto eol=native'"),
        ),
      ).toBe(true);

      // --- D6: Front-matter labels parsing & exact membership (Probe R6) ---
      // D6.1: Probe R6 - empty scalar with comment 'labels: "" # needs-triage'
      const d6Dir = join(tempDir, "probe-r6-empty-comment-label");
      createValidGovDir(d6Dir);
      const bugTmplPath = join(d6Dir, ".github/ISSUE_TEMPLATE/bug_report.md");
      const baseBugTmpl = readFileSync(bugTmplPath, "utf-8");
      writeFileSync(
        bugTmplPath,
        baseBugTmpl.replace("labels: needs-triage", 'labels: "" # needs-triage'),
      );
      const d6Res = checkOpenSourceGovernanceFiles(d6Dir);
      expect(d6Res.ok).toBe(false);
      expect(
        d6Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D6.2: Single-quoted empty scalar with comment 'labels: \'\' # needs-triage'
      const d6SingleQuoteDir = join(tempDir, "probe-r6-single-quote");
      createValidGovDir(d6SingleQuoteDir);
      writeFileSync(
        join(d6SingleQuoteDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseBugTmpl.replace("labels: needs-triage", "labels: '' # needs-triage"),
      );
      const d6SingleQuoteRes = checkOpenSourceGovernanceFiles(d6SingleQuoteDir);
      expect(d6SingleQuoteRes.ok).toBe(false);
      expect(
        d6SingleQuoteRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D6.3: Empty unquoted value with comment 'labels: # needs-triage'
      const d6NoValDir = join(tempDir, "probe-r6-no-val");
      createValidGovDir(d6NoValDir);
      writeFileSync(
        join(d6NoValDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseBugTmpl.replace("labels: needs-triage", "labels: # needs-triage"),
      );
      const d6NoValRes = checkOpenSourceGovernanceFiles(d6NoValDir);
      expect(d6NoValRes.ok).toBe(false);
      expect(
        d6NoValRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D6.4: Valid supported forms: quoted string, inline list, block sequence
      const d6ValidQuoted = join(tempDir, "probe-d6-valid-quoted");
      createValidGovDir(d6ValidQuoted);
      writeFileSync(
        join(d6ValidQuoted, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseBugTmpl.replace("labels: needs-triage", 'labels: "needs-triage"'),
      );
      expect(checkOpenSourceGovernanceFiles(d6ValidQuoted).ok).toBe(true);

      const d6ValidInlineList = join(tempDir, "probe-d6-valid-inlinelist");
      createValidGovDir(d6ValidInlineList);
      writeFileSync(
        join(d6ValidInlineList, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseBugTmpl.replace("labels: needs-triage", 'labels: ["needs-triage"]'),
      );
      expect(checkOpenSourceGovernanceFiles(d6ValidInlineList).ok).toBe(true);

      const d6ValidBlockSeq = join(tempDir, "probe-d6-valid-blockseq");
      createValidGovDir(d6ValidBlockSeq);
      writeFileSync(
        join(d6ValidBlockSeq, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseBugTmpl.replace("labels: needs-triage", "labels:\n  - needs-triage # primary label"),
      );
      expect(checkOpenSourceGovernanceFiles(d6ValidBlockSeq).ok).toBe(true);

      // --- D7: Renovate policy validation & broad matching rules (Probe R7) ---
      // D7.1: Probe R7 - append matchPackageNames: ["*"] with major.enabled: true
      const d7Dir = join(tempDir, "probe-r7-renovate-broad-pkg");
      createValidGovDir(d7Dir);
      const d7Config = JSON.parse(readFileSync(join(d7Dir, "renovate.json"), "utf-8"));
      d7Config.packageRules.push({ matchPackageNames: ["*"], major: { enabled: true } });
      writeFileSync(join(d7Dir, "renovate.json"), JSON.stringify(d7Config, null, 2));
      const d7Res = checkOpenSourceGovernanceFiles(d7Dir);
      expect(d7Res.ok).toBe(false);
      expect(
        d7Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D7.2: Wildcard matchDepTypes: ["*"] with major.enabled: true
      const d7WildcardDir = join(tempDir, "probe-r7-renovate-wildcard-dep");
      createValidGovDir(d7WildcardDir);
      const d7WildcardConfig = JSON.parse(
        readFileSync(join(d7WildcardDir, "renovate.json"), "utf-8"),
      );
      d7WildcardConfig.packageRules.push({
        matchDepTypes: ["*"],
        major: { enabled: true },
      });
      writeFileSync(
        join(d7WildcardDir, "renovate.json"),
        JSON.stringify(d7WildcardConfig, null, 2),
      );
      const d7WildcardRes = checkOpenSourceGovernanceFiles(d7WildcardDir);
      expect(d7WildcardRes.ok).toBe(false);
      expect(
        d7WildcardRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D7.3: Permitted rule targeting non-overrides dependency type (e.g. dependencies)
      const d7PermittedDir = join(tempDir, "probe-r7-renovate-permitted");
      createValidGovDir(d7PermittedDir);
      const d7PermittedConfig = JSON.parse(
        readFileSync(join(d7PermittedDir, "renovate.json"), "utf-8"),
      );
      d7PermittedConfig.packageRules.push({
        matchDepTypes: ["dependencies"],
        major: { enabled: true },
      });
      writeFileSync(
        join(d7PermittedDir, "renovate.json"),
        JSON.stringify(d7PermittedConfig, null, 2),
      );
      expect(checkOpenSourceGovernanceFiles(d7PermittedDir).ok).toBe(true);

      // D7.4: Broad rule placed before overrides rule preserves effective safety
      const d7OrderDir = join(tempDir, "probe-r7-renovate-order");
      createValidGovDir(d7OrderDir);
      const d7OrderConfig = JSON.parse(readFileSync(join(d7OrderDir, "renovate.json"), "utf-8"));
      d7OrderConfig.packageRules = [
        { matchPackageNames: ["*"], major: { enabled: true } },
        { matchDepTypes: ["overrides"], major: { enabled: false } },
      ];
      writeFileSync(join(d7OrderDir, "renovate.json"), JSON.stringify(d7OrderConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d7OrderDir).ok).toBe(true);
    });
  });
});
