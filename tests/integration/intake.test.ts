import { describe, expect, test } from "vitest";
import {
  parseDependencies,
  isActiveClaim,
  evaluateIssueAdmission,
  IntakeService,
  type RawIssue,
} from "../../apps/backend/src/intake";

describe("Intake admission policy (canonical)", () => {
  test("parses dependencies from body and comments", () => {
    expect(parseDependencies("Depends on: #10, #12\nSome text")).toEqual([10, 12]);
    expect(parseDependencies("depends on: 15")).toEqual([15]);
    expect(parseDependencies("No dependencies")).toEqual([]);
  });

  test("detects active loop claims in comments", () => {
    expect(isActiveClaim([{ body: "Just a comment" }])).toBe(false);
    expect(isActiveClaim([{ body: "Loop claim: run 1234-abcd" }])).toBe(true);
  });

  test("AC1: canonical ready-for-agent admits, legacy labels have no authority", () => {
    const all = new Map<number, RawIssue>();
    // Canonical ready-for-agent admits
    const ready = evaluateIssueAdmission(
      { number: 1, title: "Feature", state: "OPEN", labels: ["ready-for-agent"] },
      all,
    );
    expect(ready.admission_status).toBe("admitted");
    expect(ready.reason).toBe("admitted_ready");

    // Legacy factory:ready alone is not admitted (held due to missing_ready_label)
    const legacyReady = evaluateIssueAdmission(
      { number: 2, title: "Legacy", state: "OPEN", labels: ["factory:ready"] },
      all,
    );
    expect(legacyReady.admission_status).toBe("held");
    expect(legacyReady.reason).toBe("missing_ready_label");

    // Blocking labels: needs-info, ready-for-human, needs-triage
    for (const label of ["needs-info", "ready-for-human", "needs-triage"]) {
      const held = evaluateIssueAdmission(
        { number: 3, title: "Held", state: "OPEN", labels: [label, "ready-for-agent"] },
        all,
      );
      expect(held.admission_status).toBe("held");
      expect(held.reason).toBe("held_by_label");
    }

    // wontfix excludes even if ready-for-agent is present
    const excluded = evaluateIssueAdmission(
      { number: 4, title: "Wontfix", state: "OPEN", labels: ["wontfix", "ready-for-agent"] },
      all,
    );
    expect(excluded.admission_status).toBe("excluded");
    expect(excluded.reason).toBe("excluded_by_label");

    // Unlabeled holds
    const unlabeled = evaluateIssueAdmission(
      { number: 5, title: "Unlabeled", state: "OPEN", labels: [] },
      all,
    );
    expect(unlabeled.admission_status).toBe("held");
    expect(unlabeled.reason).toBe("unlabeled_awaiting_triage");
  });

  test("AC2: dependencies and active claims hold work", () => {
    const all = new Map<number, RawIssue>();
    all.set(10, { number: 10, title: "Prereq open", state: "OPEN" });
    all.set(11, { number: 11, title: "Prereq closed", state: "CLOSED" });

    // Open dependency holds
    const waitingOpen = evaluateIssueAdmission(
      {
        number: 1,
        title: "Waiting",
        state: "OPEN",
        labels: ["ready-for-agent"],
        body: "Depends on: #10",
      },
      all,
    );
    expect(waitingOpen.admission_status).toBe("held");
    expect(waitingOpen.reason).toBe("waiting_on_dependency:#10");
    expect(waitingOpen.unsatisfied_dependencies).toEqual([10]);

    // Missing dependency holds
    const waitingMissing = evaluateIssueAdmission(
      {
        number: 2,
        title: "Waiting missing",
        state: "OPEN",
        labels: ["ready-for-agent"],
        body: "Depends on: #99",
      },
      all,
    );
    expect(waitingMissing.admission_status).toBe("held");
    expect(waitingMissing.reason).toBe("waiting_on_dependency:#99");

    // Closed dependency admits
    const satisfied = evaluateIssueAdmission(
      {
        number: 3,
        title: "Satisfied",
        state: "OPEN",
        labels: ["ready-for-agent"],
        body: "Depends on: #11",
      },
      all,
    );
    expect(satisfied.admission_status).toBe("admitted");
    expect(satisfied.unsatisfied_dependencies).toEqual([]);

    // Active claim holds
    const claimed = evaluateIssueAdmission(
      {
        number: 4,
        title: "Claimed",
        state: "OPEN",
        labels: ["ready-for-agent"],
        comments: [{ body: "Loop claim: run 9876-xyz" }],
      },
      all,
    );
    expect(claimed.admission_status).toBe("held");
    expect(claimed.reason).toBe("actively_claimed");
  });

  test("AC3: Admission evaluates needs-triage deterministically without Jev advisory fields", () => {
    const all = new Map<number, RawIssue>();
    const evaluated = evaluateIssueAdmission(
      {
        number: 1,
        title: "Needs Triage Task",
        state: "OPEN",
        labels: ["needs-triage"],
        body: "Fully specified feature with ACs",
      },
      all,
    );

    // Admission status remains strictly held without Jev advisory fields
    expect(evaluated.admission_status).toBe("held");
    expect(evaluated.reason).toBe("held_by_label");
    expect(evaluated.labels).toEqual(["needs-triage"]);
    expect((evaluated as any).recommended_label).toBeUndefined();
    expect((evaluated as any).confidence).toBeUndefined();
    expect((evaluated as any).complexity).toBeUndefined();
    expect((evaluated as any).probabilities).toBeUndefined();
    expect((evaluated as any).jev_evaluation).toBeUndefined();
  });

  test("AC3b: Admission evaluates unlabeled issues deterministically without Jev advisory fields", () => {
    const all = new Map<number, RawIssue>();
    const evaluated = evaluateIssueAdmission(
      {
        number: 2,
        title: "Unlabeled Task",
        state: "OPEN",
        labels: [],
        body: "Unlabeled task description",
      },
      all,
    );

    expect(evaluated.admission_status).toBe("held");
    expect(evaluated.reason).toBe("unlabeled_awaiting_triage");
    expect(evaluated.labels).toEqual([]);
    expect((evaluated as any).recommended_label).toBeUndefined();
    expect((evaluated as any).confidence).toBeUndefined();
    expect((evaluated as any).complexity).toBeUndefined();
    expect((evaluated as any).probabilities).toBeUndefined();
    expect((evaluated as any).jev_evaluation).toBeUndefined();
  });

  test("AC4: IntakeService caches and refresh invalidates cache", async () => {
    let callCount = 0;
    const runner = async (args: string[]) => {
      if (args[1] === "graphql" || args.includes("graphql")) {
        callCount++;
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                nodes: [
                  {
                    number: 1,
                    title: "Issue 1",
                    body: "",
                    state: "OPEN",
                    labels: {
                      nodes: [{ name: "ready-for-agent" }],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      }
      return "[]";
    };

    const service = new IntakeService({ runner, ttlSeconds: 60 });
    const first = await service.evaluateBacklog(false);
    expect(first.cached).toBe(false);
    expect(callCount).toBe(1);

    const second = await service.evaluateBacklog(false);
    expect(second.cached).toBe(true);
    expect(callCount).toBe(1);

    const refreshed = await service.evaluateBacklog(true);
    expect(refreshed.cached).toBe(false);
    expect(callCount).toBe(2);
  });
});
