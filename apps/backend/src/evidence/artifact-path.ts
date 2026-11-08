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
