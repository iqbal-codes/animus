import { createHash } from "node:crypto";

export interface NormalizedCriterion {
  key: string;
  ordinal: number;
  text: string;
}

export interface CoverageClause {
  keys: number[];
  note: string;
}

const AC_KEY_PATTERN = /^\s*(AC\s*\d+)\s*(?:[:—–-]\s*)?([\s\S]*)$/i;

export function normalizeAcceptanceCriteria(items: readonly string[]): NormalizedCriterion[] {
  return items.map((item, index) => {
    const match = item.match(AC_KEY_PATTERN);
    if (match) {
      const key = `AC${Number.parseInt(match[1]!.replace(/\s+/g, "").slice(2), 10)}`;
      const text = (match[2] ?? "").trim();
      return { key, ordinal: index + 1, text: text || item.trim() };
    }
    return { key: `AC${index + 1}`, ordinal: index + 1, text: item.trim() };
  });
}

export function duplicateAcceptanceKeys(criteria: readonly NormalizedCriterion[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const criterion of criteria) {
    if (seen.has(criterion.key)) duplicates.add(criterion.key);
    seen.add(criterion.key);
  }
  return [...duplicates].sort(acSort);
}

const COVERAGE_PATTERN = /source\s+acceptance\s+coverage\s*:\s*([^\n\r]+)/gi;
const RANGE_PATTERN = /AC\s*(\d+)\s*[–—-]\s*(?:AC\s*)?(\d+)/gi;
const SINGLE_PATTERN = /AC\s*(\d+)/gi;

export function parseCoverageClauses(body: string): CoverageClause[] {
  const clauses: CoverageClause[] = [];
  for (const match of body.matchAll(COVERAGE_PATTERN)) {
    const note = (match[1] ?? "").trim();
    if (!note) continue;
    const keys = new Set<number>();
    for (const range of note.matchAll(RANGE_PATTERN)) {
      const start = Number.parseInt(range[1]!, 10);
      const end = Number.parseInt(range[2]!, 10);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) continue;
      const lower = Math.min(start, end);
      const upper = Math.max(start, end);
      if (upper - lower > 200) continue;
      for (let value = lower; value <= upper; value += 1) keys.add(value);
    }
    for (const single of note.matchAll(SINGLE_PATTERN)) {
      const value = Number.parseInt(single[1]!, 10);
      if (Number.isSafeInteger(value)) keys.add(value);
    }
    clauses.push({ keys: [...keys].sort((a, b) => a - b), note });
  }
  return clauses;
}

function acSort(left: string, right: string): number {
  const leftNumber = Number.parseInt(left.replace(/^AC/i, ""), 10);
  const rightNumber = Number.parseInt(right.replace(/^AC/i, ""), 10);
  return leftNumber - rightNumber;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = canonicalize(record[key]);
    }
    return result;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function computeGraphHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
