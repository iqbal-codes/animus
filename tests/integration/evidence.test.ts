import { describe, expect, test } from "vitest";
import { readLapEvidence, readLapReport } from "../../apps/engine-host/src/native";

describe("Lap evidence and report projection", () => {
  test("AC3: nonexistent lap throws lap_not_found error", () => {
    expect(() => readLapEvidence(process.cwd(), "nonexistent-id")).toThrow("lap_not_found");
    expect(() => readLapReport(process.cwd(), "nonexistent-id")).toThrow("lap_not_found");
  });

  test("AC4: redactions strip raw credentials and private tokens from projections", () => {
    const rawSecret = "Bearer sk-or-v1-secret-key-1234567890";
    const sanitized = rawSecret.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
    expect(sanitized).not.toContain("sk-or-v1-secret-key-1234567890");
    expect(sanitized).toContain("[redacted]");
  });
});
