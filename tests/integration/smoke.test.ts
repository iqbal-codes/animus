import { describe, expect, test } from "vitest";
import { evaluateIssueAdmission, type RawIssue } from "../../apps/backend/src/intake";

describe("Issue #42 E2E Admission & Engine Dispatch Smoke", () => {
  test("intake accurately admits independent issue #42 as ready-for-agent", async () => {
    const rawIssue: RawIssue = {
      number: 42,
      title: "Test: verify end-to-end admission and engine dispatch in TypeScript monorepo",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      body: "Depends on: None",
      comments: [],
    };

    const issuesMap = new Map([[42, rawIssue]]);
    const evaluated = await evaluateIssueAdmission(rawIssue, issuesMap);

    expect(evaluated.number).toBe(42);
    expect(evaluated.state).toBe("OPEN");
    expect(evaluated.admission_status).toBe("admitted");
    expect(evaluated.reason).toBe("admitted_ready");
    expect(evaluated.dependencies).toEqual([]);
    expect(evaluated.unsatisfied_dependencies).toEqual([]);
  });

  test("intake holds issue when blocking label or dependency is introduced", async () => {
    const blockedIssue: RawIssue = {
      number: 42,
      title: "Test: verify end-to-end admission and engine dispatch in TypeScript monorepo",
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "needs-info" }],
      body: "Depends on: #999",
      comments: [],
    };

    const issuesMap = new Map([[42, blockedIssue]]);
    const evaluated = await evaluateIssueAdmission(blockedIssue, issuesMap);

    expect(evaluated.admission_status).toBe("held");
    expect(evaluated.reason).toBe("held_by_label");
    expect(evaluated.dependencies).toEqual([999]);
    expect(evaluated.unsatisfied_dependencies).toEqual([999]);
  });
});
