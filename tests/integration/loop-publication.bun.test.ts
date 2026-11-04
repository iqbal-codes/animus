import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AmbiguousEvidenceBoundaryError,
  EVIDENCE_SECTION_END,
  EVIDENCE_SECTION_START,
  renderEvidenceContent,
} from "../../scripts/loop/pr-reporting";
import {
  extractValidDiffLines,
  publishComment,
  publishPrEvidenceUpdate,
  publishPrReview,
  syncExistingEvidenceBindings,
  escalateIssueToHuman,
  type GhRunner,
} from "../../scripts/loop/pr-publication";
import { LoopPublisher } from "../../scripts/loop/publisher";
import { runAnimusLoop } from "../../scripts/animus-loop";
import type { LocalIssue, AgentTransport } from "../../scripts/animus-loop";
import type {
  CaptureRecord,
  HostBoundIdentities,
  ReviewFinding,
} from "../../scripts/loop/report-schema";

describe("PR and Issue Publication Pipeline with Injected GhRunner", () => {
  const dummyIdentities: HostBoundIdentities = {
    targetBaseTip: "base1111",
    mergeBase: "mbase2222",
    prHead: "head3333",
    testedHead: "test4444",
  };

  test("publishPrEvidenceUpdate rejects stale candidate head and logs error record", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-stale-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "head3333";
    const remoteStaleHead = "remote_different_4444";

    const mockRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            body: `## Evidence\n${EVIDENCE_SECTION_START}\nold\n${EVIDENCE_SECTION_END}`,
            headRefOid: remoteStaleHead,
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const newEvidence = renderEvidenceContent({ identities: dummyIdentities });

    let threw = false;
    try {
      await publishPrEvidenceUpdate({
        repoRoot: tempDir,
        pr: "https://github.com/owner/repo/pull/1",
        candidate,
        newEvidenceContent: newEvidence,
        runDirectory: tempDir,
        runner: mockRunner,
      });
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("Refusing PR evidence publication: PR head has changed");
    }
    expect(threw).toBe(true);

    // Verify error was persisted in publication-errors.json
    const errContent = await readFile(join(artifactsDir, "publication-errors.json"), "utf-8");
    expect(errContent).toContain("Refusing PR evidence publication");
    expect(errContent).toContain(remoteStaleHead);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishPrEvidenceUpdate rejects missing boundaries with AmbiguousEvidenceBoundaryError", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-nobound-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "head3333";
    const mockRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            body: "## Evidence\nUnmanaged evidence text",
            headRefOid: candidate,
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const newEvidence = renderEvidenceContent({ identities: dummyIdentities });

    let threwAmbig = false;
    try {
      await publishPrEvidenceUpdate({
        repoRoot: tempDir,
        pr: "https://github.com/owner/repo/pull/1",
        candidate,
        newEvidenceContent: newEvidence,
        runDirectory: tempDir,
        runner: mockRunner,
      });
    } catch (err: any) {
      threwAmbig = err instanceof AmbiguousEvidenceBoundaryError;
      expect(err.migrationPreview).toContain(EVIDENCE_SECTION_START);
      expect(err.migrationPreview).toContain(EVIDENCE_SECTION_END);
    }
    expect(threwAmbig).toBe(true);

    // Verify error was persisted in publication-errors.json
    const errContent = await readFile(join(artifactsDir, "publication-errors.json"), "utf-8");
    expect(errContent).toContain("Missing or ambiguous evidence boundaries");
    expect(errContent).toContain("migrationPreview");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishPrEvidenceUpdate detects concurrency and aborts before write", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-concur-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "head3333";
    let viewCallCount = 0;
    let editCalled = false;

    const initialBody = `## Problem\nDesc\n\n## Evidence\n${EVIDENCE_SECTION_START}\ninitial\n${EVIDENCE_SECTION_END}`;

    const mockRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        viewCallCount++;
        if (viewCallCount === 1) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ body: initialBody, headRefOid: candidate }),
            stderr: "",
          };
        }
        // Second call: concurrent modification!
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            body: `${initialBody}\n\nHuman edit made in web UI!`,
            headRefOid: candidate,
          }),
          stderr: "",
        };
      }
      if (args[1] === "pr" && args[2] === "edit") {
        editCalled = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const newEvidence = renderEvidenceContent({ identities: dummyIdentities });

    let threwConcur = false;
    try {
      await publishPrEvidenceUpdate({
        repoRoot: tempDir,
        pr: "https://github.com/owner/repo/pull/1",
        candidate,
        newEvidenceContent: newEvidence,
        runDirectory: tempDir,
        runner: mockRunner,
      });
    } catch (err: any) {
      threwConcur = true;
      expect(err.message).toContain("Concurrent modification detected on PR");
    }
    expect(threwConcur).toBe(true);

    // Edit must NEVER have been called!
    expect(editCalled).toBe(false);

    // Error persisted
    const errLog = await readFile(join(artifactsDir, "publication-errors.json"), "utf-8");
    expect(errLog).toContain("Concurrent modification detected");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishPrEvidenceUpdate handles gh pr edit failure with local persistence", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-fail-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "head3333";
    const initialBody = `## Evidence\n${EVIDENCE_SECTION_START}\ninitial\n${EVIDENCE_SECTION_END}`;

    const mockRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ body: initialBody, headRefOid: candidate }),
          stderr: "",
        };
      }
      if (args[1] === "pr" && args[2] === "edit") {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "HTTP 500: GitHub API internal server error",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const newEvidence = renderEvidenceContent({ identities: dummyIdentities });

    let threwEditFail = false;
    try {
      await publishPrEvidenceUpdate({
        repoRoot: tempDir,
        pr: "https://github.com/owner/repo/pull/1",
        candidate,
        newEvidenceContent: newEvidence,
        runDirectory: tempDir,
        runner: mockRunner,
      });
    } catch (err: any) {
      threwEditFail = true;
      expect(err.message).toContain("gh pr edit failed on");
      expect(err.message).toContain("HTTP 500");
    }
    expect(threwEditFail).toBe(true);

    const errLog = await readFile(join(artifactsDir, "publication-errors.json"), "utf-8");
    expect(errLog).toContain("HTTP 500: GitHub API internal server error");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publication refuses unverifiable head, concurrency and readback", async () => {
    for (const failure of [
      "missing-head",
      "concurrency-error",
      "concurrency-json",
      "readback-json",
      "readback-old-body",
    ]) {
      const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-verify-"));
      let views = 0;
      let edits = 0;
      const initialBody = `## Evidence\n${EVIDENCE_SECTION_START}\nold\n${EVIDENCE_SECTION_END}`;
      const runner: GhRunner = async (args) => {
        if (args[2] === "edit") {
          edits++;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        views++;
        if (views === 1 && failure === "missing-head")
          return { exitCode: 0, stdout: JSON.stringify({ body: initialBody }), stderr: "" };
        if (views === 2 && failure === "concurrency-error")
          return { exitCode: 1, stdout: "", stderr: "unavailable" };
        if (
          (views === 2 && failure === "concurrency-json") ||
          (views === 3 && failure === "readback-json")
        )
          return { exitCode: 0, stdout: "not json", stderr: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({ body: initialBody, headRefOid: "head3333" }),
          stderr: "",
        };
      };
      try {
        let rejected = false;
        try {
          await publishPrEvidenceUpdate({
            repoRoot: tempDir,
            pr: "1",
            candidate: "head3333",
            newEvidenceContent: renderEvidenceContent({ identities: dummyIdentities }),
            runDirectory: tempDir,
            runner,
          });
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        if (failure.startsWith("concurrency") || failure === "missing-head") expect(edits).toBe(0);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  });

  test("publishPrEvidenceUpdate succeeds, verifies readback, and records publication", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-success-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "head3333";
    const initialBody = `## Problem\nSolves issue\n\n## Evidence\n${EVIDENCE_SECTION_START}\ninitial\n${EVIDENCE_SECTION_END}\n\n### Footer\nPreserve`;

    let publishedBody = "";

    const mockRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            body: publishedBody || initialBody,
            headRefOid: candidate,
          }),
          stderr: "",
        };
      }
      if (args[1] === "pr" && args[2] === "edit") {
        const bodyIndex = args.indexOf("--body");
        publishedBody = args[bodyIndex + 1];
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const newEvidence = renderEvidenceContent({
      identities: dummyIdentities,
      outstanding: [],
    });

    const result = await publishPrEvidenceUpdate({
      repoRoot: tempDir,
      pr: "https://github.com/owner/repo/pull/1",
      candidate,
      newEvidenceContent: newEvidence,
      runDirectory: tempDir,
      runner: mockRunner,
    });

    expect(result.ok).toBe(true);
    expect(result.readbackVerified).toBe(true);
    expect(publishedBody).toContain(EVIDENCE_SECTION_START);
    expect(publishedBody).toContain(EVIDENCE_SECTION_END);
    expect(publishedBody).toContain("## Problem\nSolves issue");
    expect(publishedBody).toContain("### Footer\nPreserve");
    expect(publishedBody).toContain("**Outstanding:** None.");

    // Verify audit files
    const publishJson = JSON.parse(
      await readFile(join(artifactsDir, "evidence-publish.json"), "utf-8"),
    );
    expect(publishJson.candidate).toBe(candidate);
    expect(publishJson.readbackVerified).toBe(true);

    const records = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(records.length).toBe(1);
    expect(records[0].action).toBe("pr_evidence_update");
    expect(records[0].success).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishComment posts PR and issue comments with deduplication", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-comment-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let spawnCount = 0;
    const mockRunner: GhRunner = async () => {
      spawnCount++;
      return {
        exitCode: 0,
        stdout: "https://github.com/owner/repo/pull/1#issuecomment-9999",
        stderr: "",
      };
    };

    // 1. Initial publication
    const res1 = await publishComment({
      repoRoot: tempDir,
      target: { kind: "pr", idOrUrl: "https://github.com/owner/repo/pull/1" },
      commentType: "builder",
      commentBody: "### Builder Update",
      candidate: "head3333",
      runDirectory: tempDir,
      runner: mockRunner,
    });
    expect(res1.ok).toBe(true);
    expect(res1.commentUrl).toBe("https://github.com/owner/repo/pull/1#issuecomment-9999");
    expect(spawnCount).toBe(1);

    // 2. Duplicate retry with same candidate and commentType
    const res2 = await publishComment({
      repoRoot: tempDir,
      target: { kind: "pr", idOrUrl: "https://github.com/owner/repo/pull/1" },
      commentType: "builder",
      commentBody: "### Builder Update",
      candidate: "head3333",
      runDirectory: tempDir,
      runner: mockRunner,
    });
    expect(res2.ok).toBe(true);
    expect(res2.message).toContain("already published");
    // spawnCount must remain 1: runner was NOT called again!
    expect(spawnCount).toBe(1);

    // 3. Issue comment (no-PR path)
    const res3 = await publishComment({
      repoRoot: tempDir,
      target: { kind: "issue", idOrUrl: 42 },
      commentType: "escalation",
      commentBody: "### Issue Handoff",
      candidate: "head3333",
      runDirectory: tempDir,
      runner: mockRunner,
    });
    expect(res3.ok).toBe(true);
    expect(spawnCount).toBe(2);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("syncExistingEvidenceBindings preserves manual bindings across same-candidate re-renders", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-sync-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const candidate = "cand_sync_1";

    // Write evidence-mapping.json
    await writeFile(
      join(artifactsDir, "evidence-mapping.json"),
      JSON.stringify({
        candidate,
        mappings: {
          "cap-ui-1": {
            beforeUrl: "https://github.com/user-attachments/assets/before.png",
            afterUrl: "https://github.com/user-attachments/assets/after.png",
          },
        },
      }),
    );

    const captures: CaptureRecord[] = [
      {
        id: "cap-ui-1",
        scenario: "Nav bar",
        route: "/nav",
        candidateIdentity: candidate,
        applicability: "applicable",
        beforeStatus: "captured",
        afterStatus: "captured",
        hostedUrlStatus: "unbound",
      },
    ];

    const synced = syncExistingEvidenceBindings(captures, artifactsDir, candidate);
    expect(synced[0].beforeHostedUrl).toBe("https://github.com/user-attachments/assets/before.png");
    expect(synced[0].afterHostedUrl).toBe("https://github.com/user-attachments/assets/after.png");
    expect(synced[0].hostedUrlStatus).toBe("supplied_unverified");

    // Rendering with synced captures includes hosted images
    const rendered = renderEvidenceContent({
      identities: {
        targetBaseTip: "base",
        mergeBase: "base",
        prHead: candidate,
        testedHead: candidate,
      },
      captures: synced,
    });
    expect(rendered).toContain("https://github.com/user-attachments/assets/after.png");
    expect(rendered).toContain("supplied_unverified");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("extractValidDiffLines parses diff headers and hunk lines into correct right-side line numbers", () => {
    const rawDiff = [
      "diff --git a/src/index.ts b/src/index.ts",
      "--- a/src/index.ts",
      "+++ b/src/index.ts",
      "@@ -10,3 +20,4 @@",
      " context 20",
      "-removed line",
      "+added 21",
      "+added 22",
      " context 23",
      "diff --git a/src/other.ts b/src/other.ts",
      "--- /dev/null",
      "+++ b/src/other.ts",
      "@@ -0,0 +1,2 @@",
      "+first line",
      "+second line",
    ].join("\n");

    const validLines = extractValidDiffLines(rawDiff);
    expect(validLines.has("src/index.ts")).toBe(true);
    const indexLines = validLines.get("src/index.ts")!;
    expect(indexLines.has(20)).toBe(true);
    expect(indexLines.has(21)).toBe(true);
    expect(indexLines.has(22)).toBe(true);
    expect(indexLines.has(23)).toBe(true);
    expect(indexLines.has(10)).toBe(false); // left-side line number, not in right-side set

    expect(validLines.has("src/other.ts")).toBe(true);
    const otherLines = validLines.get("src/other.ts")!;
    expect(otherLines.has(1)).toBe(true);
    expect(otherLines.has(2)).toBe(true);
    expect(otherLines.has(3)).toBe(false);
  });

  test("publishPrReview calls gh api reviews when inline comments match diff lines and falls back cleanly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-review-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const rawDiff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,2 +1,3 @@",
      " export function check() {",
      "+  return false;",
      " }",
    ].join("\n");

    const findings: ReviewFinding[] = [
      {
        id: "F1",
        axis: "standards",
        classification: "defect",
        blocking: true,
        title: "Auth bypass",
        description: "Always returns false",
        location: { file: "src/auth.ts", line: 2 },
        suggestion: "return true;",
        status: "open",
        lapIntroduced: 0,
      },
      {
        id: "F2",
        axis: "standards",
        classification: "defect",
        blocking: false,
        title: "Out of diff finding",
        description: "Line 99 is not in diff",
        location: { file: "src/auth.ts", line: 99 },
        status: "open",
        lapIntroduced: 0,
      },
    ];

    let apiArgs: string[] = [];
    let passedPayload: any = null;

    const mockRunner: GhRunner = async (args) => {
      apiArgs = args;
      if (args[0] === "gh" && args[1] === "api") {
        const inputIdx = args.indexOf("--input");
        if (inputIdx !== -1) {
          passedPayload = JSON.parse(await readFile(args[inputIdx + 1], "utf-8"));
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            html_url: "https://github.com/owner/repo/pull/10#pullrequestreview-1",
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: "https://github.com/owner/repo/pull/10#issuecomment-1",
        stderr: "",
      };
    };

    // 1. Successful PR review API call with inline comment on line 2 (line 99 excluded because not in diff)
    const res = await publishPrReview({
      repoRoot: tempDir,
      pr: "https://github.com/owner/repo/pull/10",
      candidate: "head1234",
      reviewBody: "### Loop review: sent back",
      findings,
      rawDiff,
      runDirectory: tempDir,
      runner: mockRunner,
    });

    expect(res.ok).toBe(true);
    expect(res.inlineCount).toBe(1);
    expect(res.commentUrl).toBe("https://github.com/owner/repo/pull/10#pullrequestreview-1");
    expect(apiArgs[2]).toBe("repos/owner/repo/pulls/10/reviews");
    expect(passedPayload).toBeDefined();
    expect(passedPayload.comments.length).toBe(1);
    expect(passedPayload.comments[0].path).toBe("src/auth.ts");
    expect(passedPayload.comments[0].line).toBe(2);
    expect(passedPayload.comments[0].body).toContain("🚫 BLOCKING [F1] Auth bypass");
    expect(passedPayload.comments[0].body).toContain("```suggestion\nreturn true;\n```");

    // 2. Fallback when PR is not a GitHub URL or has 0 inline comments
    let fallbackCalled = false;
    const fallbackRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "comment") {
        fallbackCalled = true;
      }
      return {
        exitCode: 0,
        stdout: "https://github.com/owner/repo/pull/20#issuecomment-2",
        stderr: "",
      };
    };

    const resFallback = await publishPrReview({
      repoRoot: tempDir,
      pr: "mock-pr-target",
      candidate: "head5678",
      reviewBody: "### Loop review: approved",
      findings: [],
      rawDiff,
      runDirectory: tempDir,
      runner: fallbackRunner,
    });

    expect(resFallback.ok).toBe(true);
    expect(resFallback.inlineCount).toBe(0);
    expect(fallbackCalled).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("publishComment supports qa_check commentType cleanly", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-qacheck-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let commandRun: string[] = [];
    const mockRunner: GhRunner = async (args) => {
      commandRun = args;
      return {
        exitCode: 0,
        stdout: "https://github.com/owner/repo/pull/1#issuecomment-8888",
        stderr: "",
      };
    };

    const res = await publishComment({
      repoRoot: tempDir,
      target: { kind: "pr", idOrUrl: "https://github.com/owner/repo/pull/1" },
      commentType: "qa_check",
      commentBody: "### Loop QA Check: Failed",
      candidate: "head4444",
      runDirectory: tempDir,
      runner: mockRunner,
    });

    expect(res.ok).toBe(true);
    expect(res.commentUrl).toBe("https://github.com/owner/repo/pull/1#issuecomment-8888");
    expect(commandRun[1]).toBe("pr");
    expect(commandRun[2]).toBe("comment");

    const records = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(records.length).toBe(1);
    expect(records[0].commentType).toBe("qa_check");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher initializes once per lap with worktree, runDirectory, artifactsDir, issueNumber, push, and runner", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-init-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const mockRunner: GhRunner = async () => {
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const publisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    expect(publisher.worktree).toBe(tempDir);
    expect(publisher.runDirectory).toBe(tempDir);
    expect(publisher.artifactsDir).toBe(artifactsDir);
    expect(publisher.issueNumber).toBe(144);
    expect(publisher.push).toBe(true);
    expect(publisher.getRunner()).toBe(mockRunner);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher.createPullRequest creates PR, records publication record, and deduplicates repeated calls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-pr-create-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let spawnCount = 0;
    const mockRunner: GhRunner = async (args) => {
      spawnCount++;
      if (args[1] === "pr" && args[2] === "view") {
        return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (args[1] === "pr" && args[2] === "create") {
        return {
          exitCode: 0,
          stdout: "https://github.com/owner/repo/pull/144\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const publisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    // 1. Initial PR creation
    const res1 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "## Summary\nCanonical publisher seam",
      base: "main",
      candidate: "cand-sha-144",
    });

    expect(res1.created).toBe(true);
    expect(res1.prUrl).toBe("https://github.com/owner/repo/pull/144");

    const records = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(records.length).toBe(1);
    expect(records[0].action).toBe("pr_create");
    expect(records[0].target).toBe("https://github.com/owner/repo/pull/144");
    expect(records[0].candidate).toBe("cand-sha-144");
    expect(records[0].success).toBe(true);

    const initialSpawns = spawnCount;

    // 2. Duplicate call for same branch/candidate should be deduplicated
    const res2 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "## Summary\nCanonical publisher seam",
      base: "main",
      candidate: "cand-sha-144",
    });

    expect(res2.created).toBe(false);
    expect(res2.deduplicated).toBe(true);
    expect(res2.prUrl).toBe("https://github.com/owner/repo/pull/144");
    expect(spawnCount).toBe(initialSpawns); // No extra gh subprocess spawned

    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher.escalateToHuman edits issue label, records publication record, and deduplicates repeated calls", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-escalate-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let commandRun: string[] = [];
    let callCount = 0;
    const mockRunner: GhRunner = async (args) => {
      callCount++;
      commandRun = args;
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const publisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    // 1. Initial escalation
    const res1 = await publisher.escalateToHuman("cand-sha-esc-1");
    expect(res1.ok).toBe(true);
    expect(res1.escalated).toBe(true);
    expect(commandRun[1]).toBe("issue");
    expect(commandRun[2]).toBe("edit");
    expect(commandRun[3]).toBe("144");
    expect(commandRun).toContain("ready-for-human");
    expect(commandRun).toContain("ready-for-agent");

    const records = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(records.length).toBe(1);
    expect(records[0].action).toBe("label_escalation");
    expect(records[0].targetKind).toBe("issue");
    expect(records[0].target).toBe("144");
    expect(records[0].commentType).toBe("escalation");
    expect(records[0].candidate).toBe("cand-sha-esc-1");
    expect(records[0].success).toBe(true);

    // 2. Duplicate escalation for same candidate is deduplicated
    const res2 = await publisher.escalateToHuman("cand-sha-esc-1");
    expect(res2.ok).toBe(true);
    expect(res2.escalated).toBe(false);
    expect(res2.deduplicated).toBe(true);
    expect(callCount).toBe(1); // No new subprocess spawned

    // 3. Standalone escalateIssueToHuman also records and deduplicates when passed options
    await escalateIssueToHuman(tempDir, 144, {
      runner: mockRunner,
      candidate: "cand-sha-esc-1",
      artifactsDir,
    });
    expect(callCount).toBe(1); // Still deduplicated!

    // 4. Standalone escalateIssueToHuman with a new candidate invokes runner and records
    await escalateIssueToHuman(tempDir, 144, {
      runner: mockRunner,
      candidate: "cand-sha-esc-2",
      artifactsDir,
    });
    expect(callCount).toBe(2);
    const updatedRecords = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(updatedRecords.length).toBe(2);
    expect(updatedRecords[1].candidate).toBe("cand-sha-esc-2");
    expect(updatedRecords[1].action).toBe("label_escalation");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("runAnimusLoop preserves injected ghRunner end-to-end and executes offline loop publication with push: true", async () => {
    const root = await mkdtemp(join(tmpdir(), "animus-pub-e2e-"));

    function runGit(cwd: string, ...args: string[]): string {
      const proc = Bun.spawnSync(args, { cwd, stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new Error(`Git command failed: ${args.join(" ")}\n${proc.stderr.toString()}`);
      }
      return proc.stdout.toString().trim();
    }

    try {
      runGit(root, "git", "init", "-b", "main");
      runGit(root, "git", "config", "user.name", "Animus Test");
      runGit(root, "git", "config", "user.email", "animus@example.com");
      runGit(root, "git", "config", "commit.gpgsign", "false");

      await Bun.write(
        join(root, "harness/harness.config.json"),
        JSON.stringify({
          static: "echo static-ok",
          unit: "echo unit-ok",
          protected_paths: ".factory/holdout/**,harness/**",
        }),
      );

      await Bun.write(
        join(root, ".animus/config.yaml"),
        `
roles:
  builder:
    model: "medium"
  qa:
    model: "small"
  reviewer:
    model: "large"
`,
      );

      await Bun.write(join(root, "README.md"), "# Test Repo");
      runGit(root, "git", "add", ".");
      runGit(root, "git", "commit", "-m", "Initial commit");

      const issue: LocalIssue = {
        number: 144,
        url: "https://github.com/owner/repo/issues/144",
        title: "stateful loop publisher",
        body: "## Acceptance Criteria\n- [ ] AC1: publisher\n",
        comments: [],
        dependencies: [],
        activeClaim: false,
      };

      const ghCommandsRun: string[][] = [];
      let prBodyContent = "";
      let currentBuilderCandidate = "";

      const mockGhRunner: GhRunner = async (args) => {
        ghCommandsRun.push(args);
        // PR list (setupLoopLifecycle)
        if (args[1] === "pr" && args[2] === "list") {
          return { exitCode: 0, stdout: "[]", stderr: "" };
        }
        // PR view
        if (args[1] === "pr" && args[2] === "view") {
          if (!prBodyContent) {
            return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              body: prBodyContent,
              headRefOid: currentBuilderCandidate || "cand-sha-test",
              state: "OPEN",
            }),
            stderr: "",
          };
        }
        // PR create
        if (args[1] === "pr" && args[2] === "create") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx !== -1) prBodyContent = args[bodyIdx + 1]!;
          return {
            exitCode: 0,
            stdout: "https://github.com/owner/repo/pull/144\n",
            stderr: "",
          };
        }
        // PR edit (evidence update)
        if (args[1] === "pr" && args[2] === "edit") {
          const bodyIdx = args.indexOf("--body");
          if (bodyIdx !== -1) prBodyContent = args[bodyIdx + 1]!;
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        // PR checks (CI gate)
        if (args[1] === "pr" && args[2] === "checks") {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              { bucket: "pass", name: "gate-verify", state: "SUCCESS", workflow: "CI" },
            ]),
            stderr: "",
          };
        }
        // PR review / comment
        if (args[1] === "api" || (args[1] === "pr" && args[2] === "comment")) {
          return {
            exitCode: 0,
            stdout: "https://github.com/owner/repo/pull/144#issuecomment-999\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const transport: AgentTransport = async ({ cwd, role }) => {
        if (role === "builder") {
          await Bun.write(join(cwd, "delivered.txt"), "delivered content");
          runGit(cwd, "git", "add", "delivered.txt");
          runGit(cwd, "git", "commit", "-m", "deliver issue 144");
        }
        const head = runGit(cwd, "git", "rev-parse", "HEAD");
        currentBuilderCandidate = head;
        return {
          exitCode: 0,
          stdout:
            JSON.stringify({ type: "agent_settled", aborted: false }) +
            "\n" +
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      candidate: head,
                      verdict: "pass",
                      passed: true,
                      overall: "PASS",
                      checks: [
                        { criterion: "AC1", result: "pass", evidence: "builder-checks.log" },
                      ],
                      lines: [
                        {
                          id: "AC1",
                          kind: "criterion",
                          verdict: "PASS",
                          evidence: ["builder-checks.log"],
                        },
                      ],
                      findings: [],
                    }),
                  },
                ],
              },
            }),
          stderr: "",
        };
      };

      // Run loop with push: true and injected ghRunner
      const result = await runAnimusLoop(root, issue, {
        transport,
        push: true,
        ghRunner: mockGhRunner,
      });

      expect(result.status).toBe("waiting_approval");
      expect(result.pr).toBe("https://github.com/owner/repo/pull/144");

      // Verify publication records audit log
      const recordsPath = join(result.runDirectory, "artifacts", "publication-records.json");
      expect(existsSync(recordsPath)).toBe(true);
      const records = JSON.parse(await Bun.file(recordsPath).text());

      const prCreateRecord = records.find((r: any) => r.action === "pr_create");
      expect(prCreateRecord).toBeDefined();
      expect(prCreateRecord.target).toBe("https://github.com/owner/repo/pull/144");
      expect(prCreateRecord.success).toBe(true);

      const prEvidenceRecord = records.find((r: any) => r.action === "pr_evidence_update");
      expect(prEvidenceRecord).toBeDefined();
      expect(prEvidenceRecord.success).toBe(true);

      // Verify that mockGhRunner intercepted gh commands rather than calling real network
      expect(ghCommandsRun.length).toBeGreaterThan(0);
      const ranPrCreate = ghCommandsRun.some((cmd) => cmd[1] === "pr" && cmd[2] === "create");
      expect(ranPrCreate).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
