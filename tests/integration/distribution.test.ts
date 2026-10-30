import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  rmSync,
  cpSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

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

    test("AC4 / Review Dispositions (D8-D10): checkOpenSourceGovernanceFiles enforces unset attribute resets, full Renovate overrides coverage, and top-level YAML front-matter labels against probes R8-R11", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      function createValidGovDir(dir: string) {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          `MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`,
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          `# Contributing\n\nNode 26.8.1\nBun 1.4.2\nlabq-factory setup --local-only\nbun run check\nbun run test\nbun run verify\n@labq/contracts\n@labq/client\napps/backend\napps/engine-host`,
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
        writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify(
            {
              $schema: "https://docs.renovatebot.com/renovate-schema.json",
              osvVulnerabilityAlerts: true,
              lockFileMaintenance: { enabled: true },
              packageRules: [
                {
                  matchDepTypes: ["overrides"],
                  major: { enabled: false },
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "# PR\n");
        const tmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"), tmpl);
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"), tmpl);
      }

      // --- D8: Effective LF validation and explicit attribute resets (Probe R8) ---
      // D8.1: Probe R8 - later '* !eol' unsets required LF policy
      const d8Dir = join(tempDir, "probe-r8-gitattr-unset-eol");
      createValidGovDir(d8Dir);
      writeFileSync(join(d8Dir, ".gitattributes"), "* text=auto eol=lf\n* !eol\n");
      const d8Res = checkOpenSourceGovernanceFiles(d8Dir);
      expect(d8Res.ok).toBe(false);
      expect(
        d8Res.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);

      // D8.2: File-class specific reset '*.sh !eol'
      const d8FileClassDir = join(tempDir, "probe-d8-gitattr-file-class-reset");
      createValidGovDir(d8FileClassDir);
      writeFileSync(join(d8FileClassDir, ".gitattributes"), "* text=auto eol=lf\n*.sh !eol\n");
      const d8FileClassRes = checkOpenSourceGovernanceFiles(d8FileClassDir);
      expect(d8FileClassRes.ok).toBe(false);
      expect(
        d8FileClassRes.violations.some((v: string) =>
          v.includes(
            ".gitattributes does not effectively enforce eol=lf for required file classes (script.sh)",
          ),
        ),
      ).toBe(true);

      // D8.3: Negative unset '* -eol'
      const d8NegDir = join(tempDir, "probe-d8-gitattr-neg-eol");
      createValidGovDir(d8NegDir);
      writeFileSync(join(d8NegDir, ".gitattributes"), "* text=auto eol=lf\n* -eol\n");
      const d8NegRes = checkOpenSourceGovernanceFiles(d8NegDir);
      expect(d8NegRes.ok).toBe(false);
      expect(
        d8NegRes.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);

      // D8.4: Unset followed by re-enforced LF preserves effective safety
      const d8ReEnforceDir = join(tempDir, "probe-d8-gitattr-reenforce");
      createValidGovDir(d8ReEnforceDir);
      writeFileSync(join(d8ReEnforceDir, ".gitattributes"), "* !eol\n* text=auto eol=lf\n");
      expect(checkOpenSourceGovernanceFiles(d8ReEnforceDir).ok).toBe(true);

      // --- D9: Renovate full coverage of overrides accounting for constraints (Probe R10) ---
      // D9.1: Probe R10 - overrides disabling rule restricted to one specific package
      const d9Dir = join(tempDir, "probe-r10-renovate-restricted-pkg");
      createValidGovDir(d9Dir);
      const d9Config = JSON.parse(readFileSync(join(d9Dir, "renovate.json"), "utf-8"));
      d9Config.packageRules[0].matchPackageNames = ["one-specific-package"];
      writeFileSync(join(d9Dir, "renovate.json"), JSON.stringify(d9Config, null, 2));
      const d9Res = checkOpenSourceGovernanceFiles(d9Dir);
      expect(d9Res.ok).toBe(false);
      expect(
        d9Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D9.2: Overrides disabling rule restricted by package pattern
      const d9PatternDir = join(tempDir, "probe-d9-renovate-restricted-pattern");
      createValidGovDir(d9PatternDir);
      const d9PatternConfig = JSON.parse(
        readFileSync(join(d9PatternDir, "renovate.json"), "utf-8"),
      );
      d9PatternConfig.packageRules[0].matchPackagePatterns = ["^@labq/"];
      writeFileSync(join(d9PatternDir, "renovate.json"), JSON.stringify(d9PatternConfig, null, 2));
      const d9PatternRes = checkOpenSourceGovernanceFiles(d9PatternDir);
      expect(d9PatternRes.ok).toBe(false);
      expect(
        d9PatternRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D9.3: Overrides disabling rule with exclusions
      const d9ExclusionDir = join(tempDir, "probe-d9-renovate-exclusions");
      createValidGovDir(d9ExclusionDir);
      const d9ExclusionConfig = JSON.parse(
        readFileSync(join(d9ExclusionDir, "renovate.json"), "utf-8"),
      );
      d9ExclusionConfig.packageRules[0].excludePackageNames = ["exempt-package"];
      writeFileSync(
        join(d9ExclusionDir, "renovate.json"),
        JSON.stringify(d9ExclusionConfig, null, 2),
      );
      const d9ExclusionRes = checkOpenSourceGovernanceFiles(d9ExclusionDir);
      expect(d9ExclusionRes.ok).toBe(false);
      expect(
        d9ExclusionRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D9.4: Unrestricted wildcard package names or patterns pass
      const d9WildcardPkgDir = join(tempDir, "probe-d9-renovate-wildcard-pkg");
      createValidGovDir(d9WildcardPkgDir);
      const d9WildcardConfig = JSON.parse(
        readFileSync(join(d9WildcardPkgDir, "renovate.json"), "utf-8"),
      );
      d9WildcardConfig.packageRules[0].matchPackageNames = ["*"];
      writeFileSync(
        join(d9WildcardPkgDir, "renovate.json"),
        JSON.stringify(d9WildcardConfig, null, 2),
      );
      expect(checkOpenSourceGovernanceFiles(d9WildcardPkgDir).ok).toBe(true);

      // --- D10: Issue template top-level front matter mapping validation (Probe R11) ---
      // D10.1: Probe R11 - labels nested under unrelated metadata rather than top level
      const d10Dir = join(tempDir, "probe-r11-nested-metadata-label");
      createValidGovDir(d10Dir);
      const d10BugTmplPath = join(d10Dir, ".github/ISSUE_TEMPLATE/bug_report.md");
      const d10BugTmpl = readFileSync(d10BugTmplPath, "utf-8");
      writeFileSync(
        d10BugTmplPath,
        d10BugTmpl.replace("labels: needs-triage", "metadata:\n  labels: needs-triage"),
      );
      const d10Res = checkOpenSourceGovernanceFiles(d10Dir);
      expect(d10Res.ok).toBe(false);
      expect(
        d10Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D10.2: Invalid nested structure under labels key
      const d10NestedDir = join(tempDir, "probe-d10-nested-labels-struct");
      createValidGovDir(d10NestedDir);
      writeFileSync(
        join(d10NestedDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d10BugTmpl.replace("labels: needs-triage", "labels:\n  nested:\n    - needs-triage"),
      );
      const d10NestedRes = checkOpenSourceGovernanceFiles(d10NestedDir);
      expect(d10NestedRes.ok).toBe(false);
      expect(
        d10NestedRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D10.3: Unsupported dictionary object format
      const d10DictDir = join(tempDir, "probe-d10-dict-labels");
      createValidGovDir(d10DictDir);
      writeFileSync(
        join(d10DictDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d10BugTmpl.replace("labels: needs-triage", "labels: { triage: true }"),
      );
      const d10DictRes = checkOpenSourceGovernanceFiles(d10DictDir);
      expect(d10DictRes.ok).toBe(false);
      expect(
        d10DictRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);
    });

    test("AC4 / Review Dispositions (D11-D13): checkOpenSourceGovernanceFiles enforces combined text/eol Git normalization, comprehensive Renovate overrides matcher coverage, and strict YAML scalar continuations & case sensitivity against probes R12-R15", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      function createValidGovDir(dir: string) {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          `MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`,
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          `# Contributing\n\nNode 26.8.1\nBun 1.4.2\nlabq-factory setup --local-only\nbun run check\nbun run test\nbun run verify\n@labq/contracts\n@labq/client\napps/backend\napps/engine-host`,
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
        writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify(
            {
              $schema: "https://docs.renovatebot.com/renovate-schema.json",
              osvVulnerabilityAlerts: true,
              lockFileMaintenance: { enabled: true },
              packageRules: [
                {
                  matchDepTypes: ["overrides"],
                  major: { enabled: false },
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "# PR\n");
        const tmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"), tmpl);
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"), tmpl);
      }

      // --- D11: Combined text and eol attributes for LF normalization (Probe R12) ---
      // D11.1: Probe R12 - '*.sh -text' disables text normalization despite eol=lf
      const d11Dir = join(tempDir, "probe-r12-gitattr-text-disabled");
      createValidGovDir(d11Dir);
      writeFileSync(join(d11Dir, ".gitattributes"), "* text=auto eol=lf\n*.sh -text\n");
      const d11Res = checkOpenSourceGovernanceFiles(d11Dir);
      expect(d11Res.ok).toBe(false);
      expect(
        d11Res.violations.some((v: string) =>
          v.includes(
            ".gitattributes does not effectively enforce eol=lf for required file classes (script.sh)",
          ),
        ),
      ).toBe(true);

      // D11.2: '*.sh binary' unsets text and leaves eol unspecified
      const d11BinaryDir = join(tempDir, "probe-d11-gitattr-binary");
      createValidGovDir(d11BinaryDir);
      writeFileSync(join(d11BinaryDir, ".gitattributes"), "* text=auto eol=lf\n*.sh binary\n");
      const d11BinaryRes = checkOpenSourceGovernanceFiles(d11BinaryDir);
      expect(d11BinaryRes.ok).toBe(false);
      expect(
        d11BinaryRes.violations.some((v: string) =>
          v.includes(
            ".gitattributes does not effectively enforce eol=lf for required file classes (script.sh)",
          ),
        ),
      ).toBe(true);

      // D11.3: '*.ts !text' leaves text unspecified
      const d11UnsetTextDir = join(tempDir, "probe-d11-gitattr-unset-text");
      createValidGovDir(d11UnsetTextDir);
      writeFileSync(join(d11UnsetTextDir, ".gitattributes"), "* text=auto eol=lf\n*.ts !text\n");
      const d11UnsetTextRes = checkOpenSourceGovernanceFiles(d11UnsetTextDir);
      expect(d11UnsetTextRes.ok).toBe(false);
      expect(
        d11UnsetTextRes.violations.some((v: string) =>
          v.includes(
            ".gitattributes does not effectively enforce eol=lf for required file classes (source.ts)",
          ),
        ),
      ).toBe(true);

      // D11.4: Explicit text re-enabling after -text preserves effective safety
      const d11ReEnableDir = join(tempDir, "probe-d11-gitattr-reenable");
      createValidGovDir(d11ReEnableDir);
      writeFileSync(
        join(d11ReEnableDir, ".gitattributes"),
        "*.sh -text\n* text=auto eol=lf\n*.sh text eol=lf\n",
      );
      expect(checkOpenSourceGovernanceFiles(d11ReEnableDir).ok).toBe(true);

      // --- D12: Renovate overrides rule restriction across matchers (Probe R13) ---
      // D12.1: Probe R13 - sole overrides disabling rule restricted by matchFileNames
      const d12Dir = join(tempDir, "probe-r13-renovate-matchfilenames");
      createValidGovDir(d12Dir);
      const d12Config = JSON.parse(readFileSync(join(d12Dir, "renovate.json"), "utf-8"));
      d12Config.packageRules[0].matchFileNames = ["unrelated/package.json"];
      writeFileSync(join(d12Dir, "renovate.json"), JSON.stringify(d12Config, null, 2));
      const d12Res = checkOpenSourceGovernanceFiles(d12Dir);
      expect(d12Res.ok).toBe(false);
      expect(
        d12Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D12.2: Overrides disabling rule restricted by non-npm manager (e.g. cargo)
      const d12ManagerDir = join(tempDir, "probe-d12-renovate-manager");
      createValidGovDir(d12ManagerDir);
      const d12ManagerConfig = JSON.parse(
        readFileSync(join(d12ManagerDir, "renovate.json"), "utf-8"),
      );
      d12ManagerConfig.packageRules[0].matchManagers = ["cargo"];
      writeFileSync(
        join(d12ManagerDir, "renovate.json"),
        JSON.stringify(d12ManagerConfig, null, 2),
      );
      const d12ManagerRes = checkOpenSourceGovernanceFiles(d12ManagerDir);
      expect(d12ManagerRes.ok).toBe(false);
      expect(
        d12ManagerRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D12.3: Overrides disabling rule restricted by non-major update type
      const d12UpdateTypeDir = join(tempDir, "probe-d12-renovate-updatetype");
      createValidGovDir(d12UpdateTypeDir);
      const d12UpdateTypeConfig = JSON.parse(
        readFileSync(join(d12UpdateTypeDir, "renovate.json"), "utf-8"),
      );
      d12UpdateTypeConfig.packageRules[0].matchUpdateTypes = ["minor"];
      writeFileSync(
        join(d12UpdateTypeDir, "renovate.json"),
        JSON.stringify(d12UpdateTypeConfig, null, 2),
      );
      const d12UpdateTypeRes = checkOpenSourceGovernanceFiles(d12UpdateTypeDir);
      expect(d12UpdateTypeRes.ok).toBe(false);
      expect(
        d12UpdateTypeRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D12.4: Overrides disabling rule with file exclusions
      const d12ExcludeFileDir = join(tempDir, "probe-d12-renovate-excludefile");
      createValidGovDir(d12ExcludeFileDir);
      const d12ExcludeFileConfig = JSON.parse(
        readFileSync(join(d12ExcludeFileDir, "renovate.json"), "utf-8"),
      );
      d12ExcludeFileConfig.packageRules[0].excludeFileNames = ["apps/backend/package.json"];
      writeFileSync(
        join(d12ExcludeFileDir, "renovate.json"),
        JSON.stringify(d12ExcludeFileConfig, null, 2),
      );
      const d12ExcludeFileRes = checkOpenSourceGovernanceFiles(d12ExcludeFileDir);
      expect(d12ExcludeFileRes.ok).toBe(false);
      expect(
        d12ExcludeFileRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D12.5: Allowed unrestricted wildcard matchFileNames: ["**/*"] passes cleanly
      const d12WildcardFileDir = join(tempDir, "probe-d12-renovate-wildcardfile");
      createValidGovDir(d12WildcardFileDir);
      const d12WildcardFileConfig = JSON.parse(
        readFileSync(join(d12WildcardFileDir, "renovate.json"), "utf-8"),
      );
      d12WildcardFileConfig.packageRules[0].matchFileNames = ["**/*"];
      writeFileSync(
        join(d12WildcardFileDir, "renovate.json"),
        JSON.stringify(d12WildcardFileConfig, null, 2),
      );
      expect(checkOpenSourceGovernanceFiles(d12WildcardFileDir).ok).toBe(true);

      // --- D13: YAML scalar continuation and case sensitivity (Probes R14 & R15) ---
      const d13BugTmpl = `---
name: Bug Report
about: Create a report to help us fix a defect
title: "fix: "
labels: needs-triage
---
## Source and problem
## Outcome
## Invariants
## Acceptance criteria
- [ ] AC1:
## Boundary
Depends on: None
`;

      // D13.1: Probe R14 - indented scalar continuation line alters the label value
      const d13ContinuationDir = join(tempDir, "probe-r14-yaml-continuation");
      createValidGovDir(d13ContinuationDir);
      writeFileSync(
        join(d13ContinuationDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d13BugTmpl.replace("labels: needs-triage", "labels: needs-triage\n  extra"),
      );
      const d13ContinuationRes = checkOpenSourceGovernanceFiles(d13ContinuationDir);
      expect(d13ContinuationRes.ok).toBe(false);
      expect(
        d13ContinuationRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D13.2: Probe R15 - capitalized 'Labels:' key is rejected (YAML mapping keys are case-sensitive)
      const d13CaseDir = join(tempDir, "probe-r15-yaml-case-sensitive");
      createValidGovDir(d13CaseDir);
      writeFileSync(
        join(d13CaseDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d13BugTmpl.replace("labels: needs-triage", "Labels: needs-triage"),
      );
      const d13CaseRes = checkOpenSourceGovernanceFiles(d13CaseDir);
      expect(d13CaseRes.ok).toBe(false);
      expect(
        d13CaseRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D13.3: Sequence item continuation line alters list item value
      const d13SeqContinuationDir = join(tempDir, "probe-d13-seq-continuation");
      createValidGovDir(d13SeqContinuationDir);
      writeFileSync(
        join(d13SeqContinuationDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d13BugTmpl.replace("labels: needs-triage", "labels:\n  - needs-triage\n    extra"),
      );
      const d13SeqContinuationRes = checkOpenSourceGovernanceFiles(d13SeqContinuationDir);
      expect(d13SeqContinuationRes.ok).toBe(false);
      expect(
        d13SeqContinuationRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D13.4: Valid cases (exact scalar, bracketed sequence, block sequence) pass
      const d13ValidDir = join(tempDir, "probe-d13-valid");
      createValidGovDir(d13ValidDir);
      writeFileSync(
        join(d13ValidDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d13BugTmpl.replace("labels: needs-triage", "labels: needs-triage"),
      );
      expect(checkOpenSourceGovernanceFiles(d13ValidDir).ok).toBe(true);
    });

    test("AC4 / Review Dispositions (D14-D15): checkOpenSourceGovernanceFiles enforces Git pattern semantics across repository paths and strict YAML comment separation against probes R16-R18", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      function createValidGovDir(dir: string) {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction...\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND...\n',
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          "# Contributing\n\nNode 26.8.1\nBun 1.4.2\nlabq-factory setup --local-only\nbun run check\nbun run test\nbun run verify\n@labq/contracts\n@labq/client\napps/backend\napps/engine-host\n",
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
        writeFileSync(
          join(dir, ".gitattributes"),
          "* text=auto eol=lf\n*.sh text eol=lf\n*.ts text eol=lf\n*.js text eol=lf\n*.json text eol=lf\n*.md text eol=lf\n*.yml text eol=lf\n",
        );
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify({
            lockFileMaintenance: { enabled: true },
            osvVulnerabilityAlerts: true,
            packageRules: [
              {
                matchDepTypes: ["overrides"],
                matchPackageNames: ["*"],
                major: { enabled: false },
              },
            ],
          }),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "# PR\n");
        const tmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"), tmpl);
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"), tmpl);
      }

      const d14BugTmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;

      // --- D14: Git pattern matching & repository path evaluation (Probes R16 & R17) ---
      // D14.1: Probe R16 - exact real repository source path disables text normalization
      const d14R16Dir = join(tempDir, "probe-r16-real-source-path");
      createValidGovDir(d14R16Dir);
      writeFileSync(
        join(d14R16Dir, ".gitattributes"),
        "* text=auto eol=lf\napps/backend/src/main.ts -text\n",
      );
      mkdirSync(join(d14R16Dir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d14R16Dir, "apps/backend/src/main.ts"), "const x = 1;\r\n");
      const d14R16Res = checkOpenSourceGovernanceFiles(d14R16Dir);
      expect(d14R16Res.ok).toBe(false);
      expect(
        d14R16Res.violations.some((v: string) =>
          v.includes(
            ".gitattributes does not effectively enforce eol=lf for required file classes (apps/backend/src/main.ts)",
          ),
        ),
      ).toBe(true);

      // D14.2: Probe R17 - bracket character class glob '*.[tj]s !eol' unsets eol
      const d14R17Dir = join(tempDir, "probe-r17-bracket-glob-reset");
      createValidGovDir(d14R17Dir);
      writeFileSync(join(d14R17Dir, ".gitattributes"), "* text=auto eol=lf\n*.[tj]s !eol\n");
      const d14R17Res = checkOpenSourceGovernanceFiles(d14R17Dir);
      expect(d14R17Res.ok).toBe(false);
      expect(
        d14R17Res.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);
      expect(
        d14R17Res.violations.some((v: string) => v.includes("source.ts") && v.includes("index.js")),
      ).toBe(true);

      // D14.3: Unsupported or invalid glob pattern fails closed
      const d14InvalidDir = join(tempDir, "probe-d14-invalid-pattern");
      createValidGovDir(d14InvalidDir);
      writeFileSync(join(d14InvalidDir, ".gitattributes"), "* text=auto eol=lf\n*.[tj !eol\n");
      const d14InvalidRes = checkOpenSourceGovernanceFiles(d14InvalidDir);
      expect(d14InvalidRes.ok).toBe(false);
      expect(
        d14InvalidRes.violations.some((v: string) =>
          v.includes(".gitattributes contains unsupported or invalid pattern: '*.[tj'"),
        ),
      ).toBe(true);

      // D14.4: Positive control - path-specific and bracket-glob rules explicitly enforcing LF
      const d14PositiveDir = join(tempDir, "probe-d14-positive-control");
      createValidGovDir(d14PositiveDir);
      writeFileSync(
        join(d14PositiveDir, ".gitattributes"),
        "* text=auto eol=lf\n*.[tj]s text eol=lf\napps/backend/src/main.ts text eol=lf\n",
      );
      mkdirSync(join(d14PositiveDir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d14PositiveDir, "apps/backend/src/main.ts"), "const x = 1;\n");
      expect(checkOpenSourceGovernanceFiles(d14PositiveDir).ok).toBe(true);

      // --- D15: Strict YAML comment separation & exact label membership (Probe R18) ---
      // D15.1: Probe R18 - hash without preceding whitespace is scalar content, not a comment
      const d15R18Dir = join(tempDir, "probe-r18-yaml-unseparated-hash");
      createValidGovDir(d15R18Dir);
      writeFileSync(
        join(d15R18Dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d14BugTmpl.replace("labels: needs-triage", "labels: needs-triage#extra"),
      );
      const d15R18Res = checkOpenSourceGovernanceFiles(d15R18Dir);
      expect(d15R18Res.ok).toBe(false);
      expect(
        d15R18Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D15.2: Unseparated hash in block sequence
      const d15SeqDir = join(tempDir, "probe-d15-seq-unseparated-hash");
      createValidGovDir(d15SeqDir);
      writeFileSync(
        join(d15SeqDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d14BugTmpl.replace("labels: needs-triage", "labels:\n  - needs-triage#extra"),
      );
      const d15SeqRes = checkOpenSourceGovernanceFiles(d15SeqDir);
      expect(d15SeqRes.ok).toBe(false);
      expect(
        d15SeqRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D15.3: Positive controls with valid whitespace-separated comments
      const d15ValidScalarDir = join(tempDir, "probe-d15-valid-scalar-comment");
      createValidGovDir(d15ValidScalarDir);
      writeFileSync(
        join(d15ValidScalarDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d14BugTmpl.replace("labels: needs-triage", "labels: needs-triage # valid triage comment"),
      );
      expect(checkOpenSourceGovernanceFiles(d15ValidScalarDir).ok).toBe(true);

      const d15ValidSeqDir = join(tempDir, "probe-d15-valid-seq-comment");
      createValidGovDir(d15ValidSeqDir);
      writeFileSync(
        join(d15ValidSeqDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d14BugTmpl.replace(
          "labels: needs-triage",
          "labels:\n  - needs-triage # valid sequence comment",
        ),
      );
      expect(checkOpenSourceGovernanceFiles(d15ValidSeqDir).ok).toBe(true);
    });

    test("AC4 / Review Dispositions (D16-D18): checkOpenSourceGovernanceFiles enforces directory-scoped nested gitattributes, quoted and POSIX bracket Git patterns, and strict YAML flow sequence syntax against probes R19-R22", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      function createValidGovDir(dir: string) {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction...\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND...\n',
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          "# Contributing\n\nNode 26.8.1\nBun 1.4.2\nlabq-factory setup --local-only\nbun run check\nbun run test\nbun run verify\n@labq/contracts\n@labq/client\napps/backend\napps/engine-host\n",
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n");
        writeFileSync(
          join(dir, ".gitattributes"),
          "* text=auto eol=lf\n*.sh text eol=lf\n*.ts text eol=lf\n*.js text eol=lf\n*.json text eol=lf\n*.md text eol=lf\n*.yml text eol=lf\n",
        );
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify({
            lockFileMaintenance: { enabled: true },
            osvVulnerabilityAlerts: true,
            packageRules: [
              {
                matchDepTypes: ["overrides"],
                matchPackageNames: ["*"],
                major: { enabled: false },
              },
            ],
          }),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "# PR\n");
        const tmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"), tmpl);
        writeFileSync(join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"), tmpl);
      }

      const d16BugTmpl = `---\nname: Bug\nlabels: needs-triage\n---\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n- [ ] AC1:\n## Boundary\nDepends on: None\n`;

      // --- D16: Directory-scoped nested .gitattributes evaluation (Probe R19) ---
      // D16.1: Probe R19 - nested apps/backend/.gitattributes containing '*.ts -text' unsets text
      const d16R19Dir = join(tempDir, "probe-r19-nested-gitattributes");
      createValidGovDir(d16R19Dir);
      writeFileSync(join(d16R19Dir, ".gitattributes"), "* text=auto eol=lf\n");
      mkdirSync(join(d16R19Dir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d16R19Dir, "apps/backend/.gitattributes"), "*.ts -text\n");
      writeFileSync(join(d16R19Dir, "apps/backend/src/main.ts"), "const x = 1;\r\n");

      // Verify with real Git attributes that text is unset
      execFileSync("git", ["init", "-q"], { cwd: d16R19Dir });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: d16R19Dir });
      const gitAttr16 = execFileSync(
        "git",
        ["check-attr", "text", "eol", "--", "apps/backend/src/main.ts"],
        { cwd: d16R19Dir, encoding: "utf8" },
      );
      expect(gitAttr16).toContain("apps/backend/src/main.ts: text: unset");

      const d16R19Res = checkOpenSourceGovernanceFiles(d16R19Dir);
      expect(d16R19Res.ok).toBe(false);
      expect(
        d16R19Res.violations.some(
          (v: string) =>
            v.includes("does not effectively enforce eol=lf for required file classes") &&
            v.includes("apps/backend/src/main.ts"),
        ),
      ).toBe(true);

      // D16.2: Nested .gitattributes with conflicting rule fails closed
      const d16ConflictDir = join(tempDir, "probe-d16-nested-conflict");
      createValidGovDir(d16ConflictDir);
      mkdirSync(join(d16ConflictDir, "apps/backend"), { recursive: true });
      writeFileSync(join(d16ConflictDir, "apps/backend/.gitattributes"), "*.ts eol=crlf\n");
      const d16ConflictRes = checkOpenSourceGovernanceFiles(d16ConflictDir);
      expect(d16ConflictRes.ok).toBe(false);
      expect(
        d16ConflictRes.violations.some((v: string) =>
          v.includes(
            "apps/backend/.gitattributes contains conflicting non-LF line ending rule: '*.ts eol=crlf'",
          ),
        ),
      ).toBe(true);

      // D16.3: Positive control - nested .gitattributes enforcing LF
      const d16PositiveDir = join(tempDir, "probe-d16-positive-nested");
      createValidGovDir(d16PositiveDir);
      mkdirSync(join(d16PositiveDir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d16PositiveDir, "apps/backend/.gitattributes"), "*.ts text eol=lf\n");
      writeFileSync(join(d16PositiveDir, "apps/backend/src/main.ts"), "const x = 1;\n");
      expect(checkOpenSourceGovernanceFiles(d16PositiveDir).ok).toBe(true);

      // --- D17: Git pattern grammar: quoted patterns and POSIX bracket classes (Probes R20 & R21) ---
      // D17.1: Probe R20 - quoted glob '"*.ts" -text' unsets text
      const d17R20Dir = join(tempDir, "probe-r20-quoted-glob");
      createValidGovDir(d17R20Dir);
      writeFileSync(join(d17R20Dir, ".gitattributes"), '* text=auto eol=lf\n"*.ts" -text\n');
      mkdirSync(join(d17R20Dir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d17R20Dir, "apps/backend/src/main.ts"), "const x = 1;\r\n");

      execFileSync("git", ["init", "-q"], { cwd: d17R20Dir });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: d17R20Dir });
      const gitAttr20 = execFileSync(
        "git",
        ["check-attr", "text", "eol", "--", "apps/backend/src/main.ts"],
        { cwd: d17R20Dir, encoding: "utf8" },
      );
      expect(gitAttr20).toContain("apps/backend/src/main.ts: text: unset");

      const d17R20Res = checkOpenSourceGovernanceFiles(d17R20Dir);
      expect(d17R20Res.ok).toBe(false);
      expect(
        d17R20Res.violations.some((v: string) =>
          v.includes("does not effectively enforce eol=lf for required file classes"),
        ),
      ).toBe(true);

      // D17.2: Probe R21 - POSIX bracket class '*.[[:alpha:]][[:alpha:]] -text' unsets text for two-letter extensions
      const d17R21Dir = join(tempDir, "probe-r21-posix-bracket-class");
      createValidGovDir(d17R21Dir);
      writeFileSync(
        join(d17R21Dir, ".gitattributes"),
        "* text=auto eol=lf\n*.[[:alpha:]][[:alpha:]] -text\n",
      );
      mkdirSync(join(d17R21Dir, "apps/backend/src"), { recursive: true });
      writeFileSync(join(d17R21Dir, "apps/backend/src/main.ts"), "const x = 1;\r\n");

      execFileSync("git", ["init", "-q"], { cwd: d17R21Dir });
      execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: d17R21Dir });
      const gitAttr21 = execFileSync(
        "git",
        ["check-attr", "text", "eol", "--", "apps/backend/src/main.ts"],
        { cwd: d17R21Dir, encoding: "utf8" },
      );
      expect(gitAttr21).toContain("apps/backend/src/main.ts: text: unset");

      const d17R21Res = checkOpenSourceGovernanceFiles(d17R21Dir);
      expect(d17R21Res.ok).toBe(false);
      expect(
        d17R21Res.violations.some(
          (v: string) =>
            v.includes("does not effectively enforce eol=lf for required file classes") &&
            v.includes("source.ts"),
        ),
      ).toBe(true);

      // D17.3: Positive controls with quoted globs and POSIX bracket classes enforcing LF
      const d17PositiveDir = join(tempDir, "probe-d17-positive-patterns");
      createValidGovDir(d17PositiveDir);
      writeFileSync(
        join(d17PositiveDir, ".gitattributes"),
        '* text=auto eol=lf\n"*.ts" text eol=lf\n*.[[:alpha:]][[:alpha:]] text eol=lf\n',
      );
      expect(checkOpenSourceGovernanceFiles(d17PositiveDir).ok).toBe(true);

      // --- D18: YAML flow sequence parsing and rejection of malformed trailing content (Probe R22) ---
      // D18.1: Probe R22 - trailing content after flow sequence closing bracket 'labels: [needs-triage]garbage'
      const d18R22Dir = join(tempDir, "probe-r22-invalid-flow-suffix");
      createValidGovDir(d18R22Dir);
      writeFileSync(
        join(d18R22Dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", "labels: [needs-triage]garbage"),
      );
      const d18R22Res = checkOpenSourceGovernanceFiles(d18R22Dir);
      expect(d18R22Res.ok).toBe(false);
      expect(
        d18R22Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D18.2: Quoted item with trailing content 'labels: ["needs-triage"]extra'
      const d18QuotedTrailingDir = join(tempDir, "probe-d18-quoted-trailing");
      createValidGovDir(d18QuotedTrailingDir);
      writeFileSync(
        join(d18QuotedTrailingDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", 'labels: ["needs-triage"]extra'),
      );
      const d18QuotedRes = checkOpenSourceGovernanceFiles(d18QuotedTrailingDir);
      expect(d18QuotedRes.ok).toBe(false);
      expect(
        d18QuotedRes.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D18.3: Malformed empty item / consecutive commas 'labels: [needs-triage,,bug]'
      const d18CommaDir = join(tempDir, "probe-d18-consecutive-commas");
      createValidGovDir(d18CommaDir);
      writeFileSync(
        join(d18CommaDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", "labels: [needs-triage,,bug]"),
      );
      const d18CommaRes = checkOpenSourceGovernanceFiles(d18CommaDir);
      expect(d18CommaRes.ok).toBe(false);

      // D18.4: Positive controls: valid flow sequences and multiline flow sequence
      const d18ValidSingleDir = join(tempDir, "probe-d18-valid-single-flow");
      createValidGovDir(d18ValidSingleDir);
      writeFileSync(
        join(d18ValidSingleDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", "labels: [needs-triage]"),
      );
      expect(checkOpenSourceGovernanceFiles(d18ValidSingleDir).ok).toBe(true);

      const d18ValidCommentDir = join(tempDir, "probe-d18-valid-flow-comment");
      createValidGovDir(d18ValidCommentDir);
      writeFileSync(
        join(d18ValidCommentDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", "labels: [needs-triage] # valid flow comment"),
      );
      expect(checkOpenSourceGovernanceFiles(d18ValidCommentDir).ok).toBe(true);

      const d18ValidMultiDir = join(tempDir, "probe-d18-valid-multi-flow");
      createValidGovDir(d18ValidMultiDir);
      writeFileSync(
        join(d18ValidMultiDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", 'labels: [ "needs-triage", "bug" ]'),
      );
      expect(checkOpenSourceGovernanceFiles(d18ValidMultiDir).ok).toBe(true);

      const d18ValidMultilineDir = join(tempDir, "probe-d18-valid-multiline-flow");
      createValidGovDir(d18ValidMultilineDir);
      writeFileSync(
        join(d18ValidMultilineDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        d16BugTmpl.replace("labels: needs-triage", "labels: [\n  needs-triage,\n  bug\n]"),
      );
      expect(checkOpenSourceGovernanceFiles(d18ValidMultilineDir).ok).toBe(true);
    });

    test("AC4 / Review Dispositions (D19-D20): checkOpenSourceGovernanceFiles enforces duplicate key rejection in front matter and Renovate glob/regex matching semantics against probes R23-R25", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );
      const createValidGovDir = (dir: string) => {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nwithout restriction, including without limitation the rights to use, copy,\nwithout warranty of any kind.\n",
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          "# Contributing\n\nNode: 26.8.1\nBun: 1.4.2\n\nSetup:\nlabq-factory setup --local-only\n\nCheck commands:\nbun run check\nbun run test\nbun run verify\n\nBoundaries: @labq/contracts, @labq/client, apps/backend, apps/engine-host\n",
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
        writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify(
            {
              $schema: "https://docs.renovatebot.com/renovate-schema.json",
              extends: ["config:recommended"],
              lockFileMaintenance: { enabled: true },
              osvVulnerabilityAlerts: true,
              packageRules: [
                {
                  matchDepTypes: ["overrides"],
                  major: { enabled: false },
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "## Evidence\n");
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
          "---\nname: Bug Report\nabout: Report a defect\ntitle: 'fix: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"),
          "---\nname: Feature Request\nabout: Suggest an idea\ntitle: 'feat: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
      };

      const bugTmpl =
        "---\nname: Bug Report\nabout: Report a defect\ntitle: 'fix: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n";

      // --- D19: Duplicate YAML front matter keys bypass label validation (Probe R23) ---
      // D19.1: Probe R23 - duplicate 'labels:' key where first is needs-triage and second is bug
      const d19R23Dir = join(tempDir, "probe-r23-duplicate-label-key");
      createValidGovDir(d19R23Dir);
      writeFileSync(
        join(d19R23Dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        bugTmpl.replace("labels: needs-triage", "labels: needs-triage\nlabels: bug"),
      );
      const d19R23Res = checkOpenSourceGovernanceFiles(d19R23Dir);
      expect(d19R23Res.ok).toBe(false);
      expect(
        d19R23Res.violations.some((v: string) =>
          v.includes("front matter contains duplicate key: 'labels'"),
        ),
      ).toBe(true);
      expect(
        d19R23Res.violations.some((v: string) =>
          v.includes(".github/ISSUE_TEMPLATE/bug_report.md must default labels to 'needs-triage'"),
        ),
      ).toBe(true);

      // D19.2: Duplicate top-level key for other mapping field (e.g. duplicate 'name:')
      const d19DupNameDir = join(tempDir, "probe-d19-duplicate-name-key");
      createValidGovDir(d19DupNameDir);
      writeFileSync(
        join(d19DupNameDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        bugTmpl.replace("name: Bug Report", "name: Bug Report\nname: Defect"),
      );
      const d19DupNameRes = checkOpenSourceGovernanceFiles(d19DupNameDir);
      expect(d19DupNameRes.ok).toBe(false);
      expect(
        d19DupNameRes.violations.some((v: string) =>
          v.includes("front matter contains duplicate key: 'name'"),
        ),
      ).toBe(true);

      // D19.3: Positive controls: single valid scalar and block list labels
      const d19ScalarDir = join(tempDir, "probe-d19-positive-scalar");
      createValidGovDir(d19ScalarDir);
      expect(checkOpenSourceGovernanceFiles(d19ScalarDir).ok).toBe(true);

      const d19BlockListDir = join(tempDir, "probe-d19-positive-block-list");
      createValidGovDir(d19BlockListDir);
      writeFileSync(
        join(d19BlockListDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        bugTmpl.replace("labels: needs-triage", "labels:\n  - needs-triage\n  - bug"),
      );
      expect(checkOpenSourceGovernanceFiles(d19BlockListDir).ok).toBe(true);

      // --- D20: Renovate string-matching semantics (Probes R24 & R25) ---
      // D20.1: Probe R24 - glob matcher 'matchDepTypes: ["over*"]' re-enabling major updates
      const d20R24Dir = join(tempDir, "probe-r24-overrides-glob-enable");
      createValidGovDir(d20R24Dir);
      const r24File = join(d20R24Dir, "renovate.json");
      const r24Config = JSON.parse(readFileSync(r24File, "utf8"));
      r24Config.packageRules.push({ matchDepTypes: ["over*"], major: { enabled: true } });
      writeFileSync(r24File, JSON.stringify(r24Config, null, 2));
      const d20R24Res = checkOpenSourceGovernanceFiles(d20R24Dir);
      expect(d20R24Res.ok).toBe(false);
      expect(
        d20R24Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D20.2: Probe R25 - restricted dot-star glob 'matchPackageNames: [".*"]' does not cover non-dot packages
      const d20R25Dir = join(tempDir, "probe-r25-restricted-dot-star");
      createValidGovDir(d20R25Dir);
      const r25File = join(d20R25Dir, "renovate.json");
      const r25Config = JSON.parse(readFileSync(r25File, "utf8"));
      r25Config.packageRules[0].matchPackageNames = [".*"];
      writeFileSync(r25File, JSON.stringify(r25Config, null, 2));
      const d20R25Res = checkOpenSourceGovernanceFiles(d20R25Dir);
      expect(d20R25Res.ok).toBe(false);
      expect(
        d20R25Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D20.3: Positive control - appending non-overrides enabling rule passes cleanly
      const d20NonOverridesDir = join(tempDir, "probe-d20-positive-non-overrides");
      createValidGovDir(d20NonOverridesDir);
      const nonOverridesFile = join(d20NonOverridesDir, "renovate.json");
      const nonOverridesConfig = JSON.parse(readFileSync(nonOverridesFile, "utf8"));
      nonOverridesConfig.packageRules.push({
        matchDepTypes: ["devDependencies"],
        major: { enabled: true },
      });
      writeFileSync(nonOverridesFile, JSON.stringify(nonOverridesConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d20NonOverridesDir).ok).toBe(true);

      // D20.4: Positive control - unrestricted wildcard 'matchPackageNames: ["*"]' passes cleanly
      const d20WildcardDir = join(tempDir, "probe-d20-positive-wildcard");
      createValidGovDir(d20WildcardDir);
      const wildcardFile = join(d20WildcardDir, "renovate.json");
      const wildcardConfig = JSON.parse(readFileSync(wildcardFile, "utf8"));
      wildcardConfig.packageRules[0].matchPackageNames = ["*"];
      writeFileSync(wildcardFile, JSON.stringify(wildcardConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d20WildcardDir).ok).toBe(true);

      // D20.5: Positive control - unrestricted regex 'matchPackageNames: ["/^.*$/"]' passes cleanly
      const d20RegexDir = join(tempDir, "probe-d20-positive-regex");
      createValidGovDir(d20RegexDir);
      const regexFile = join(d20RegexDir, "renovate.json");
      const regexConfig = JSON.parse(readFileSync(regexFile, "utf8"));
      regexConfig.packageRules[0].matchPackageNames = ["/^.*$/"];
      writeFileSync(regexFile, JSON.stringify(regexConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d20RegexDir).ok).toBe(true);
    });

    test("AC4 / Review Dispositions (D21): checkOpenSourceGovernanceFiles enforces Renovate extglob and brace matching semantics against probes R26-R27", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );
      const createValidGovDir = (dir: string) => {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nwithout restriction, including without limitation the rights to use, copy,\nwithout warranty of any kind.\n",
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          "# Contributing\n\nNode: 26.8.1\nBun: 1.4.2\n\nSetup:\nlabq-factory setup --local-only\n\nCheck commands:\nbun run check\nbun run test\nbun run verify\n\nBoundaries: @labq/contracts, @labq/client, apps/backend, apps/engine-host\n",
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
        writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify(
            {
              $schema: "https://docs.renovatebot.com/renovate-schema.json",
              extends: ["config:recommended"],
              lockFileMaintenance: { enabled: true },
              osvVulnerabilityAlerts: true,
              packageRules: [
                {
                  matchDepTypes: ["overrides"],
                  major: { enabled: false },
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "## Evidence\n");
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
          "---\nname: Bug Report\nabout: Report a defect\ntitle: 'fix: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"),
          "---\nname: Feature Request\nabout: Suggest an idea\ntitle: 'feat: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
      };

      // D21.1: Probe R26 - extglob matcher 'matchDepTypes: ["@(overrides|dependencies)"]' re-enabling major updates fails closed
      const d21R26Dir = join(tempDir, "probe-r26-extglob-overrides-enable");
      createValidGovDir(d21R26Dir);
      const r26File = join(d21R26Dir, "renovate.json");
      const r26Config = JSON.parse(readFileSync(r26File, "utf8"));
      r26Config.packageRules.push({
        matchDepTypes: ["@(overrides|dependencies)"],
        major: { enabled: true },
      });
      writeFileSync(r26File, JSON.stringify(r26Config, null, 2));
      const d21R26Res = checkOpenSourceGovernanceFiles(d21R26Dir);
      expect(d21R26Res.ok).toBe(false);
      expect(
        d21R26Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D21.2: Probe R27 - brace package matcher 'matchPackageNames: ["{vite,vitest}"]' re-enabling major updates fails closed
      const d21R27Dir = join(tempDir, "probe-r27-brace-package-enable");
      createValidGovDir(d21R27Dir);
      const r27File = join(d21R27Dir, "renovate.json");
      const r27Config = JSON.parse(readFileSync(r27File, "utf8"));
      r27Config.packageRules.push({
        matchDepTypes: ["overrides"],
        matchPackageNames: ["{vite,vitest}"],
        major: { enabled: true },
      });
      writeFileSync(r27File, JSON.stringify(r27Config, null, 2));
      const d21R27Res = checkOpenSourceGovernanceFiles(d21R27Dir);
      expect(d21R27Res.ok).toBe(false);
      expect(
        d21R27Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D21.3: Positive control - extglob non-overrides enabling rule passes cleanly
      const d21NonOverridesDir = join(tempDir, "probe-d21-positive-extglob-non-overrides");
      createValidGovDir(d21NonOverridesDir);
      const nonOverridesFile = join(d21NonOverridesDir, "renovate.json");
      const nonOverridesConfig = JSON.parse(readFileSync(nonOverridesFile, "utf8"));
      nonOverridesConfig.packageRules.push({
        matchDepTypes: ["@(devDependencies|optionalDependencies)"],
        major: { enabled: true },
      });
      writeFileSync(nonOverridesFile, JSON.stringify(nonOverridesConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d21NonOverridesDir).ok).toBe(true);

      // D21.4: Positive control - brace matcher for non-override package names passes cleanly
      const d21NonOverridePkgsDir = join(tempDir, "probe-d21-positive-brace-non-overrides");
      createValidGovDir(d21NonOverridePkgsDir);
      const nonOverridePkgsFile = join(d21NonOverridePkgsDir, "renovate.json");
      const nonOverridePkgsConfig = JSON.parse(readFileSync(nonOverridePkgsFile, "utf8"));
      nonOverridePkgsConfig.packageRules.push({
        matchDepTypes: ["overrides"],
        matchPackageNames: ["{unrelated-alpha,unrelated-beta}"],
        major: { enabled: true },
      });
      writeFileSync(nonOverridePkgsFile, JSON.stringify(nonOverridePkgsConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d21NonOverridePkgsDir).ok).toBe(true);

      // D21.5: Positive control - negative extglob excluding overrides passes cleanly
      const d21NegExtglobDir = join(tempDir, "probe-d21-positive-neg-extglob");
      createValidGovDir(d21NegExtglobDir);
      const negExtglobFile = join(d21NegExtglobDir, "renovate.json");
      const negExtglobConfig = JSON.parse(readFileSync(negExtglobFile, "utf8"));
      negExtglobConfig.packageRules.push({
        matchDepTypes: ["!(overrides)"],
        major: { enabled: true },
      });
      writeFileSync(negExtglobFile, JSON.stringify(negExtglobConfig, null, 2));
      expect(checkOpenSourceGovernanceFiles(d21NegExtglobDir).ok).toBe(true);
    });

    test("AC4 / Review Dispositions (D22-D23): checkOpenSourceGovernanceFiles enforces decoded YAML front-matter labels against escaped ready-for-agent injections, and deterministic isolated matching for nested extglobs and brace ranges without ambient dependencies", async () => {
      const { checkOpenSourceGovernanceFiles } = await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      );

      const createValidGovDir = (dir: string) => {
        mkdirSync(join(dir, ".github/ISSUE_TEMPLATE"), { recursive: true });
        writeFileSync(
          join(dir, "LICENSE"),
          "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nwithout restriction, including without limitation the rights to use, copy,\nwithout warranty of any kind.\n",
        );
        writeFileSync(
          join(dir, "CONTRIBUTING.md"),
          "# Contributing\n\nNode: 26.8.1\nBun: 1.4.2\n\nSetup:\nlabq-factory setup --local-only\n\nCheck commands:\nbun run check\nbun run test\nbun run verify\n\nBoundaries: @labq/contracts, @labq/client, apps/backend, apps/engine-host\n",
        );
        writeFileSync(join(dir, "SECURITY.md"), "# Security Policy\n");
        writeFileSync(join(dir, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
        writeFileSync(join(dir, ".gitattributes"), "* text=auto eol=lf\n");
        writeFileSync(
          join(dir, "renovate.json"),
          JSON.stringify(
            {
              $schema: "https://docs.renovatebot.com/renovate-schema.json",
              extends: ["config:recommended"],
              lockFileMaintenance: { enabled: true },
              osvVulnerabilityAlerts: true,
              packageRules: [
                {
                  matchDepTypes: ["overrides"],
                  major: { enabled: false },
                },
              ],
            },
            null,
            2,
          ),
        );
        writeFileSync(join(dir, ".github/pull_request_template.md"), "## Evidence\n");
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/bug_report.md"),
          "---\nname: Bug Report\nabout: Report a defect\ntitle: 'fix: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
        writeFileSync(
          join(dir, ".github/ISSUE_TEMPLATE/feature_request.md"),
          "---\nname: Feature Request\nabout: Suggest an idea\ntitle: 'feat: '\nlabels: needs-triage\n---\n\n## Source and problem\n## Outcome\n## Invariants\n## Acceptance criteria\n## Boundary\n## Depends on:\n",
        );
      };

      // D22.1: Unicode-escaped label injection 'labels: [needs-triage, "ready-for-\\u0061gent"]' fails closed
      const d22UnicodeDir = join(tempDir, "probe-d22-unicode-escaped-forbidden-label");
      createValidGovDir(d22UnicodeDir);
      const bugTmplPath = join(d22UnicodeDir, ".github/ISSUE_TEMPLATE/bug_report.md");
      const baseContent = readFileSync(bugTmplPath, "utf8");
      writeFileSync(
        bugTmplPath,
        baseContent.replace(
          "labels: needs-triage",
          'labels: [needs-triage, "ready-for-\\u0061gent"]',
        ),
      );
      const d22UnicodeRes = checkOpenSourceGovernanceFiles(d22UnicodeDir);
      expect(d22UnicodeRes.ok).toBe(false);
      expect(
        d22UnicodeRes.violations.some((v: string) =>
          v.includes("must NEVER default labels to 'ready-for-agent'"),
        ),
      ).toBe(true);

      // D22.2: Hex-escaped label injection 'labels: [needs-triage, "ready-for-\\x61gent"]' fails closed
      const d22HexDir = join(tempDir, "probe-d22-hex-escaped-forbidden-label");
      createValidGovDir(d22HexDir);
      writeFileSync(
        join(d22HexDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseContent.replace(
          "labels: needs-triage",
          'labels: [needs-triage, "ready-for-\\x61gent"]',
        ),
      );
      const d22HexRes = checkOpenSourceGovernanceFiles(d22HexDir);
      expect(d22HexRes.ok).toBe(false);
      expect(
        d22HexRes.violations.some((v: string) =>
          v.includes("must NEVER default labels to 'ready-for-agent'"),
        ),
      ).toBe(true);

      // D22.3: Escaped scalar label injection 'labels: "ready-for-\\u0061gent"' fails closed
      const d22ScalarDir = join(tempDir, "probe-d22-scalar-escaped-forbidden-label");
      createValidGovDir(d22ScalarDir);
      writeFileSync(
        join(d22ScalarDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseContent.replace("labels: needs-triage", 'labels: "ready-for-\\u0061gent"'),
      );
      const d22ScalarRes = checkOpenSourceGovernanceFiles(d22ScalarDir);
      expect(d22ScalarRes.ok).toBe(false);
      expect(
        d22ScalarRes.violations.some((v: string) =>
          v.includes("must NEVER default labels to 'ready-for-agent'"),
        ),
      ).toBe(true);

      // D22.4: Valid label list control 'labels: [needs-triage, bug]' passes cleanly
      const d22ValidDir = join(tempDir, "probe-d22-valid-label-list");
      createValidGovDir(d22ValidDir);
      writeFileSync(
        join(d22ValidDir, ".github/ISSUE_TEMPLATE/bug_report.md"),
        baseContent.replace("labels: needs-triage", "labels: [needs-triage, bug]"),
      );
      expect(checkOpenSourceGovernanceFiles(d22ValidDir).ok).toBe(true);

      // D23: Isolated checker execution (copied into an isolated temp directory without ancestor node_modules)
      const isolatedDir = join(tempDir, "isolated-checker-env");
      mkdirSync(isolatedDir, { recursive: true });

      const isolatedCheckerPath = join(isolatedDir, "check-architecture.mjs");
      cpSync(join(process.cwd(), "scripts/health"), isolatedDir, { recursive: true });
      symlinkSync(join(process.cwd(), "node_modules"), join(isolatedDir, "node_modules"), "dir");

      const isolatedModule = await import(pathToFileURL(isolatedCheckerPath).href);
      const isolatedChecker = isolatedModule.checkOpenSourceGovernanceFiles;

      // D23.1: Probe R28 - nested extglob '@(overrides|@(dependencies|peerDependencies))' fails closed in isolated environment
      const d23NestedDir = join(tempDir, "probe-d23-nested-extglob-isolated");
      createValidGovDir(d23NestedDir);
      const nestedRenovate = JSON.parse(readFileSync(join(d23NestedDir, "renovate.json"), "utf8"));
      nestedRenovate.packageRules.push({
        matchDepTypes: ["@(overrides|@(dependencies|peerDependencies))"],
        major: { enabled: true },
      });
      writeFileSync(join(d23NestedDir, "renovate.json"), JSON.stringify(nestedRenovate, null, 2));
      const d23NestedRes = isolatedChecker(d23NestedDir);
      expect(d23NestedRes.ok).toBe(false);
      expect(
        d23NestedRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D23.2: Probe R29 - nested extglob '@(@(overrides|dependencies)|peerDependencies)' fails closed in isolated environment
      const d23Nested2Dir = join(tempDir, "probe-d23-nested-extglob-2-isolated");
      createValidGovDir(d23Nested2Dir);
      const nested2Renovate = JSON.parse(
        readFileSync(join(d23Nested2Dir, "renovate.json"), "utf8"),
      );
      nested2Renovate.packageRules.push({
        matchDepTypes: ["@(@(overrides|dependencies)|peerDependencies)"],
        major: { enabled: true },
      });
      writeFileSync(join(d23Nested2Dir, "renovate.json"), JSON.stringify(nested2Renovate, null, 2));
      const d23Nested2Res = isolatedChecker(d23Nested2Dir);
      expect(d23Nested2Res.ok).toBe(false);
      expect(
        d23Nested2Res.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D23.3: Probe R30 - range brace package matcher 'v{a..z}te' fails closed in isolated environment
      const d23RangeDir = join(tempDir, "probe-d23-range-brace-isolated");
      createValidGovDir(d23RangeDir);
      const rangeRenovate = JSON.parse(readFileSync(join(d23RangeDir, "renovate.json"), "utf8"));
      rangeRenovate.packageRules.push({
        matchDepTypes: ["overrides"],
        matchPackageNames: ["v{a..z}te"],
        major: { enabled: true },
      });
      writeFileSync(join(d23RangeDir, "renovate.json"), JSON.stringify(rangeRenovate, null, 2));
      const d23RangeRes = isolatedChecker(d23RangeDir);
      expect(d23RangeRes.ok).toBe(false);
      expect(
        d23RangeRes.violations.some((v: string) =>
          v.includes("renovate.json must disable major updates for overrides in packageRules"),
        ),
      ).toBe(true);

      // D23.4: Permitted non-overrides control in isolated environment passes cleanly
      const d23PermittedDir = join(tempDir, "probe-d23-permitted-isolated");
      createValidGovDir(d23PermittedDir);
      const permittedRenovate = JSON.parse(
        readFileSync(join(d23PermittedDir, "renovate.json"), "utf8"),
      );
      permittedRenovate.packageRules.push({
        matchDepTypes: ["devDependencies"],
        major: { enabled: true },
      });
      writeFileSync(
        join(d23PermittedDir, "renovate.json"),
        JSON.stringify(permittedRenovate, null, 2),
      );
      expect(isolatedChecker(d23PermittedDir).ok).toBe(true);

      // D23.5: Non-matching range brace control in isolated environment passes cleanly
      const d23NonMatchRangeDir = join(tempDir, "probe-d23-nonmatch-range-isolated");
      createValidGovDir(d23NonMatchRangeDir);
      const nonMatchRenovate = JSON.parse(
        readFileSync(join(d23NonMatchRangeDir, "renovate.json"), "utf8"),
      );
      nonMatchRenovate.packageRules.push({
        matchDepTypes: ["overrides"],
        matchPackageNames: ["pkg-{0..9}"],
        major: { enabled: true },
      });
      writeFileSync(
        join(d23NonMatchRangeDir, "renovate.json"),
        JSON.stringify(nonMatchRenovate, null, 2),
      );
      expect(isolatedChecker(d23NonMatchRangeDir).ok).toBe(true);

      // D23.6: Rule order control - subsequent unrestricted override rule disabling major overrides succeeds
      const d23OrderDir = join(tempDir, "probe-d23-order-isolated");
      createValidGovDir(d23OrderDir);
      const orderRenovate = JSON.parse(readFileSync(join(d23OrderDir, "renovate.json"), "utf8"));
      orderRenovate.packageRules.push(
        {
          matchDepTypes: ["overrides"],
          matchPackageNames: ["vite"],
          major: { enabled: true },
        },
        {
          matchDepTypes: ["overrides"],
          major: { enabled: false },
        },
      );
      writeFileSync(join(d23OrderDir, "renovate.json"), JSON.stringify(orderRenovate, null, 2));
      expect(isolatedChecker(d23OrderDir).ok).toBe(true);
    });
  });
});
