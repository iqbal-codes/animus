import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderInlineArtifactEvidence,
  verifyInlineArtifactEvidence,
  type InlineEvidenceArtifact,
} from "../../apps/backend/src/evidence/inline-artifact";
import { sanitizePublicationText } from "../../apps/backend/src/publication/sanitizer";
import { findInlineArtifactMarkers } from "../../packages/contracts/src/inline-artifact";

/**
 * S-A-1: the canonical inline block must be identical before and after the
 * outbound sanitizer, so the *posted* marker still parses and the posted payload
 * still matches the verified bytes. Completeness must verify the final outbound
 * body, never the unsent raw row.
 */
describe("inline artifact evidence is stable across the outbound sanitizer", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "animus-inline-sa1-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function artifactFor(
    projectId: string,
    relativePath: string,
    name: string,
    content: string,
  ): InlineEvidenceArtifact {
    mkdirSync(join(root, projectId, relativePath.split("/").slice(0, -1).join("/")), {
      recursive: true,
    });
    writeFileSync(join(root, projectId, relativePath), content);
    return {
      id: `art_${createHash("sha256").update(relativePath).digest("hex").slice(0, 16)}`,
      name,
      relativePath,
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(content),
      digestSha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  test("a secret-shaped artifact path/name survives sanitization and verifies on the posted body", () => {
    const projectId = "proj";
    const artifact = artifactFor(
      projectId,
      "checks/api_key=abcdefghij.log",
      "log /Users/operator/private/api_key=abcdefghij.log",
      "safe evidence body\n",
    );
    const binding = { runId: "run_sa1", candidateHeadSha: "a".repeat(40) };
    const rendered = renderInlineArtifactEvidence(root, projectId, artifact, binding, 131_072);
    expect(rendered).not.toBeNull();

    // The block must already be sanitizer-stable: applying the outbound pass is a
    // no-op for the canonical evidence region.
    const posted = sanitizePublicationText(`preamble\n${rendered!.block}\npostamble`);
    expect(posted).toContain(rendered!.block);

    const postedMarkers = findInlineArtifactMarkers(posted);
    expect(postedMarkers).toHaveLength(1);
    expect(postedMarkers[0]!.marker.relativePath).not.toContain("api_key=abcdefghij");

    const verified = verifyInlineArtifactEvidence({
      artifactRoot: root,
      projectId,
      artifact,
      binding,
      maxBytes: 131_072,
      body: posted,
    });
    expect(verified).toEqual({ ok: true });

    // The exact bytes the publisher would actually post are what verify against.
    const tampered = posted.replace(
      rendered!.block,
      rendered!.block.replace("safe evidence", "evil"),
    );
    const tamperedVerify = verifyInlineArtifactEvidence({
      artifactRoot: root,
      projectId,
      artifact,
      binding,
      maxBytes: 131_072,
      body: tampered,
    });
    expect(tamperedVerify.ok).toBe(false);
  });

  test("a local absolute path in metadata is rewritten deterministically", () => {
    const projectId = "proj";
    const artifact = artifactFor(
      projectId,
      "checks/weekly.log",
      "Weekly /tmp/scratch/report.log",
      "line one\nline two\n",
    );
    const binding = { runId: "run_sa1b", candidateHeadSha: "b".repeat(40) };
    const rendered = renderInlineArtifactEvidence(root, projectId, artifact, binding, 131_072);
    expect(rendered).not.toBeNull();
    const posted = sanitizePublicationText(rendered!.block);
    expect(posted).toBe(rendered!.block);
    const verified = verifyInlineArtifactEvidence({
      artifactRoot: root,
      projectId,
      artifact,
      binding,
      maxBytes: 131_072,
      body: posted,
    });
    expect(verified).toEqual({ ok: true });
  });
});
