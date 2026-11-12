import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { parseDocument, stringify } from "yaml";

/**
 * Shared YAML plumbing for Animus configuration files.
 *
 * Every configuration layer (`~/.animus/config.yaml`, `<repo>/.animus/config.yaml`,
 * `~/.animus/projects/<slug>/config.yaml`) is a single YAML document. Writes are
 * atomic and merge into the existing document so comments an operator added to
 * keys we do not own survive the rewrite.
 */

/** Parses a YAML mapping. Returns null when the file is absent, invalid, or not a mapping. */
export function readYamlObject(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;
  try {
    const doc = parseDocument(readFileSync(filePath, "utf-8"));
    if (doc.errors.length > 0) return null;
    const value = doc.toJS() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Merges `patch` into the YAML document at `filePath` and writes it atomically.
 *
 * Keys already present keep their position and comment; keys in `patch` replace
 * the value in place; `undefined` entries are skipped so a partial update never
 * erases an unrelated block. Returns the path written.
 */
export function mergeYamlFile(
  filePath: string,
  patch: Record<string, unknown>,
  options: { mode?: number } = {},
): string {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const doc = existing.trim() ? parseDocument(existing) : parseDocument("");
  if (doc.errors.length > 0) {
    throw new Error(
      `Cannot update ${filePath}: existing YAML is malformed (${doc.errors[0]?.message})`,
    );
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    doc.set(key, value);
  }
  const mode = options.mode ?? (existsSync(filePath) ? statSync(filePath).mode & 0o777 : 0o644);
  return writeYamlDocumentAtomic(filePath, doc.toString({ lineWidth: 0 }), mode);
}

/** Replaces the whole document. Prefer {@link mergeYamlFile} for partial updates. */
export function writeYamlFile(
  filePath: string,
  value: Record<string, unknown>,
  options: { mode?: number } = {},
): string {
  return writeYamlDocumentAtomic(
    filePath,
    stringify(value, { lineWidth: 0 }),
    options.mode ?? 0o644,
  );
}

function writeYamlDocumentAtomic(filePath: string, content: string, mode: number): string {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content.endsWith("\n") ? content : `${content}\n`, {
    encoding: "utf-8",
    mode,
  });
  renameSync(tmp, filePath);
  return filePath;
}

/** Removes a legacy file only when it exists; migration must never fail on a missing file. */
export function removeFileIfExists(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
