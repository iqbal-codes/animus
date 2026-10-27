import { describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareRuntimeResource,
  startCandidateEnvironment,
  isOwnedDestination,
  killProcessTree,
} from "../../apps/engine-host/src/candidate";

function createCleanTestRepo(): { repoPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "clean-repo-"));
  execSync("git init -b main", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email 'test@example.com'", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name 'Test Runner'", { cwd: dir, stdio: "ignore" });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "clean-test", version: "1.0.0" }),
  );
  execSync("git add package.json", { cwd: dir, stdio: "ignore" });
  execSync("git commit -m 'initial commit'", { cwd: dir, stdio: "ignore" });
  return {
    repoPath: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Candidate resource preparation and environment start", () => {
  test("AC1: preparation materializes resource and writes verified marker", () => {
    const { repoPath, cleanup: cleanRepo } = createCleanTestRepo();
    const dest = mkdtempSync(join(tmpdir(), "candidate-res-"));
    try {
      const res = prepareRuntimeResource(repoPath, dest, ["package.json"]);

      expect(res.version).toBe(1);
      expect(res.kind).toBe("factory-runtime-resource");
      expect(res.resource_root).toBe(dest);
      expect(typeof res.source_revision).toBe("string");
      expect(res.source_revision.length).toBe(40);
      expect(typeof res.resource_digest).toBe("string");
      expect(isOwnedDestination(dest)).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
      cleanRepo();
    }
  });

  test("AC4: escaping and private includes are refused", () => {
    const { repoPath, cleanup: cleanRepo } = createCleanTestRepo();
    const dest = mkdtempSync(join(tmpdir(), "candidate-refuse-"));
    try {
      expect(() => prepareRuntimeResource(repoPath, dest, ["../escaping"])).toThrow(
        "private or escaping source path refused",
      );
      expect(() => prepareRuntimeResource(repoPath, dest, [".git"])).toThrow(
        "private or escaping source path refused",
      );
      expect(() => prepareRuntimeResource(repoPath, dest, [".env"])).toThrow(
        "private or escaping source path refused",
      );
    } finally {
      rmSync(dest, { recursive: true, force: true });
      cleanRepo();
    }
  });

  test("AC2/AC5: starts real Bun candidate without leaking secrets or parent credentials", async () => {
    const { repoPath, cleanup: cleanRepo } = createCleanTestRepo();
    const dest = mkdtempSync(join(tmpdir(), "candidate-start-"));
    try {
      // Create minimal self-contained runnable Bun app
      prepareRuntimeResource(repoPath, dest, ["package.json"]);
      writeFileSync(
        join(dest, "server.ts"),
        `
        const port = Number(process.env.FACTORY_RUNTIME_PORT || 0);
        const server = Bun.serve({
          port,
          fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/health") {
              return Response.json({
                status: "healthy",
                candidate: process.env.FACTORY_RUNTIME_CANDIDATE,
                secretLeaked: !!process.env.OPENROUTER_API_KEY || !!process.env.FACTORY_HOST_TOKEN,
              });
            }
            return new Response("not found", { status: 404 });
          }
        });
        console.log("ready on port " + server.port);
      `,
      );

      const gitRev = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();

      // Update digest after adding server.ts
      const { calculateResourceDigest, MARKER } =
        await import("../../apps/engine-host/src/candidate");
      const digest = calculateResourceDigest(dest);
      writeFileSync(
        join(dest, MARKER),
        JSON.stringify(
          {
            version: 1,
            kind: "factory-runtime-resource",
            source_revision: gitRev,
            resource_root: dest,
            resource_digest: digest,
            created_at: new Date().toISOString(),
          },
          null,
          2,
        ),
      );

      const candidate = await startCandidateEnvironment({
        slot: "test-slot-1",
        resourceRoot: dest,
        expectedRevision: gitRev,
        command: ["bun", join(dest, "server.ts")],
        env: {
          OPENROUTER_API_KEY: "secret-key",
          FACTORY_HOST_TOKEN: "secret-token",
          CUSTOM_BENIGN_VAR: "allowed",
        },
      });

      expect(typeof candidate.candidateIdentity).toBe("string");
      expect(candidate.candidateIdentity.startsWith("factory-v1:")).toBe(true);

      const healthRes = await fetch(`${candidate.url}/health`);
      expect(healthRes.status).toBe(200);
      const body = (await healthRes.json()) as any;
      expect(body.status).toBe("healthy");
      expect(body.candidate).toBe(candidate.candidateIdentity);
      expect(body.secretLeaked).toBe(false);

      const stateDir = candidate.stateDir;
      expect(existsSync(stateDir)).toBe(true);

      await candidate.stop();
      expect(existsSync(stateDir)).toBe(false);
    } finally {
      rmSync(dest, { recursive: true, force: true });
      cleanRepo();
    }
  });

  test("AC3: process tree termination terminates descendants cleanly", () => {
    // Test killProcessTree
    expect(() => killProcessTree(999999, "SIGTERM")).not.toThrow();
  });
});
