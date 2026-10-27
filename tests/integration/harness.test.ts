import { describe, expect, test } from "vitest";
import { runChecks } from "../../harness/ci";
import { classifyLog, applyDefect, type Defect } from "../../harness/mutations/mutator";
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
});
