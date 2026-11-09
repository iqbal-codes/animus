import { z } from "zod";

/**
 * Canonical grammar for the bounded inline child-evidence marker.
 *
 * One producer (`evidence/observations`) and one consumer (`publication/service`)
 * share this codec. Both sides encode and parse through it, so the marker can
 * never drift into a substring protocol that a forged event body satisfies.
 *
 * The metadata is serialized as JSON inside an HTML comment and every `<`/`>`
 * is escaped, so producer-controlled ids, media types and paths can never close
 * the comment or inject markdown. A consumer still re-reads the immutable
 * artifact and recomputes the excerpt digest; this grammar is a validation
 * boundary, not an authority claim.
 */
export const INLINE_ARTIFACT_MARKER_NAME = "animus-inline-artifact";
export const INLINE_ARTIFACT_MARKER_OPEN = `<!-- ${INLINE_ARTIFACT_MARKER_NAME} `;
export const INLINE_ARTIFACT_MARKER_CLOSE = " -->";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;

/** Media types whose bytes are safe to inline as bounded, sanitized text. */
export const INLINE_TEXT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/x-ndjson",
] as const;

export function normalizeInlineMediaType(value: string): string {
  return value.split(";")[0]?.trim().toLowerCase() ?? "";
}

export function isInlineTextMediaType(value: string): boolean {
  return (INLINE_TEXT_MEDIA_TYPES as readonly string[]).includes(normalizeInlineMediaType(value));
}

export const inlineArtifactMarkerSchema = z
  .object({
    artifact: z.string().min(1).max(200),
    sha256: z.string().regex(SHA256_HEX),
    size: z.number().int().nonnegative(),
    media: z.string().min(1).max(200),
    path: z.string().min(1).max(1000),
    inline_sha256: z.string().regex(SHA256_HEX),
    truncated: z.union([z.literal(0), z.literal(1)]),
    candidate: z.string().regex(COMMIT_SHA),
    run: z.string().min(1).max(200),
  })
  .strict();
export type InlineArtifactMarkerPayload = z.infer<typeof inlineArtifactMarkerSchema>;

export interface InlineArtifactMarker {
  artifactId: string;
  digestSha256: string;
  sizeBytes: number;
  mediaType: string;
  relativePath: string;
  inlineSha256: string;
  truncated: boolean;
  candidateHeadSha: string;
  runId: string;
}

function encodeMarkerJson(payload: InlineArtifactMarkerPayload): string {
  return JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Serialize one marker. All untrusted fields are JSON-escaped inside the comment. */
export function encodeInlineArtifactMarker(marker: InlineArtifactMarker): string {
  const payload: InlineArtifactMarkerPayload = {
    artifact: marker.artifactId,
    sha256: marker.digestSha256,
    size: marker.sizeBytes,
    media: marker.mediaType,
    path: marker.relativePath,
    inline_sha256: marker.inlineSha256,
    truncated: marker.truncated ? 1 : 0,
    candidate: marker.candidateHeadSha,
    run: marker.runId,
  };
  return `${INLINE_ARTIFACT_MARKER_OPEN}${encodeMarkerJson(payload)}${INLINE_ARTIFACT_MARKER_CLOSE}`;
}

export interface ParsedInlineArtifactMarker {
  marker: InlineArtifactMarker;
  raw: string;
}

function decodePayload(raw: string): InlineArtifactMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = inlineArtifactMarkerSchema.safeParse(parsed);
  if (!validated.success) return null;
  const payload = validated.data;
  return {
    artifactId: payload.artifact,
    digestSha256: payload.sha256,
    sizeBytes: payload.size,
    mediaType: payload.media,
    relativePath: payload.path,
    inlineSha256: payload.inline_sha256,
    truncated: payload.truncated === 1,
    candidateHeadSha: payload.candidate,
    runId: payload.run,
  };
}

/**
 * Find every strictly valid marker in arbitrary text. Because `<`/`>` are escaped
 * in the payload, the first ` -->` after the open token is the real terminator.
 * Malformed or unknown-schema markers are skipped, never treated as evidence.
 */
export function findInlineArtifactMarkers(text: string): ParsedInlineArtifactMarker[] {
  const markers: ParsedInlineArtifactMarker[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(INLINE_ARTIFACT_MARKER_OPEN, cursor);
    if (open === -1) break;
    const payloadStart = open + INLINE_ARTIFACT_MARKER_OPEN.length;
    const close = text.indexOf(INLINE_ARTIFACT_MARKER_CLOSE, payloadStart);
    if (close === -1) break;
    const raw = text.slice(open, close + INLINE_ARTIFACT_MARKER_CLOSE.length);
    const marker = decodePayload(text.slice(payloadStart, close));
    if (marker) markers.push({ marker, raw });
    cursor = close + INLINE_ARTIFACT_MARKER_CLOSE.length;
  }
  return markers;
}

export function inlineArtifactMarkersEqual(
  left: InlineArtifactMarker,
  right: InlineArtifactMarker,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.digestSha256 === right.digestSha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.mediaType === right.mediaType &&
    left.relativePath === right.relativePath &&
    left.inlineSha256 === right.inlineSha256 &&
    left.truncated === right.truncated &&
    left.candidateHeadSha === right.candidateHeadSha &&
    left.runId === right.runId
  );
}
