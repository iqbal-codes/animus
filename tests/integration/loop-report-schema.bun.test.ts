import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateHostReadiness,
  extractReport,
  validateBuilderReport,
  validateEvidenceCitations,
  validateQaReport,
  validateReviewerReport,
} from "../../scripts/loop/artifacts";
import { BUNDLED_PROMPTS } from "../../scripts/loop/bundled-prompts";
import { loadPrompt } from "../../scripts/loop/prompts";
import { buildProviderArgv, materializeSkillContent } from "../../scripts/loop/providers";
import { hostBoundIdentitiesSchema, type ReviewFinding } from "../../scripts/loop/report-schema";
import { extractRequiredAcIds } from "../../scripts/local-loop";

describe("Loop Report Schema & Strict Validation", () => {
  test("whitespace in a citation never bypasses file verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "citation-spaces-"));
    try {
      expect(
        validateEvidenceCitations(
          { lines: [{ id: "C1", evidence: ["tests passed cleanly"] }] },
          root,
        ).ok,
      ).toBe(false);
      await writeFile(join(root, "actual evidence.log"), "Observed assertion");
      expect(
        validateEvidenceCitations(
          { lines: [{ id: "C1", evidence: ["actual evidence.log"] }] },
          root,
        ).ok,
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("legacy string finding is blocking rather than silently approved", () => {
    const result = validateReviewerReport(
      {
        sha: "candidate",
        outcome: "approved",
        findings: ["Critical data loss"],
        axes: { standards: { status: "pass" }, spec: { status: "pass" } },
      },
      "candidate",
    );
    expect(result.problems.some((p) => p.includes("contradictory"))).toBe(true);
  });
  test("HostBoundIdentities requires non-empty SHAs and distinguishes base tip from merge-base", () => {
    const valid = {
      targetBaseTip: "1111111111111111111111111111111111111111",
      mergeBase: "2222222222222222222222222222222222222222",
      prHead: "3333333333333333333333333333333333333333",
      testedHead: "4444444444444444444444444444444444444444",
      environment: "linux x86_64 Bun 1.4.2",
    };
    expect(hostBoundIdentitiesSchema.parse(valid)).toEqual(valid);

    // Missing targetBaseTip
    expect(() =>
      hostBoundIdentitiesSchema.parse({
        mergeBase: "2222",
        prHead: "3333",
        testedHead: "4444",
      }),
    ).toThrow();

    // Empty SHA
    expect(() =>
      hostBoundIdentitiesSchema.parse({
        targetBaseTip: "",
        mergeBase: "2222",
        prHead: "3333",
        testedHead: "4444",
      }),
    ).toThrow();
  });

  test("validateBuilderReport rejects missing or mismatched candidate SHA", () => {
    const expected = "c0ffee1111";

    // Missing candidate
    expect(() => validateBuilderReport({ verdict: "pass", checks: [] }, expected)).toThrow(
      /Missing required builder candidate identity/,
    );

    // Mismatched candidate
    expect(() =>
      validateBuilderReport({ candidate: "wrong_sha", verdict: "pass", checks: [] }, expected),
    ).toThrow(/does not match expected candidate/);

    // Correct candidate with passing check
    const { report, problems } = validateBuilderReport(
      {
        candidate: expected,
        verdict: "pass",
        checks: [{ criterion: "build", result: "pass", evidence: "exit 0" }],
      },
      expected,
    );
    expect(report.candidate).toBe(expected);
    expect(problems.length).toBe(0);

    // Pass verdict with empty checks emits problem
    const emptyCheckRes = validateBuilderReport(
      { candidate: expected, verdict: "pass", checks: [] },
      expected,
    );
    expect(emptyCheckRes.problems.some((p) => p.includes("empty verification checks"))).toBe(true);
  });

  test("validateQaReport strictly validates tested head, duplicate lines, and empty PASS", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-qa-val-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "test.log"), "all good");

    const expectedHead = "head_12345";

    // 1. Missing head
    expect(() =>
      validateQaReport({ overall: "PASS", lines: [] }, expectedHead, artifactsDir),
    ).toThrow(/Missing required QA tested head identity/);

    // 2. Mismatched head
    expect(() =>
      validateQaReport(
        { head: "wrong_head", overall: "PASS", lines: [] },
        expectedHead,
        artifactsDir,
      ),
    ).toThrow(/does not match expected tested identity/);

    // 3. Empty PASS (overall PASS with zero lines)
    const emptyPass = validateQaReport(
      { head: expectedHead, overall: "PASS", lines: [] },
      expectedHead,
      artifactsDir,
    );
    expect(emptyPass.problems.some((p) => p.includes("zero verification criteria"))).toBe(true);

    // 4. Duplicate criterion IDs
    const duplicateLines = validateQaReport(
      {
        head: expectedHead,
        overall: "PASS",
        lines: [
          { id: "AC1", verdict: "PASS", evidence: ["test.log"] },
          { id: "AC1", verdict: "PASS", evidence: ["test.log"] },
        ],
      },
      expectedHead,
      artifactsDir,
    );
    expect(duplicateLines.problems.some((p) => p.includes("duplicate line/criterion ID"))).toBe(
      true,
    );

    // 5. PASS with non-passing criteria
    const contradictoryPass = validateQaReport(
      {
        head: expectedHead,
        overall: "PASS",
        lines: [
          { id: "AC1", verdict: "PASS", evidence: ["test.log"] },
          { id: "AC2", verdict: "FAIL", text: "crashed", evidence: ["test.log"] },
        ],
      },
      expectedHead,
      artifactsDir,
    );
    expect(contradictoryPass.problems.some((p) => p.includes("non-passing lines"))).toBe(true);

    // 6. Missing required AC coverage
    const missingAc = validateQaReport(
      {
        head: expectedHead,
        overall: "PASS",
        lines: [{ id: "AC1", verdict: "PASS", evidence: ["test.log"] }],
      },
      expectedHead,
      artifactsDir,
      { requiredAcIds: ["AC1", "AC2"] },
    );
    expect(
      missingAc.problems.some((p) => p.includes("missing required acceptance criterion: 'AC2'")),
    ).toBe(true);

    // 7. Clean valid QA report
    const cleanQa = validateQaReport(
      {
        head: expectedHead,
        overall: "PASS",
        lines: [
          { id: "AC1", verdict: "PASS", evidence: ["test.log"] },
          { id: "AC2", verdict: "PASS", evidence: ["test.log"] },
        ],
      },
      expectedHead,
      artifactsDir,
      { requiredAcIds: ["AC1", "AC2"] },
    );
    expect(cleanQa.problems.length).toBe(0);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("validateEvidenceCitations rejects missing, escaping, and directory evidence", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-ev-val-"));
    const artifactsDir = join(tempDir, "artifacts");
    const subDir = join(artifactsDir, "some_dir");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(artifactsDir, "real_file.log"), "content");
    await writeFile(join(tempDir, "outside_secret.txt"), "secret");

    // Valid citation
    const valid = validateEvidenceCitations(
      { lines: [{ id: "C1", evidence: ["real_file.log"] }] },
      artifactsDir,
    );
    expect(valid.ok).toBe(true);
    expect(valid.problems.length).toBe(0);

    // Missing file
    const missing = validateEvidenceCitations(
      { lines: [{ id: "C1", evidence: ["missing_file.log"] }] },
      artifactsDir,
    );
    expect(missing.ok).toBe(false);
    expect(missing.problems.some((p) => p.includes("cited missing evidence"))).toBe(true);

    // Path traversal with ..
    const escaping = validateEvidenceCitations(
      { lines: [{ id: "C1", evidence: ["../outside_secret.txt"] }] },
      artifactsDir,
    );
    expect(escaping.ok).toBe(false);
    expect(escaping.problems.some((p) => p.includes("escaping evidence path"))).toBe(true);

    // Directory cited instead of file
    const dirCitation = validateEvidenceCitations(
      { lines: [{ id: "C1", evidence: ["some_dir"] }] },
      artifactsDir,
    );
    expect(dirCitation.ok).toBe(false);
    expect(dirCitation.problems.some((p) => p.includes("non-file (directory or special)"))).toBe(
      true,
    );

    await rm(tempDir, { recursive: true, force: true });
  });

  test("validateReviewerReport strictly validates candidate SHA and rejects approved + blocks", () => {
    const expectedSha = "rev_99999";

    // Missing SHA
    expect(() => validateReviewerReport({ outcome: "approved" }, expectedSha)).toThrow(
      /Missing required reviewer candidate identity/,
    );

    // Mismatched SHA
    expect(() =>
      validateReviewerReport({ sha: "different_sha", outcome: "approved" }, expectedSha),
    ).toThrow(/does not match expected candidate/);

    // Contradictory approved + blocking disposition
    const approvedWithBlocks = validateReviewerReport(
      {
        sha: expectedSha,
        outcome: "approved",
        dispositions: [{ line: "D1", action: "blocks", reason: "regressed critical invariant" }],
      },
      expectedSha,
    );
    expect(
      approvedWithBlocks.problems.some((p) =>
        p.includes("contradictory with 0 blocking finding(s) and 1 blocking disposition(s)"),
      ),
    ).toBe(true);

    // Valid zero-defect approved report
    const validApproved = validateReviewerReport(
      {
        sha: expectedSha,
        outcome: "approved",
        dispositions: [{ line: "D1", action: "accepted", reason: "cosmetic question" }],
      },
      expectedSha,
    );
    expect(validApproved.problems.length).toBe(0);
  });

  test("evaluateHostReadiness holds readiness when any verification or candidate condition fails", () => {
    // Case 1: All clean -> ready
    const readyRes = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: true, overall: "PASS" },
      reviewerReport: { passed: true, outcome: "approved" },
      ciPassed: true,
      lap: 0,
      maxLaps: 3,
    });
    expect(readyRes.ready).toBe(true);
    expect(readyRes.verdict).toBe("waiting_approval");

    // Case 2: Candidate unstable (HEAD mutated) -> held
    const mutatedHead = evaluateHostReadiness({
      candidateStable: false,
      ordinaryChecksPassed: true,
      qaReport: { passed: true, overall: "PASS" },
      reviewerReport: { passed: true, outcome: "approved" },
      ciPassed: true,
      lap: 0,
      maxLaps: 3,
    });
    expect(mutatedHead.ready).toBe(false);
    expect(mutatedHead.verdict).toBe("sent_back");
    expect(mutatedHead.reasons.some((r) => r.includes("HEAD mutated"))).toBe(true);

    // Case 3: Reviewer approved but QA failed -> held (reviewer cannot override failed QA)
    const qaFailed = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: false, overall: "FAIL" },
      reviewerReport: { passed: true, outcome: "approved" },
      ciPassed: true,
      lap: 0,
      maxLaps: 3,
    });
    expect(qaFailed.ready).toBe(false);
    expect(qaFailed.verdict).toBe("sent_back");

    // Case 4: Max laps exceeded -> needs_owner
    const maxLapsExceeded = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: false, overall: "FAIL" },
      reviewerReport: { passed: false, outcome: "sent-back" },
      ciPassed: true,
      lap: 3,
      maxLaps: 3,
    });
    expect(maxLapsExceeded.ready).toBe(false);
    expect(maxLapsExceeded.verdict).toBe("needs_owner");
  });

  test("extractReport parses real prompt-shaped builder report and enforces candidate identity and checks", () => {
    const candidateSha = "c0ffee1234567890abcdef1234567890abcdef12";
    const promptShapedBuilder = `
Here is my completed work for this lap.

\`\`\`json
{
  "candidate": "${candidateSha}",
  "verdict": "pass",
  "summary": "Implemented discriminated report schemas and host readiness gates.",
  "outcome": "Strict validation active; all callers aligned.",
  "invariants": [
    "Candidate identity must match host-pinned SHA."
  ],
  "reviewGuidance": [
    "Start at scripts/loop/report-schema.ts; then inspect artifacts.ts."
  ],
  "risk": "Low blast radius confined to loop validation logic.",
  "changedSeams": [
    {
      "seam": "extractReport",
      "impact": "Preserves structured reviewer findings instead of flattening."
    }
  ],
  "changes": [
    "scripts/loop/artifacts.ts: updated extractReport"
  ],
  "checks": [
    {
      "criterion": "typecheck",
      "result": "pass",
      "evidence": "bun run typecheck exited 0"
    }
  ],
  "captures": []
}
\`\`\`
`;
    const res = extractReport(promptShapedBuilder, candidateSha, "builder");
    expect(res.passed).toBe(true);
    expect(res.candidate).toBe(candidateSha);
    expect(res.outcome).toContain("Strict validation active");
    expect(res.invariants).toHaveLength(1);
    expect(res.risk).toContain("blast radius");
    expect(res.changedSeams).toHaveLength(1);
    expect(res.checks).toHaveLength(1);

    // Mismatched candidate throws
    expect(() => extractReport(promptShapedBuilder, "different_sha_1234", "builder")).toThrow(
      /does not match expected candidate/,
    );

    // Builder claiming pass with empty checks
    const emptyChecksBuilder = JSON.stringify({
      candidate: candidateSha,
      verdict: "pass",
      checks: [],
    });
    const emptyRes = extractReport(emptyChecksBuilder, candidateSha, "builder");
    expect(emptyRes.passed).toBe(false);
    expect(emptyRes.problems.some((p: string) => p.includes("empty verification checks"))).toBe(
      true,
    );
  });

  test("extractReport parses real prompt-shaped QA report and validates required ACs", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-qa-extract-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(join(artifactsDir, "test.log"), "all passed");

    const testedHead = "head_qa_9876543210";
    const promptShapedQa = `
Finished checking the application.

\`\`\`json
{
  "head": "${testedHead}",
  "overall": "PASS",
  "lines": [
    { "id": "AC1", "verdict": "PASS", "evidence": ["test.log"] },
    { "id": "AC2", "verdict": "PASS", "evidence": ["test.log"] }
  ],
  "summary": "All acceptance criteria verified against live server."
}
\`\`\`
`;

    // 1. Valid with all required ACs present
    const validQa = extractReport(promptShapedQa, testedHead, "qa", artifactsDir, {
      requiredAcIds: ["AC1", "AC2"],
    });
    expect(validQa.passed).toBe(true);
    expect(validQa.head).toBe(testedHead);
    expect(validQa.lines).toHaveLength(2);

    // 2. Fails when missing required AC
    const missingAcQa = extractReport(promptShapedQa, testedHead, "qa", artifactsDir, {
      requiredAcIds: ["AC1", "AC2", "AC3"],
    });
    expect(missingAcQa.passed).toBe(false);
    expect(
      missingAcQa.problems.some((p: string) =>
        p.includes("missing required acceptance criterion: 'AC3'"),
      ),
    ).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("extractReport parses real prompt-shaped reviewer report and preserves structured findings", () => {
    const candidateSha = "rev_sha_1122334455";
    const structuredFinding: ReviewFinding = {
      id: "F1",
      axis: "standards",
      classification: "defect",
      blocking: true,
      title: "Unvalidated candidate SHA accepted",
      description: "Validation did not verify candidate string length.",
      location: {
        file: "scripts/loop/artifacts.ts",
        line: 42,
      },
      evidence: "artifacts/review.log",
      status: "open",
      lapIntroduced: 0,
    };

    const promptShapedReviewer = `
Code review completed across Standards and Spec axes.

\`\`\`json
{
  "outcome": "sent-back",
  "pr": "https://github.com/example/repo/pull/42",
  "sha": "${candidateSha}",
  "delivers": "part",
  "axes": {
    "standards": {
      "status": "fail",
      "summary": "Standards violation detected in validation seam."
    },
    "spec": {
      "status": "pass",
      "summary": "Acceptance criteria satisfied."
    }
  },
  "findings": [
    ${JSON.stringify(structuredFinding)}
  ],
  "dispositions": [
    {
      "line": "D1",
      "action": "blocks",
      "reason": "Unvalidated candidate SHA"
    }
  ],
  "rechecks": [],
  "judge_changes": [],
  "reason": "Found blocking defect on standards axis."
}
\`\`\`
`;

    const res = extractReport(promptShapedReviewer, candidateSha, "reviewer");
    expect(res.passed).toBe(false);
    expect(res.outcome).toBe("sent-back");
    // Verify structured findings are preserved as objects and not overwritten
    expect(Array.isArray(res.findings)).toBe(true);
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toEqual(structuredFinding);
    expect(res.dispositions).toHaveLength(1);
    expect(res.axes.standards.status).toBe("fail");

    // Contradictory outcome: approved outcome with blocking finding
    const contradictoryReviewer = `
\`\`\`json
{
  "outcome": "approved",
  "sha": "${candidateSha}",
  "delivers": "all",
  "axes": {
    "standards": { "status": "pass", "summary": "clean" },
    "spec": { "status": "pass", "summary": "clean" }
  },
  "findings": [
    ${JSON.stringify(structuredFinding)}
  ],
  "dispositions": []
}
\`\`\`
`;
    const contradictoryRes = extractReport(contradictoryReviewer, candidateSha, "reviewer");
    expect(contradictoryRes.passed).toBe(false);
    expect(
      contradictoryRes.problems.some((p: string) =>
        p.includes("contradictory with 1 blocking finding(s)"),
      ),
    ).toBe(true);
  });

  test("evaluateHostReadiness holds readiness when outstanding findings exist or axes fail", () => {
    const candidateSha = "commit_sha_abc123";
    const openFinding: ReviewFinding = {
      id: "fnd-1",
      axis: "spec",
      classification: "defect",
      blocking: true,
      title: "Broken boundary",
      description: "Needs fix",
      status: "open",
      lapIntroduced: 0,
    };

    // 1. Outstanding open findings hold readiness despite reviewer saying approved
    const heldByOutstanding = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: true, overall: "PASS" },
      reviewerReport: {
        passed: true,
        outcome: "approved",
        sha: candidateSha,
        axes: {
          standards: { status: "pass", summary: "ok" },
          spec: { status: "pass", summary: "ok" },
        },
      },
      ciPassed: true,
      lap: 1,
      maxLaps: 3,
      outstandingFindings: [openFinding],
      expectedCandidate: candidateSha,
    });
    expect(heldByOutstanding.ready).toBe(false);
    expect(heldByOutstanding.verdict).toBe("sent_back");
    expect(heldByOutstanding.reasons.some((r) => r.includes("Unresolved persisted finding"))).toBe(
      true,
    );

    // 2. Reviewer standards axis failed holds readiness
    const heldByFailedAxis = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: true, overall: "PASS" },
      reviewerReport: {
        passed: true,
        outcome: "approved",
        sha: candidateSha,
        axes: {
          standards: { status: "fail", summary: "anti-reinvention check failed" },
          spec: { status: "pass", summary: "ok" },
        },
      },
      ciPassed: true,
      lap: 1,
      maxLaps: 3,
      expectedCandidate: candidateSha,
    });
    expect(heldByFailedAxis.ready).toBe(false);
    expect(heldByFailedAxis.reasons.some((r) => r.includes("standards axis did not pass"))).toBe(
      true,
    );

    // 3. Candidate mismatch holds readiness
    const heldByMismatch = evaluateHostReadiness({
      candidateStable: true,
      ordinaryChecksPassed: true,
      qaReport: { passed: true, overall: "PASS" },
      reviewerReport: {
        passed: true,
        outcome: "approved",
        sha: "old_commit_sha",
      },
      ciPassed: true,
      lap: 1,
      maxLaps: 3,
      expectedCandidate: candidateSha,
    });
    expect(heldByMismatch.ready).toBe(false);
    expect(
      heldByMismatch.reasons.some((r) => r.includes("does not match expected candidate")),
    ).toBe(true);
  });

  test("extractRequiredAcIds extracts acceptance criteria from issue contract text", () => {
    const issueWithContract = {
      number: 101,
      title: "Implement contract",
      body: "## Description\nImplement protocol.\n\n## Acceptance Criteria\n- [ ] AC1: Strict validation\n- [x] AC-2: No bypasses",
      comments: ["Contract\n* C1: Bound candidate\n* AC3: Preserve structured findings"],
      url: "https://github.com/example/repo/issues/101",
      dependencies: [],
      activeClaim: false,
    };

    const ids = extractRequiredAcIds(issueWithContract);
    expect(ids).toContain("AC1");
    expect(ids).toContain("AC-2");
    expect(ids).toContain("C1");
    expect(ids).toContain("AC3");

    // Empty text returns empty array
    const emptyIssue = {
      number: 102,
      title: "No ACs",
      body: "Plain issue",
      comments: [],
      url: "https://github.com/example/repo/issues/102",
      dependencies: [],
      activeClaim: false,
    };
    expect(extractRequiredAcIds(emptyIssue)).toEqual([]);
  });

  test("buildProviderArgv materializes skill content and system prompts without unsupported flags", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-provider-test-"));
    const skillDir = join(tempDir, "my-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Skill Content\nExecute step-by-step.");

    // 1. Claude: materializes skills into --append-system-prompt, never uses unsupported --skills
    const claudeArgv = buildProviderArgv("claude", {
      prompt: "Execute task",
      skills: [skillDir],
      effort: "high",
    });
    expect(claudeArgv).toContain("claude");
    expect(claudeArgv).toContain("--append-system-prompt");
    expect(claudeArgv.some((a) => a.includes("# Skill Content"))).toBe(true);
    expect(claudeArgv.includes("--skills")).toBe(false);
    expect(claudeArgv).toContain("--effort");
    expect(claudeArgv).toContain("high");

    // 2. OMP: materializes skills into --append-system-prompt with --no-skills
    const ompArgv = buildProviderArgv("omp", {
      prompt: "Execute task",
      skills: [skillDir],
      effort: "medium",
    });
    expect(ompArgv).toContain("omp");
    expect(ompArgv).toContain("--no-skills");
    expect(ompArgv).toContain("--append-system-prompt");
    expect(ompArgv.some((a) => a.includes("# Skill Content"))).toBe(true);

    // 3. Codex: prepends materialized prompt content into main prompt
    const codexArgv = buildProviderArgv("codex", {
      prompt: "Build feature",
      skills: [skillDir],
      effort: "high",
    });
    expect(codexArgv).toContain("codex");
    const codexPrompt = codexArgv[codexArgv.length - 1];
    expect(codexPrompt).toContain("# Skill Content");
    expect(codexPrompt).toContain("Build feature");

    // 4. Materialize helper returns null for non-existent path
    expect(materializeSkillContent(join(tempDir, "non_existent"))).toBeNull();

    await rm(tempDir, { recursive: true, force: true });
  });

  test("BUNDLED_PROMPTS embeds canonical prompt templates at compile time without drift", () => {
    const expectedPrompts = [
      "assess-merge-queue",
      "discoveries",
      "holdout-verifier",
      "holdout-writer",
      "investigate",
      "loop-check-app",
      "loop-pick",
      "loop-reflect",
      "loop-review",
      "loop-work",
      "manage",
      "plan",
      "simplify",
      "slice-backlog",
    ];

    expect(Object.keys(BUNDLED_PROMPTS).sort()).toEqual(expectedPrompts.sort());

    for (const name of expectedPrompts) {
      const bundled = BUNDLED_PROMPTS[name];
      expect(typeof bundled).toBe("string");
      expect(bundled.length).toBeGreaterThan(50);
      expect(bundled.trim().length).toBeGreaterThan(50);

      // Verify loadPrompt matches bundled prompt
      const loaded = loadPrompt(name);
      expect(loaded).toBe(bundled);
    }
  });
});
