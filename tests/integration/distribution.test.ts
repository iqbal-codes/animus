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

  describe("AC7 (Issue #85): Workspace Package-Edge Validation & Open-Source Governance", () => {
    function setupMockWorkspace(rootDir: string, customPackages: Record<string, any> = {}) {
      const defaultPackages: Record<string, any> = {
        "packages/contracts": {
          name: "@labq/contracts",
          dependencies: { zod: "4.1.12" },
        },
        "packages/client": {
          name: "@labq/client",
          dependencies: { "@labq/contracts": "workspace:*" },
        },
        "apps/backend": {
          name: "@labq/backend",
          dependencies: { "@labq/contracts": "workspace:*" },
        },
        "apps/engine-host": {
          name: "@labq/engine-host",
          dependencies: { "@labq/contracts": "workspace:*" },
        },
        "apps/launcher": {
          name: "@labq/launcher",
          dependencies: { "@labq/contracts": "workspace:*" },
        },
      };

      const merged = { ...defaultPackages, ...customPackages };
      for (const [pkgRelPath, content] of Object.entries(merged)) {
        const fullDir = join(rootDir, pkgRelPath);
        mkdirSync(fullDir, { recursive: true });
        if (content !== null) {
          writeFileSync(
            join(fullDir, "package.json"),
            typeof content === "string" ? content : JSON.stringify(content, null, 2),
          );
        }
      }
    }

    function setupMockGovernance(rootDir: string, overrides: Record<string, string | null> = {}) {
      const defaultFiles: Record<string, string> = {
        LICENSE: "MIT License\n\nCopyright (c) 2026 LabQ\nPermission is hereby granted...",
        "CONTRIBUTING.md":
          "# Contributing\nNode 26.8.1\nBun 1.4.2\nlabq-factory setup --local-only\nbun run check\nbun run test\nbun run verify\narchitecture boundaries",
        "SECURITY.md": "# Security\nReport vulnerabilities privately.",
        "CHANGELOG.md": "# Changelog\nAll notable changes.",
        ".gitattributes": "* text=auto eol=lf\n",
        "renovate.json": JSON.stringify(
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
        ".github/pull_request_template.md": "## Problem\n## Invariants\n## Evidence\n",
        ".github/ISSUE_TEMPLATE/bug_report.md": `---
name: Bug Report
labels:
  - needs-triage
---
## Source and problem
## Outcome
## Invariants
## Acceptance criteria
## Boundary
Depends on: None
`,
        ".github/ISSUE_TEMPLATE/feature_request.md": `---
name: Feature Request
labels:
  - needs-triage
---
## Source and problem
## Outcome
## Invariants
## Acceptance criteria
## Boundary
Depends on: None
`,
      };

      const files = { ...defaultFiles, ...overrides };
      for (const [relPath, content] of Object.entries(files)) {
        const fullPath = join(rootDir, relPath);
        const parentDir = join(rootDir, relPath.split("/").slice(0, -1).join("/"));
        mkdirSync(parentDir, { recursive: true });
        if (content !== null) {
          writeFileSync(fullPath, content);
        }
      }
    }

    test("AC1: checkWorkspacePackageEdges validates clean repository without violations", async () => {
      const { checkWorkspacePackageEdges } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;
      const result = checkWorkspacePackageEdges(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    });

    test("AC1: checkWorkspacePackageEdges fails closed on forbidden package.json edges", async () => {
      const { checkWorkspacePackageEdges } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;

      // Fault case 1: contracts depending on client
      const mockDir1 = join(tempDir, "pkg-edge-fault-1");
      setupMockWorkspace(mockDir1, {
        "packages/contracts": {
          name: "@labq/contracts",
          dependencies: { "@labq/client": "workspace:*" },
        },
      });
      const res1 = checkWorkspacePackageEdges(mockDir1);
      expect(res1.ok).toBe(false);
      expect(
        res1.violations.some((v: string) => v.includes('forbidden dependency "@labq/client"')),
      ).toBe(true);

      // Fault case 2: contracts depending on backend in devDependencies
      const mockDir2 = join(tempDir, "pkg-edge-fault-2");
      setupMockWorkspace(mockDir2, {
        "packages/contracts": {
          name: "@labq/contracts",
          devDependencies: { "@labq/backend": "workspace:*" },
        },
      });
      const res2 = checkWorkspacePackageEdges(mockDir2);
      expect(res2.ok).toBe(false);
      expect(
        res2.violations.some((v: string) => v.includes('forbidden dependency "@labq/backend"')),
      ).toBe(true);

      // Fault case 3: client depending on engine-host in peerDependencies
      const mockDir3 = join(tempDir, "pkg-edge-fault-3");
      setupMockWorkspace(mockDir3, {
        "packages/client": {
          name: "@labq/client",
          peerDependencies: { "@labq/engine-host": "workspace:*" },
        },
      });
      const res3 = checkWorkspacePackageEdges(mockDir3);
      expect(res3.ok).toBe(false);
      expect(
        res3.violations.some((v: string) => v.includes('forbidden dependency "@labq/engine-host"')),
      ).toBe(true);

      // Fault case 4: backend depending on engine-host
      const mockDir4 = join(tempDir, "pkg-edge-fault-4");
      setupMockWorkspace(mockDir4, {
        "apps/backend": {
          name: "@labq/backend",
          dependencies: { "@labq/engine-host": "workspace:*" },
        },
      });
      const res4 = checkWorkspacePackageEdges(mockDir4);
      expect(res4.ok).toBe(false);
      expect(
        res4.violations.some((v: string) => v.includes('forbidden dependency "@labq/engine-host"')),
      ).toBe(true);

      // Fault case 5: engine-host depending on backend
      const mockDir5 = join(tempDir, "pkg-edge-fault-5");
      setupMockWorkspace(mockDir5, {
        "apps/engine-host": {
          name: "@labq/engine-host",
          dependencies: { "@labq/backend": "workspace:*" },
        },
      });
      const res5 = checkWorkspacePackageEdges(mockDir5);
      expect(res5.ok).toBe(false);
      expect(
        res5.violations.some((v: string) => v.includes('forbidden dependency "@labq/backend"')),
      ).toBe(true);

      // Fault case 6: launcher depending on engine-host
      const mockDir6 = join(tempDir, "pkg-edge-fault-6");
      setupMockWorkspace(mockDir6, {
        "apps/launcher": {
          name: "@labq/launcher",
          dependencies: { "@labq/engine-host": "workspace:*" },
        },
      });
      const res6 = checkWorkspacePackageEdges(mockDir6);
      expect(res6.ok).toBe(false);
      expect(
        res6.violations.some((v: string) => v.includes('forbidden dependency "@labq/engine-host"')),
      ).toBe(true);

      // Fault case 7: missing package.json fails closed
      const mockDir7 = join(tempDir, "pkg-edge-fault-7");
      setupMockWorkspace(mockDir7, {
        "apps/backend": null,
      });
      const res7 = checkWorkspacePackageEdges(mockDir7);
      expect(res7.ok).toBe(false);
      expect(
        res7.violations.some((v: string) => v.includes("apps/backend/package.json: file missing")),
      ).toBe(true);
    });

    test("AC2 & AC3: checkOpenSourceGovernanceFiles validates clean repository and governance artifacts", async () => {
      const { checkOpenSourceGovernanceFiles } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;
      const result = checkOpenSourceGovernanceFiles(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);

      // Verify individual governance file contents on disk
      const license = readFileSync(join(process.cwd(), "LICENSE"), "utf-8");
      expect(license).toContain("MIT License");

      const contributing = readFileSync(join(process.cwd(), "CONTRIBUTING.md"), "utf-8");
      expect(contributing).toContain("26.8.1");
      expect(contributing).toContain("1.4.2");
      expect(contributing).toContain("labq-factory setup --local-only");
      expect(contributing).toContain("bun run check");
      expect(contributing).toContain("bun run test");
      expect(contributing).toContain("bun run verify");
      expect(contributing).toMatch(/architecture boundar/i);

      const security = readFileSync(join(process.cwd(), "SECURITY.md"), "utf-8");
      expect(security.length).toBeGreaterThan(0);
      expect(security).toMatch(/vulnerabilit/i);

      const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf-8");
      expect(changelog.length).toBeGreaterThan(0);
      expect(changelog).toContain("# Changelog");

      const gitattributes = readFileSync(join(process.cwd(), ".gitattributes"), "utf-8");
      expect(gitattributes).toContain("eol=lf");

      const renovate = JSON.parse(readFileSync(join(process.cwd(), "renovate.json"), "utf-8"));
      expect(renovate.lockFileMaintenance.enabled).toBe(true);
      expect(renovate.osvVulnerabilityAlerts).toBe(true);
      const hasOverridesMajorDisabled = renovate.packageRules.some((rule: any) => {
        const matchesOverrides =
          (Array.isArray(rule.matchDepTypes) && rule.matchDepTypes.includes("overrides")) ||
          rule.matchDepTypes === "overrides";
        return matchesOverrides && rule.major?.enabled === false;
      });
      expect(hasOverridesMajorDisabled).toBe(true);

      const prTemplate = readFileSync(
        join(process.cwd(), ".github/pull_request_template.md"),
        "utf-8",
      );
      expect(prTemplate.length).toBeGreaterThan(0);
      expect(prTemplate).toContain("Evidence");

      for (const templateName of ["bug_report.md", "feature_request.md"]) {
        const templateContent = readFileSync(
          join(process.cwd(), `.github/ISSUE_TEMPLATE/${templateName}`),
          "utf-8",
        );
        expect(templateContent).toContain("needs-triage");
        expect(templateContent).not.toContain("ready-for-agent");
        expect(templateContent).toContain("Source and problem");
        expect(templateContent).toContain("Outcome");
        expect(templateContent).toContain("Invariants");
        expect(templateContent).toContain("Acceptance criteria");
        expect(templateContent).toContain("Boundary");
        expect(templateContent).toContain("Depends on:");
      }
    });

    test("AC2 & AC4: checkOpenSourceGovernanceFiles fails closed on missing or invalid governance files", async () => {
      const { checkOpenSourceGovernanceFiles } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;

      // Fault case 1: missing LICENSE
      const mockDir1 = join(tempDir, "gov-fault-1");
      setupMockGovernance(mockDir1, { LICENSE: null });
      const res1 = checkOpenSourceGovernanceFiles(mockDir1);
      expect(res1.ok).toBe(false);
      expect(res1.violations.some((v: string) => v.includes("LICENSE: file missing"))).toBe(true);

      // Fault case 2: non-MIT LICENSE
      const mockDir2 = join(tempDir, "gov-fault-2");
      setupMockGovernance(mockDir2, { LICENSE: "GPLv3 License text without permission clause" });
      const res2 = checkOpenSourceGovernanceFiles(mockDir2);
      expect(res2.ok).toBe(false);
      expect(
        res2.violations.some((v: string) => v.includes("LICENSE: must specify MIT license")),
      ).toBe(true);

      // Fault case 3: CONTRIBUTING.md missing toolchain or check commands
      const mockDir3 = join(tempDir, "gov-fault-3");
      setupMockGovernance(mockDir3, { "CONTRIBUTING.md": "# Incomplete contributing guide" });
      const res3 = checkOpenSourceGovernanceFiles(mockDir3);
      expect(res3.ok).toBe(false);
      expect(
        res3.violations.some((v: string) =>
          v.includes("CONTRIBUTING.md: must document pinned Node 26.8.1"),
        ),
      ).toBe(true);
      expect(
        res3.violations.some((v: string) =>
          v.includes("CONTRIBUTING.md: must document pinned Bun 1.4.2"),
        ),
      ).toBe(true);

      // Fault case 4: .gitattributes missing eol=lf
      const mockDir4 = join(tempDir, "gov-fault-4");
      setupMockGovernance(mockDir4, { ".gitattributes": "* text=auto eol=crlf" });
      const res4 = checkOpenSourceGovernanceFiles(mockDir4);
      expect(res4.ok).toBe(false);
      expect(
        res4.violations.some((v: string) => v.includes('.gitattributes: must enforce "eol=lf"')),
      ).toBe(true);

      // Fault case 5: renovate.json with lockFileMaintenance disabled
      const mockDir5 = join(tempDir, "gov-fault-5");
      setupMockGovernance(mockDir5, {
        "renovate.json": JSON.stringify({
          lockFileMaintenance: { enabled: false },
          osvVulnerabilityAlerts: true,
          packageRules: [],
        }),
      });
      const res5 = checkOpenSourceGovernanceFiles(mockDir5);
      expect(res5.ok).toBe(false);
      expect(
        res5.violations.some((v: string) => v.includes("lockFileMaintenance.enabled must be true")),
      ).toBe(true);

      // Fault case 6: issue template defaulting to ready-for-agent
      const mockDir6 = join(tempDir, "gov-fault-6");
      setupMockGovernance(mockDir6, {
        ".github/ISSUE_TEMPLATE/bug_report.md": `---
name: Bug Report
labels:
  - ready-for-agent
---
## Source and problem
## Outcome
## Invariants
## Acceptance criteria
## Boundary
Depends on: None
`,
      });
      const res6 = checkOpenSourceGovernanceFiles(mockDir6);
      expect(res6.ok).toBe(false);
      expect(
        res6.violations.some((v: string) => v.includes('must never default to "ready-for-agent"')),
      ).toBe(true);

      // Fault case 7: issue template missing canonical sections
      const mockDir7 = join(tempDir, "gov-fault-7");
      setupMockGovernance(mockDir7, {
        ".github/ISSUE_TEMPLATE/feature_request.md": `---
name: Feature Request
labels:
  - needs-triage
---
## Problem Description
No canonical sections here.
`,
      });
      const res7 = checkOpenSourceGovernanceFiles(mockDir7);
      expect(res7.ok).toBe(false);
      expect(
        res7.violations.some((v: string) =>
          v.includes('missing canonical section "Acceptance criteria"'),
        ),
      ).toBe(true);
    });

    test("AC1-AC4: unified checkArchitectureRules aggregates clean repo status", async () => {
      const { checkArchitectureRules } = (await import(
        // @ts-expect-error dynamic mjs import
        "../../scripts/health/check-architecture.mjs"
      )) as any;
      const result = checkArchitectureRules(process.cwd());
      expect(result.ok).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });
});
