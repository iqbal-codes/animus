import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  encodeInlineArtifactMarker,
  findInlineArtifactMarkers,
  inlineArtifactMarkersEqual,
  isInlineTextMediaType,
  type InlineArtifactMarker,
} from "@animus/contracts/inline-artifact";
import { normalizeArtifactRelativePath, containsDisallowedControlCharacter } from "./artifact-path";
import { sanitizePublicationText } from "../publication/sanitizer";

/**
 * The immutable identity of one finalized artifact. Both the producer (evidence
 * observation audit) and the consumer (publication completeness) verify against
 * this exact record, not against a caller-supplied string.
 */
export interface InlineEvidenceArtifact {
  id: string;
  name: string;
  relativePath: string;
  mediaType: string;
  sizeBytes: number;
  digestSha256: string;
}

/** The durable run/candidate an inline artifact is bound to. */
export interface InlineEvidenceBinding {
  runId: string;
  candidateHeadSha: string;
}

interface InvalidInlineArtifact {
  ok: false;
  reason: string;
}

interface ValidInlineArtifact {
  ok: true;
  excerpt: string;
  inlineSha256: string;
  marker: InlineArtifactMarker;
  block: string;
}

export type InlineArtifactRead = ValidInlineArtifact | InvalidInlineArtifact;

function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  let current = 0;
  for (const char of value) {
    current = char === "`" ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Escape a producer-controlled display name for the `<summary>` HTML node. */
function escapeInlineLabel(value: string): string {
  let label = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    label += code <= 0x1f || code === 0x7f ? " " : char;
  }
  return label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Reject bytes that are not honestly representable as bounded UTF-8 text. */
function decodeTextArtifact(bytes: Buffer): { ok: true; text: string } | InvalidInlineArtifact {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_valid_utf8" };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "contains_nul" };
  if (containsDisallowedControlCharacter(text)) {
    return { ok: false, reason: "contains_control_characters" };
  }
  return { ok: true, text };
}

function resolveConfinedArtifact(
  artifactRoot: string,
  projectId: string,
  relativePath: string,
): { ok: true; absolute: string } | InvalidInlineArtifact {
  let normalized: string;
  try {
    normalized = normalizeArtifactRelativePath(relativePath);
  } catch {
    return { ok: false, reason: "unsafe_path" };
  }
  const root = resolve(join(artifactRoot, projectId));
  const absolute = resolve(root, normalized);
  if (absolute !== root && !absolute.startsWith(root + sep)) {
    return { ok: false, reason: "path_escapes_root" };
  }
  let stats;
  try {
    stats = lstatSync(absolute);
  } catch {
    return { ok: false, reason: "artifact_missing" };
  }
  if (!stats.isFile()) return { ok: false, reason: "artifact_not_regular_file" };
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = realpathSync(root);
    realFile = realpathSync(absolute);
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) {
    return { ok: false, reason: "path_escapes_root" };
  }
  return { ok: true, absolute };
}

/**
 * Re-read one immutable artifact and derive the full canonical inline payload.
 *
 * Everything is recomputed from bytes on disk: size, full-file SHA-256, UTF-8
 * validity, control/binary rejection, sanitized excerpt and excerpt digest. A
 * partial or oversized artifact is deliberately not inline-eligible, so it can
 * never be advertised as complete public proof.
 */
export function readInlineArtifactEvidence(
  artifactRoot: string,
  projectId: string,
  artifact: InlineEvidenceArtifact,
  binding: InlineEvidenceBinding,
  maxBytes: number,
): InlineArtifactRead {
  if (!isInlineTextMediaType(artifact.mediaType)) {
    return { ok: false, reason: "media_type_not_inline_safe" };
  }
  if (artifact.sizeBytes > maxBytes) {
    return { ok: false, reason: "artifact_exceeds_inline_bound" };
  }
  const confined = resolveConfinedArtifact(artifactRoot, projectId, artifact.relativePath);
  if (!confined.ok) return confined;
  let bytes: Buffer;
  try {
    bytes = readFileSync(confined.absolute);
  } catch {
    return { ok: false, reason: "artifact_unreadable" };
  }
  if (bytes.byteLength !== artifact.sizeBytes) {
    return { ok: false, reason: "artifact_size_mismatch" };
  }
  if (bytes.byteLength > maxBytes) {
    return { ok: false, reason: "artifact_exceeds_inline_bound" };
  }
  if (sha256Hex(bytes) !== artifact.digestSha256) {
    return { ok: false, reason: "artifact_digest_mismatch" };
  }
  const decoded = decodeTextArtifact(bytes);
  if (!decoded.ok) return decoded;
  const sanitized = sanitizePublicationText(decoded.text);
  if (sanitized.length > maxBytes) {
    // Never publish a partial excerpt as complete proof; the operator must supply
    // hosted access for the full artifact.
    return { ok: false, reason: "artifact_exceeds_inline_character_bound" };
  }
  const excerpt = sanitized;
  const inlineSha256 = sha256Hex(excerpt);
  const marker: InlineArtifactMarker = {
    artifactId: artifact.id,
    digestSha256: artifact.digestSha256,
    sizeBytes: artifact.sizeBytes,
    mediaType: artifact.mediaType,
    relativePath: artifact.relativePath,
    inlineSha256,
    truncated: false,
    candidateHeadSha: binding.candidateHeadSha,
    runId: binding.runId,
  };
  const fence = "`".repeat(Math.max(3, longestBacktickRun(excerpt) + 1));
  const block = [
    encodeInlineArtifactMarker(marker),
    `<details><summary>${escapeInlineLabel(artifact.name)} — bounded inline evidence (full artifact ${artifact.sizeBytes}B, sha256 ${artifact.digestSha256.slice(0, 16)}…)</summary>`,
    "",
    `${fence}text`,
    excerpt,
    fence,
    "",
    "</details>",
  ].join("\n");
  return { ok: true, excerpt, inlineSha256, marker, block };
}

/**
 * Render the exact block the producer publishes. Returns null when the artifact
 * is not honestly inline-eligible (binary, oversized, unreadable, changed).
 */
export function renderInlineArtifactEvidence(
  artifactRoot: string,
  projectId: string,
  artifact: InlineEvidenceArtifact,
  binding: InlineEvidenceBinding,
  maxBytes: number,
): { marker: string; block: string } | null {
  const read = readInlineArtifactEvidence(artifactRoot, projectId, artifact, binding, maxBytes);
  if (!read.ok) return null;
  return { marker: encodeInlineArtifactMarker(read.marker), block: read.block };
}

export type InlineArtifactVerification =
  | { ok: true }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/**
 * Verify that an accepted audit event contains the exact canonical inline block
 * for this artifact: parse the strict marker, re-read the immutable file, and
 * require exact payload equality. A self-reported or forged marker never counts.
 */
export function verifyInlineArtifactEvidence(input: {
  artifactRoot: string;
  projectId: string;
  artifact: InlineEvidenceArtifact;
  binding: InlineEvidenceBinding;
  maxBytes: number;
  body: string;
}): InlineArtifactVerification {
  const read = readInlineArtifactEvidence(
    input.artifactRoot,
    input.projectId,
    input.artifact,
    input.binding,
    input.maxBytes,
  );
  if (!read.ok) return { ok: false, reason: read.reason };
  const markers = findInlineArtifactMarkers(input.body).filter(
    (candidate) => candidate.marker.artifactId === input.artifact.id,
  );
  if (markers.length === 0) return { ok: false, reason: "marker_missing" };
  if (markers.length > 1) return { ok: false, reason: "marker_ambiguous" };
  if (!inlineArtifactMarkersEqual(markers[0]!.marker, read.marker)) {
    return { ok: false, reason: "marker_mismatch" };
  }
  if (!input.body.includes(read.block)) {
    return { ok: false, reason: "published_payload_mismatch" };
  }
  return { ok: true };
}
