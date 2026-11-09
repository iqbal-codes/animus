import { isAbsolute, posix } from "node:path";

/**
 * Shared finalized-artifact path rule used by evidence writes and workspace
 * restore. Artifact references are project-relative POSIX paths; absolute,
 * backslash and parent-escaping paths are never valid.
 */
export class ArtifactPathError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

/** True when the string contains any C0/DEL control character. */
export function containsControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** True when the string contains a control character other than tab/newline/CR. */
export function containsDisallowedControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeArtifactRelativePath(relativePath: string): string {
  const candidate = relativePath.trim();
  if (
    candidate === "" ||
    isAbsolute(candidate) ||
    candidate.includes("\\") ||
    candidate.includes("\0")
  ) {
    throw new ArtifactPathError(
      "artifact_unsafe_path",
      `Artifact path must be a normalized project-relative path: ${relativePath}`,
    );
  }
  // Producer-controlled path text is also untrusted metadata. Reject characters
  // that could break an inline marker, a markdown fence or an HTML comment.
  if (
    containsControlCharacter(candidate) ||
    candidate.includes("-->") ||
    candidate.includes("<!--")
  ) {
    throw new ArtifactPathError(
      "artifact_unsafe_path",
      `Artifact path contains unsafe control or comment characters: ${relativePath}`,
    );
  }
  const normalized = posix.normalize(candidate).replace(/^\.\//, "");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new ArtifactPathError(
      "artifact_unsafe_path",
      `Artifact path escapes the project artifact root: ${relativePath}`,
    );
  }
  return normalized;
}
