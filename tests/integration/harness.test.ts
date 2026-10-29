import { describe, expect, test } from "vitest";
import { runChecks } from "../../harness/ci";
import { classifyLog, applyDefect, type Defect } from "../../harness/mutations/mutator";
import { HarnessService, handleHarnessRoute } from "../../apps/backend/src/harness";
import registerLoopGuard from "../../.factory/hooks/loop-guard";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("TypeScript Harness and Mutation Verification", () => {
  test("AC1: runChecks runs static and unit checks cleanly from harness.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
    try {
      const config = {
        static: "echo STATIC_PASS",
        unit: "echo Ran 10 tests",
        unit_count_pattern: "Ran (\\d+) test",
      };
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-pkg" }));
      const harnessDir = join(dir, "harness");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(join(harnessDir, "harness.config.json"), JSON.stringify(config));

      const res = runChecks(dir);
      expect(res.success).toBe(true);
      expect(res.output).toContain("HARNESS_START");
      expect(res.output).toContain("STATIC_OK");
      expect(res.output).toContain("UNIT_PASSED tests=10");
      expect(res.output).toContain("CHECKS_OK mode=ordinary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2: applyDefect applies mutation accurately and fails on ambiguous or missing anchor", () => {
    const dir = mkdtempSync(join(tmpdir(), "defect-test-"));
    try {
      writeFileSync(join(dir, "app.ts"), "export const status = 'healthy';\n");
      const defect: Defect = {
        id: "break-health",
        file: "app.ts",
        find: "'healthy'",
        replace: "'broken'",
        why: "simulate deliberate defect",
      };

      const applied = applyDefect(dir, defect);
      expect(applied.success).toBe(true);

      const content = readFileSync(join(dir, "app.ts"), "utf-8");
      expect(content).toContain("'broken'");

      // Missing anchor
      const bad = applyDefect(dir, { ...defect, find: "nonexistent" });
      expect(bad.success).toBe(false);
      expect(bad.error).toBe("anchor not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC2/AC6: classifyLog accurately detects CAUGHT vs ESCAPED vs INCONCLUSIVE", () => {
    const okLog = "HARNESS_START\nSTATIC_OK\nUNIT_PASSED\nCHECKS_OK";
    expect(classifyLog(0, okLog).outcome).toBe("ESCAPED");

    const failedLog = "HARNESS_START\nGATE_FAILED: unit";
    expect(classifyLog(1, failedLog).outcome).toBe("CAUGHT");
    expect(classifyLog(1, failedLog).label).toBe("unit");

    const timeoutLog = "Killed";
    expect(classifyLog(124, timeoutLog).outcome).toBe("INCONCLUSIVE");
  });

  test("AC7: Backend HarnessService & HTTP routes serve lessons, tool guidance, and atomic veto", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-api-"));
    try {
      const factoryDir = join(dir, ".factory");
      mkdirSync(factoryDir, { recursive: true });
      const sampleLesson = {
        id: "lsn-20261029-01",
        topic: "port-binding",
        trigger_patterns: ["apps/backend/*"],
        rule: "Assign an explicit non-zero port before passing FACTORY_HOST_URL.",
        evidence: "Lap #1 failed on port 0.",
        vetoed: false,
        occurrence_count: 1,
        created_at: "2026-10-29T00:00:00Z",
      };
      writeFileSync(join(factoryDir, "lessons.jsonl"), JSON.stringify(sampleLesson) + "\n");
      writeFileSync(
        join(factoryDir, "tool-guidance.json"),
        JSON.stringify({ test: "bun harness/ci.ts", lint: "bun run lint" }),
      );

      const service = new HarnessService(dir);

      const lessonsRes = await handleHarnessRoute(
        new Request("http://127.0.0.1/api/harness/lessons"),
        "/api/harness/lessons",
        service,
      );
      expect(lessonsRes?.status).toBe(200);
      const lessonsData = await lessonsRes!.json();
      expect(lessonsData.safe_mode).toBe(false);
      expect(lessonsData.lessons).toHaveLength(1);
      expect(lessonsData.lessons[0].id).toBe("lsn-20261029-01");

      const toolsRes = await handleHarnessRoute(
        new Request("http://127.0.0.1/api/v1/harness/tools"),
        "/api/v1/harness/tools",
        service,
      );
      expect(toolsRes?.status).toBe(200);
      const toolsData = await toolsRes!.json();
      expect(toolsData.tools.test).toBe("bun harness/ci.ts");

      // Veto lesson
      const vetoRes = await handleHarnessRoute(
        new Request("http://127.0.0.1/api/harness/veto", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "lsn-20261029-01" }),
        }),
        "/api/harness/veto",
        service,
      );
      expect(vetoRes?.status).toBe(200);
      const vetoData = await vetoRes!.json();
      expect(vetoData.vetoed).toBe(true);

      // Verify persisted veto state
      const afterLessons = service.readLessons();
      expect(afterLessons[0]?.vetoed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("AC8: Pi Extension loop-guard hook blocks protected paths and appends tool guidance hints", async () => {
    const handlers: Record<string, (ev: any) => Promise<any>> = {};
    registerLoopGuard({
      on(event: string, fn: (ev: any) => Promise<any>) {
        handlers[event] = fn;
      },
    });

    expect(typeof handlers.tool_call).toBe("function");
    expect(typeof handlers.tool_result).toBe("function");

    const blocked = await handlers.tool_call!({
      toolName: "write",
      args: { path: "harness/ci.ts", content: "hacked" },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("HARNESS GUARD");

    const allowed = await handlers.tool_call!({
      toolName: "edit",
      args: { path: "apps/backend/src/main.ts" },
    });
    expect(allowed).toBeUndefined();
  });
});
