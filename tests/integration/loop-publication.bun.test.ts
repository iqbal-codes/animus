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
  type GhRunner,
} from "../../scripts/loop/pr-publication";
import { LoopPublisher } from "../../scripts/loop/publisher";
import { runAnimusLoop } from "../../scripts/animus-loop";
import type { LocalIssue, AgentTransport, LocalLoopResult } from "../../scripts/animus-loop";
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

  test("LoopPublisher suppresses forge mutations when push is false and exercises observable publication behavior", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-behavior-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let callCount = 0;
    const mockRunner: GhRunner = async (args) => {
      callCount++;
      if (args[1] === "pr" && args[2] === "view") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ state: "OPEN" }),
          stderr: "",
        };
      }
      if (args[1] === "pr" && args[2] === "comment") {
        return {
          exitCode: 0,
          stdout: "https://github.com/owner/repo/pull/144#issuecomment-123\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // When push is false, forge mutations are suppressed without calling runner
    const pushFalsePublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: false,
      runner: mockRunner,
    });

    const prRes = await pushFalsePublisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "summary",
      candidate: "cand-sha-test",
    });
    expect(prRes.created).toBe(false);
    expect(callCount).toBe(0);

    const escRes = await pushFalsePublisher.escalateToHuman("cand-sha-test");
    expect(escRes.ok).toBe(true);
    expect(escRes.escalated).toBe(false);
    expect(callCount).toBe(0);

    const comRes = await pushFalsePublisher.publishComment({
      target: { kind: "pr", idOrUrl: "144" },
      commentType: "builder",
      commentBody: "hello test",
      candidate: "cand-sha-test",
    });
    expect(comRes.ok).toBe(true);
    expect(callCount).toBe(0);

    const revRes = await pushFalsePublisher.publishReview({
      pr: "https://github.com/owner/repo/pull/144",
      candidate: "cand-sha-test",
      reviewBody: "review body",
    });
    expect(revRes.ok).toBe(true);
    expect(callCount).toBe(0);

    const evRes = await pushFalsePublisher.updatePrEvidence({
      pr: "https://github.com/owner/repo/pull/144",
      candidate: "cand-sha-test",
      newEvidenceContent: "evidence",
    });
    expect(evRes.ok).toBe(true);
    expect(callCount).toBe(0);

    // When push is true, observable behavior exercises injected runner and audits publication
    const activePublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    const isOpen = await activePublisher.isPrOpen("144");
    expect(isOpen).toBe(true);
    expect(callCount).toBe(1);

    const commentRes = await activePublisher.publishComment({
      target: { kind: "pr", idOrUrl: "144" },
      commentType: "builder",
      commentBody: "hello test",
      candidate: "cand-sha-test",
    });
    expect(commentRes.ok).toBe(true);
    expect(commentRes.commentUrl).toBe("https://github.com/owner/repo/pull/144#issuecomment-123");

    const records = activePublisher.getPublicationRecords();
    expect(records.some((r) => r.action === "comment" && r.candidate === "cand-sha-test")).toBe(
      true,
    );

    // Error handling on failing runner
    const failingRunner: GhRunner = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "simulated transport error",
    });
    const failingPublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: failingRunner,
    });

    const failRes = await failingPublisher.escalateToHuman("cand-sha-err");
    expect(failRes.ok).toBe(false);
    expect(failRes.escalated).toBe(false);
    const errorsFile = join(artifactsDir, "publication-errors.json");
    expect(existsSync(errorsFile)).toBe(true);
    const errors = JSON.parse(await readFile(errorsFile, "utf-8"));
    expect(errors.some((e: any) => e.candidate === "cand-sha-err")).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher.createPullRequest creates PR, deduplicates across candidate changes, and deduplicates across restarts", async () => {
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
      candidate: "cand-sha-144-lap1",
    });

    expect(res1.created).toBe(true);
    expect(res1.prUrl).toBe("https://github.com/owner/repo/pull/144");

    const records = JSON.parse(
      await readFile(join(artifactsDir, "publication-records.json"), "utf-8"),
    );
    expect(records.length).toBe(1);
    expect(records[0].action).toBe("pr_create");
    expect(records[0].target).toBe("https://github.com/owner/repo/pull/144");
    expect(records[0].branch).toBe("local-loop/issue-144");
    expect(records[0].issueNumber).toBe(144);
    expect(records[0].candidate).toBe("cand-sha-144-lap1");
    expect(records[0].success).toBe(true);

    const initialSpawns = spawnCount;

    // 2. PR creation on next lap with UPDATED candidate SHA on same branch is deduplicated
    const res2 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "## Summary\nUpdated candidate on lap 2",
      base: "main",
      candidate: "cand-sha-144-lap2",
    });

    expect(res2.created).toBe(false);
    expect(res2.deduplicated).toBe(true);
    expect(res2.prUrl).toBe("https://github.com/owner/repo/pull/144");
    expect(spawnCount).toBe(initialSpawns); // No extra gh subprocess spawned despite candidate change

    // 3. Deduplication persists across process restart / fresh LoopPublisher instantiation
    const restartedPublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    const resRestart = await restartedPublisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "## Summary\nAfter restart on lap 3",
      base: "main",
      candidate: "cand-sha-144-lap3",
    });

    expect(resRestart.created).toBe(false);
    expect(resRestart.deduplicated).toBe(true);
    expect(resRestart.prUrl).toBe("https://github.com/owner/repo/pull/144");
    expect(spawnCount).toBe(initialSpawns); // Zero extra gh calls across restarts

    // 4. Does NOT reuse PR from a DIFFERENT branch for the same issue
    const resDifferentBranch = await publisher.createPullRequest({
      branch: "local-loop/issue-144-branch-b",
      title: "fix(issue-144): stateful loop publisher on branch b",
      body: "## Summary\nDifferent branch",
      base: "main",
      candidate: "cand-sha-144-branch-b",
    });
    // Must invoke runner for the new branch rather than reusing branch-a PR
    expect(spawnCount).toBeGreaterThan(initialSpawns);
    expect(resDifferentBranch.created).toBe(true);

    // 5. Does NOT reuse a CLOSED PR returned by gh pr view
    let closedViewCalls = 0;
    const closedPrRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        closedViewCalls++;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: "https://github.com/owner/repo/pull/100-closed",
            state: "CLOSED",
          }),
          stderr: "",
        };
      }
      if (args[1] === "pr" && args[2] === "create") {
        return {
          exitCode: 0,
          stdout: "https://github.com/owner/repo/pull/101-new\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const closedTestDir = await mkdtemp(join(tmpdir(), "animus-pub-pr-closed-"));
    const closedPub = new LoopPublisher({
      worktree: closedTestDir,
      runDirectory: closedTestDir,
      artifactsDir: join(closedTestDir, "artifacts"),
      issueNumber: 144,
      push: true,
      runner: closedPrRunner,
    });

    const resClosed = await closedPub.createPullRequest({
      branch: "local-loop/issue-144-closed-test",
      title: "fix(issue-144): fresh pr",
      body: "body",
      candidate: "cand-sha-closed-test",
    });
    expect(closedViewCalls).toBe(1);
    expect(resClosed.created).toBe(true);
    expect(resClosed.prUrl).toBe("https://github.com/owner/repo/pull/101-new"); // Created fresh PR, did not reuse closed PR

    await rm(closedTestDir, { recursive: true, force: true });
    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher.createPullRequest handles transport failure and retries successfully", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-pr-retry-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    let shouldFail = true;
    const retryRunner: GhRunner = async (args) => {
      if (args[1] === "pr" && args[2] === "view") {
        return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
      }
      if (args[1] === "pr" && args[2] === "create") {
        if (shouldFail) {
          return { exitCode: 1, stdout: "", stderr: "network error connecting to github" };
        }
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
      runner: retryRunner,
    });

    // 1. First attempt fails due to transport failure
    const res1 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "body",
      candidate: "cand-sha-fail",
    });
    expect(res1.created).toBe(false);

    // Publication records must not have success: true
    const records = publisher.getPublicationRecords();
    expect(records.filter((r) => r.action === "pr_create" && r.success === true).length).toBe(0);

    // Publication errors must record the failure
    const errors = JSON.parse(
      await readFile(join(artifactsDir, "publication-errors.json"), "utf-8"),
    );
    expect(errors.length).toBe(1);
    expect(errors[0].error).toContain("network error");

    // 2. Retry with recovered transport succeeds
    shouldFail = false;
    const res2 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "body",
      candidate: "cand-sha-fail",
    });
    expect(res2.created).toBe(true);
    expect(res2.prUrl).toBe("https://github.com/owner/repo/pull/144");

    const updatedRecords = publisher.getPublicationRecords();
    expect(updatedRecords.some((r) => r.action === "pr_create" && r.success === true)).toBe(true);

    // 3. Subsequent calls on updated candidate now deduplicate
    const res3 = await publisher.createPullRequest({
      branch: "local-loop/issue-144",
      title: "fix(issue-144): stateful loop publisher",
      body: "body",
      candidate: "cand-sha-lap2",
    });
    expect(res3.created).toBe(false);
    expect(res3.deduplicated).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("LoopPublisher.publishBuilderDelivery fails closed on git push failure and succeeds with local bare origin", async () => {
    function runGit(cwd: string, ...args: string[]): string {
      const proc = Bun.spawnSync(args, { cwd, stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new Error(`Git command failed: ${args.join(" ")}\n${proc.stderr.toString()}`);
      }
      return proc.stdout.toString().trim();
    }

    const tempDir = await mkdtemp(join(tmpdir(), "animus-pub-delivery-"));
    const artifactsDir = join(tempDir, "artifacts");
    const handoffDir = join(tempDir, "handoff");
    await mkdir(artifactsDir, { recursive: true });
    await mkdir(handoffDir, { recursive: true });

    runGit(tempDir, "git", "init", "-b", "main");
    runGit(tempDir, "git", "config", "user.name", "Test");
    runGit(tempDir, "git", "config", "user.email", "test@test.com");
    runGit(tempDir, "git", "config", "commit.gpgsign", "false");
    await Bun.write(join(tempDir, "file.txt"), "hello");
    runGit(tempDir, "git", "add", "file.txt");
    runGit(tempDir, "git", "commit", "-m", "init");
    const candidateSha = runGit(tempDir, "git", "rev-parse", "HEAD");

    const issue: LocalIssue = {
      number: 144,
      url: "https://github.com/owner/repo/issues/144",
      title: "test push failure",
      body: "body",
      comments: [],
      dependencies: [],
      activeClaim: false,
    };

    let ghCalled = false;
    const mockRunner: GhRunner = async (args) => {
      ghCalled = true;
      if (args[1] === "pr" && args[2] === "view") {
        return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
      }
      return { exitCode: 0, stdout: "https://github.com/owner/repo/pull/144\n", stderr: "" };
    };

    const publisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });

    const state: LocalLoopResult = {
      runId: "run-pub-delivery-test",
      issue: issue.url,
      route: "simple",
      branch: "main",
      base: "main",
      status: "building",
      candidate: candidateSha,
      runDirectory: tempDir,
      worktree: tempDir,
      identities: {
        targetBaseTip: candidateSha,
        mergeBase: candidateSha,
        prHead: candidateSha,
        testedHead: candidateSha,
      },
      evidence: [],
    };

    // 1. Without remote origin, git push fails and must FAIL CLOSED
    await publisher.publishBuilderDelivery({
      branch: "feature-test",
      issue,
      state,
      builderReport: { candidate: candidateSha, verdict: "pass", checks: [] },
      route: "simple",
      lap: 1,
      handoffDir,
    });

    // Must NOT set state.pr
    expect(state.pr).toBeUndefined();
    // Must NOT call gh runner to create PR
    expect(ghCalled).toBe(false);
    // Must record push failure in publication-errors.json
    const errFile = join(artifactsDir, "publication-errors.json");
    expect(existsSync(errFile)).toBe(true);
    const errs = JSON.parse(await readFile(errFile, "utf-8"));
    expect(errs.some((e: any) => e.action === "git_push")).toBe(true);
    // Must NOT record successful publication in publication-records.json
    const recs = publisher.getPublicationRecords();
    expect(recs.some((r) => r.action === "pr_create" && r.success === true)).toBe(false);

    // Rejected push must prevent ALL subsequent loop PR/comment/evidence mutations across all stages
    expect(publisher.isPushRejected()).toBe(true);

    await publisher.publishLoopComment({
      commentType: "qa_check",
      commentBody: "QA check failure comment",
      candidate: candidateSha,
    });
    expect(ghCalled).toBe(false);

    const escAfterPushFail = await publisher.escalateToHuman(candidateSha);
    expect(escAfterPushFail.escalated).toBe(false);
    expect(ghCalled).toBe(false);

    await publisher.syncAndPublishPrEvidence({
      pr: "https://github.com/owner/repo/pull/144",
      candidate: candidateSha,
    });
    expect(ghCalled).toBe(false);

    const comAfterPushFail = await publisher.publishComment({
      target: { kind: "issue", idOrUrl: 144 },
      commentType: "review",
      commentBody: "Review comment body",
      candidate: candidateSha,
    });
    expect(comAfterPushFail.ok).toBe(true);
    expect(ghCalled).toBe(false);

    const revAfterPushFail = await publisher.publishReview({
      pr: "https://github.com/owner/repo/pull/144",
      candidate: candidateSha,
      reviewBody: "Review body",
    });
    expect(revAfterPushFail.ok).toBe(true);
    expect(ghCalled).toBe(false);

    const prAfterPushFail = await publisher.createPullRequest({
      branch: "main",
      title: "Title",
      body: "Body",
      candidate: candidateSha,
    });
    expect(prAfterPushFail.created).toBe(false);
    expect(ghCalled).toBe(false);

    // Fallback LoopPublisher instance with same artifactsDir also rejects mutations
    const fallbackPublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockRunner,
    });
    expect(fallbackPublisher.isPushRejected()).toBe(true);
    const fallbackEsc = await fallbackPublisher.escalateToHuman(candidateSha);
    expect(fallbackEsc.escalated).toBe(false);
    expect(ghCalled).toBe(false);

    // 2. Set up local bare origin and verify successful push & publication
    const bareOrigin = await mkdtemp(join(tmpdir(), "animus-pub-bare-delivery-"));
    runGit(bareOrigin, "git", "init", "--bare", "-b", "main");
    runGit(tempDir, "git", "remote", "add", "origin", bareOrigin);

    // New publisher on remote-configured repo with separate artifacts
    const successArtifactsDir = join(tempDir, "artifacts-success");
    await mkdir(successArtifactsDir, { recursive: true });
    let ghSuccessCalled = false;
    const mockSuccessRunner: GhRunner = async (args) => {
      ghSuccessCalled = true;
      if (args[1] === "pr" && args[2] === "view") {
        return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
      }
      return { exitCode: 0, stdout: "https://github.com/owner/repo/pull/144\n", stderr: "" };
    };
    const successPublisher = new LoopPublisher({
      worktree: tempDir,
      runDirectory: tempDir,
      artifactsDir: successArtifactsDir,
      issueNumber: 144,
      push: true,
      runner: mockSuccessRunner,
    });

    await successPublisher.publishBuilderDelivery({
      branch: "main",
      issue,
      state,
      builderReport: { candidate: candidateSha, verdict: "pass", checks: [] },
      route: "simple",
      lap: 1,
      handoffDir,
    });

    // Pushed commit is present in bare origin
    const pushedCommit = runGit(bareOrigin, "git", "rev-parse", "refs/heads/main");
    expect(pushedCommit).toBe(candidateSha);
    // PR was created and state.pr was set
    expect(state.pr).toBe("https://github.com/owner/repo/pull/144");
    expect(ghSuccessCalled).toBe(true);

    await rm(tempDir, { recursive: true, force: true });
    await rm(bareOrigin, { recursive: true, force: true });
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

    // 3. escalateToHuman with a new candidate invokes runner and records
    const res3 = await publisher.escalateToHuman("cand-sha-esc-2");
    expect(res3.ok).toBe(true);
    expect(res3.escalated).toBe(true);
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
    const bareOrigin = await mkdtemp(join(tmpdir(), "animus-pub-bare-e2e-"));

    function runGit(cwd: string, ...args: string[]): string {
      const proc = Bun.spawnSync(args, { cwd, stderr: "pipe" });
      if (proc.exitCode !== 0) {
        throw new Error(`Git command failed: ${args.join(" ")}\n${proc.stderr.toString()}`);
      }
      return proc.stdout.toString().trim();
    }

    try {
      runGit(bareOrigin, "git", "init", "--bare", "-b", "main");

      runGit(root, "git", "init", "-b", "main");
      runGit(root, "git", "config", "user.name", "Animus Test");
      runGit(root, "git", "config", "user.email", "animus@example.com");
      runGit(root, "git", "config", "commit.gpgsign", "false");
      runGit(root, "git", "remote", "add", "origin", bareOrigin);

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
      runGit(root, "git", "push", "-u", "origin", "main");

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
        // PR view - validates remote synchrony by inspecting bare origin
        if (args[1] === "pr" && args[2] === "view") {
          if (!prBodyContent) {
            return { exitCode: 1, stdout: "", stderr: "no pull requests found" };
          }
          let bareHead = currentBuilderCandidate;
          try {
            const branchesOut = runGit(bareOrigin, "git", "branch");
            const pushedBranch = branchesOut
              .split("\n")
              .map((b) => b.replace("*", "").trim())
              .find((b) => b.includes(`issue-${issue.number}`));
            if (pushedBranch) {
              bareHead = runGit(bareOrigin, "git", "rev-parse", `refs/heads/${pushedBranch}`);
            }
          } catch {}
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              body: prBodyContent,
              headRefOid: bareHead,
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

      // Verify that candidate commit was actually pushed to local bare origin (remote synchrony verified)
      const pushedBranchSha = runGit(bareOrigin, "git", "rev-parse", `refs/heads/${result.branch}`);
      expect(pushedBranchSha).toBe(currentBuilderCandidate);
      expect(result.candidate).toBe(currentBuilderCandidate);

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
      await rm(bareOrigin, { recursive: true, force: true }).catch(() => {});
    }
  });
});
