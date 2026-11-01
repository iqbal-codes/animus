import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindEvidenceMapping,
  previewEvidenceCaptures,
  publishBoundEvidence,
  validateHostedAssetUrl,
  resolveRunDirectory,
} from "../../scripts/loop/evidence-manager";
import { runLoopCliCommand } from "../../scripts/cli/commands/loop";
import { getProjectSlug } from "../../packages/contracts/src/paths";

describe("Loop Evidence Operator Workflow", () => {
  test("resolveRunDirectory finds URL issues on arbitrary branches in custom state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "animus-run-resolve-"));
    const previous = process.env.ANIMUS_HOME;
    try {
      process.env.ANIMUS_HOME = join(root, "state");
      const run = join(process.env.ANIMUS_HOME, "projects", getProjectSlug(root), "runs", "run-91");
      await mkdir(run, { recursive: true });
      await writeFile(
        join(run, "state.json"),
        JSON.stringify({
          issue: "https://github.com/example/repo/issues/91",
          branch: "fix/customer-issue",
          runId: "run-91",
        }),
      );
      expect(await resolveRunDirectory(root, { issue: 91 })).toBe(run);
      expect(await resolveRunDirectory(root, { runId: "run-91" })).toBe(run);
      const latest = join(run, "..", "aaa-newest");
      await mkdir(latest);
      await writeFile(
        join(latest, "state.json"),
        JSON.stringify({
          issue: "https://github.com/example/repo/issues/91",
          branch: "other-branch",
        }),
      );
      await utimes(join(run, "state.json"), new Date(1000), new Date(1000));
      expect(await resolveRunDirectory(root, { issue: 91 })).toBe(latest);
    } finally {
      if (previous === undefined) delete process.env.ANIMUS_HOME;
      else process.env.ANIMUS_HOME = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
  test("validateHostedAssetUrl accepts secure public asset URLs and rejects unsafe/local ones", () => {
    // Valid public asset URLs
    expect(
      validateHostedAssetUrl("https://github.com/user-attachments/assets/abc-123.png").ok,
    ).toBe(true);
    expect(
      validateHostedAssetUrl("https://user-images.githubusercontent.com/12345/evidence-after.png")
        .ok,
    ).toBe(true);

    // Insecure HTTP
    const httpRes = validateHostedAssetUrl("http://github.com/asset.png");
    expect(httpRes.ok).toBe(false);
    expect(httpRes.reason).toContain("Insecure URL protocol");

    // Localhost / 127.0.0.1
    expect(validateHostedAssetUrl("https://localhost:8080/asset.png").ok).toBe(false);
    expect(validateHostedAssetUrl("https://127.0.0.1/asset.png").ok).toBe(false);

    // File URI
    expect(validateHostedAssetUrl("file:///tmp/asset.png").ok).toBe(false);

    // Cloud hosting domain (e.g. S3 / Cloudinary) outside GitHub manual scope
    const s3Res = validateHostedAssetUrl("https://s3.amazonaws.com/my-bucket/asset.png");
    expect(s3Res.ok).toBe(false);
    expect(s3Res.reason).toContain("Only manually hosted GitHub assets");

    // Internal domain
    expect(validateHostedAssetUrl("https://secret.corp/asset.png").ok).toBe(false);
  });

  test("bindEvidenceMapping binds URLs and rejects stale candidate heads", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-ev-bind-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const runCandidate = "cand_11111";

    // Create real local artifact capture
    await writeFile(join(artifactsDir, "login-dark.png"), "image-bytes-mock");

    // Setup state.json
    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        runId: "run-test-1",
        candidate: runCandidate,
        pr: "https://github.com/owner/repo/pull/1",
      }),
    );

    // Setup app-check.json with capture
    await writeFile(
      join(artifactsDir, "app-check.json"),
      JSON.stringify({
        head: runCandidate,
        overall: "PASS",
        lines: [],
        captures: [
          {
            id: "ev-login-dark",
            scenario: "Login page dark theme",
            route: "/login",
            candidateIdentity: runCandidate,
            applicability: "applicable",
            afterStatus: "captured",
            afterArtifact: "login-dark.png",
          },
        ],
      }),
    );

    // 1. Stale-head rejection
    const staleMappingPath = join(tempDir, "stale-mapping.json");
    await writeFile(
      staleMappingPath,
      JSON.stringify({
        candidate: "different_stale_sha",
        mappings: {
          "ev-login-dark": "https://github.com/user-attachments/assets/valid.png",
        },
      }),
    );

    expect(() =>
      bindEvidenceMapping({
        runDirectory: tempDir,
        mappingFilePath: staleMappingPath,
      }),
    ).toThrow(/Refusing stale-head mapping/);

    // 2. Valid mapping binding
    const validMappingPath = join(tempDir, "valid-mapping.json");
    await writeFile(
      validMappingPath,
      JSON.stringify({
        candidate: runCandidate,
        mappings: {
          "ev-login-dark": {
            afterUrl: "https://github.com/user-attachments/assets/valid.png",
          },
        },
      }),
    );

    const bindResult = bindEvidenceMapping({
      runDirectory: tempDir,
      mappingFilePath: validMappingPath,
    });

    expect(bindResult.boundCount).toBe(1);
    expect(bindResult.candidate).toBe(runCandidate);

    // 3. Preview evidence captures includes bound URL
    const preview = previewEvidenceCaptures(tempDir);
    expect(preview.checklist.some((l) => l.includes("BOUND") && l.includes("ev-login-dark"))).toBe(
      true,
    );
    expect(
      preview.checklist.some((l) =>
        l.includes("https://github.com/user-attachments/assets/valid.png"),
      ),
    ).toBe(true);

    // 4. publishBoundEvidence with noPush returns preview cleanly
    const pubPreview = await publishBoundEvidence({
      repoRoot: tempDir,
      runDirectory: tempDir,
      noPush: true,
    });
    expect(pubPreview.ok).toBe(true);
    expect(pubPreview.message).toContain("[NO-PUSH]");

    await rm(tempDir, { recursive: true, force: true });
  });

  test("CLI command loop evidence handles unknown subcommand or missing run", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-cli-test-"));
    let logged = "";
    const origLog = console.log;
    const origErr = console.error;
    console.log = (msg) => {
      logged += String(msg);
    };
    console.error = (msg) => {
      logged += String(msg);
    };

    try {
      // Missing run / issue
      const code = await runLoopCliCommand({
        subcommand: "evidence",
        positionals: ["loop", "evidence"],
        repoRoot: tempDir,
        run: "non-existent-run",
      });
      expect(code).toBe(1);
      expect(logged).toContain("Error:");
    } finally {
      console.log = origLog;
      console.error = origErr;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("bindEvidenceMapping rejects unknown evidence ID", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-ev-unknown-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const runCandidate = "cand_unknown_id";

    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        runId: "run-test-unknown",
        candidate: runCandidate,
        pr: "https://github.com/owner/repo/pull/1",
      }),
    );

    await writeFile(
      join(artifactsDir, "app-check.json"),
      JSON.stringify({
        head: runCandidate,
        overall: "PASS",
        lines: [],
        captures: [
          {
            id: "ev-known-capture",
            scenario: "Known capture",
            route: "/known",
            candidateIdentity: runCandidate,
            applicability: "applicable",
            afterStatus: "captured",
            afterArtifact: "known.png",
          },
        ],
      }),
    );
    await writeFile(join(artifactsDir, "known.png"), "dummy bytes");

    const mappingPath = join(tempDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        candidate: runCandidate,
        mappings: {
          "ev-mystery-id": "https://github.com/user-attachments/assets/img.png",
        },
      }),
    );

    expect(() =>
      bindEvidenceMapping({
        runDirectory: tempDir,
        mappingFilePath: mappingPath,
      }),
    ).toThrow(/Unknown evidence ID 'ev-mystery-id'/);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("bindEvidenceMapping requires readable local capture file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-ev-missing-file-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const runCandidate = "cand_missing_file";

    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        runId: "run-test-missing-file",
        candidate: runCandidate,
        pr: "https://github.com/owner/repo/pull/1",
      }),
    );

    await writeFile(
      join(artifactsDir, "app-check.json"),
      JSON.stringify({
        head: runCandidate,
        overall: "PASS",
        lines: [],
        captures: [
          {
            id: "ev-missing-art",
            scenario: "Missing artifact capture",
            route: "/missing",
            candidateIdentity: runCandidate,
            applicability: "applicable",
            afterStatus: "captured",
            afterArtifact: "non-existent-artifact.png",
          },
        ],
      }),
    );
    // Intentionally do NOT create non-existent-artifact.png!

    const mappingPath = join(tempDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        candidate: runCandidate,
        mappings: {
          "ev-missing-art": "https://github.com/user-attachments/assets/img.png",
        },
      }),
    );

    expect(() =>
      bindEvidenceMapping({
        runDirectory: tempDir,
        mappingFilePath: mappingPath,
      }),
    ).toThrow(/missing evidence: non-existent-artifact\.png/);

    await rm(tempDir, { recursive: true, force: true });
  });

  test("bindEvidenceMapping rejects binding beforeUrl when Before is N/A", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "animus-ev-na-side-"));
    const artifactsDir = join(tempDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const runCandidate = "cand_na_side";

    await writeFile(
      join(tempDir, "state.json"),
      JSON.stringify({
        runId: "run-test-na-side",
        candidate: runCandidate,
        pr: "https://github.com/owner/repo/pull/1",
      }),
    );

    await writeFile(
      join(artifactsDir, "app-check.json"),
      JSON.stringify({
        head: runCandidate,
        overall: "PASS",
        lines: [],
        captures: [
          {
            id: "ev-new-feature",
            scenario: "Brand new feature",
            route: "/new",
            candidateIdentity: runCandidate,
            applicability: "na_new_feature",
            beforeStatus: "na",
            afterStatus: "captured",
            afterArtifact: "new-feature.png",
          },
        ],
      }),
    );
    await writeFile(join(artifactsDir, "new-feature.png"), "dummy bytes");

    const mappingPath = join(tempDir, "mapping.json");
    await writeFile(
      mappingPath,
      JSON.stringify({
        candidate: runCandidate,
        mappings: {
          "ev-new-feature": {
            beforeUrl: "https://github.com/user-attachments/assets/baseline.png",
            afterUrl: "https://github.com/user-attachments/assets/after.png",
          },
        },
      }),
    );

    expect(() =>
      bindEvidenceMapping({
        runDirectory: tempDir,
        mappingFilePath: mappingPath,
      }),
    ).toThrow(/Before state is N\/A/);

    await rm(tempDir, { recursive: true, force: true });
  });
});
