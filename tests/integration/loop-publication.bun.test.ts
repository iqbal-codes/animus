import { describe, expect, test } from "bun:test";
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
  publishComment,
  publishPrEvidenceUpdate,
  syncExistingEvidenceBindings,
  type GhRunner,
} from "../../scripts/loop/pr-publication";
import type { CaptureRecord, HostBoundIdentities } from "../../scripts/loop/report-schema";

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
});
