import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeBuilderSession } from "../../scripts/loop/config";
import { buildProviderArgv } from "../../scripts/loop/providers";

const dirs: string[] = [];

function makeRoot(): { root: string } {
  const root = mkdtempSync(join(tmpdir(), "resume-builder-"));
  dirs.push(root);
  mkdirSync(join(root, ".animus"), { recursive: true });
  writeFileSync(
    join(root, ".animus/config.yaml"),
    ["roles:", "  builder:", "    provider: pi", "    model: default", ""].join("\n"),
  );
  return { root };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resume configuration", () => {
  test("reads the repository toggle and lets env override it in both directions", () => {
    const on = makeRoot();
    writeFileSync(
      join(on.root, ".animus/config.yaml"),
      ["loop:", "  resumeBuilderSession: true", ""].join("\n"),
    );
    expect(resolveResumeBuilderSession(on.root, {})).toBe(true);
    expect(resolveResumeBuilderSession(on.root, { FACTORY_LOOP_RESUME_BUILDER_SESSION: "0" })).toBe(
      false,
    );

    const off = makeRoot();
    writeFileSync(
      join(off.root, ".animus/config.yaml"),
      ["loop:", "  resumeBuilderSession: false", ""].join("\n"),
    );
    expect(resolveResumeBuilderSession(off.root, {})).toBe(false);
    expect(
      resolveResumeBuilderSession(off.root, { FACTORY_LOOP_RESUME_BUILDER_SESSION: "true" }),
    ).toBe(true);
  });

  test("defaults to off when nothing is configured", () => {
    const { root } = makeRoot();
    expect(resolveResumeBuilderSession(root, {})).toBe(false);
  });
});

describe("provider resume argv", () => {
  test("each supported provider resumes by explicit id and never by --continue", () => {
    const base = { prompt: "do work", sessionId: "sess-1" };

    const pi = buildProviderArgv("pi", { ...base, sessionDir: "/tmp/s" });
    expect(pi).toContain("--session-id");
    expect(pi).toContain("sess-1");
    expect(pi).not.toContain("--continue");

    const claude = buildProviderArgv("claude", base);
    expect(claude).toContain("--resume");
    expect(claude).toContain("sess-1");
    expect(claude).not.toContain("--continue");

    const omp = buildProviderArgv("omp", { ...base, sessionDir: "/tmp/s" });
    expect(omp).toContain("--resume=sess-1");
    expect(omp).not.toContain("--continue");

    const commandcode = buildProviderArgv("commandcode", base);
    expect(commandcode).toContain("--resume");
    expect(commandcode).toContain("sess-1");
    expect(commandcode).not.toContain("--continue");
  });
});
