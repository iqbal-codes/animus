import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeBuilderSessionIdForLap } from "../../scripts/animus-loop";
import { resolveResumeBuilderSession } from "../../scripts/loop/config";
import { saveIssueDossier, type IssueDossier } from "../../scripts/loop/dossier";
import { buildProviderArgv } from "../../scripts/loop/providers";

const dirs: string[] = [];
const originalEnv = process.env.FACTORY_LOOP_RESUME_BUILDER_SESSION;

function makeRoot(): { root: string; stateRoot: string; runDirectory: string } {
  const root = mkdtempSync(join(tmpdir(), "resume-builder-"));
  dirs.push(root);
  const stateRoot = join(root, "state");
  const runDirectory = join(stateRoot, "runs", "run-1");
  mkdirSync(join(root, ".animus"), { recursive: true });
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(
    join(root, ".animus/config.yaml"),
    ["roles:", "  builder:", "    provider: pi", "    model: default", ""].join("\n"),
  );
  return { root, stateRoot, runDirectory };
}

function writeDossier(
  stateRoot: string,
  overrides: Partial<IssueDossier["attempts"][number]> = {},
  status: IssueDossier["attempts"][number]["status"] = "sent_back",
): void {
  const dossier: IssueDossier = {
    issueNumber: 70,
    issueTitle: "Issue",
    issueUrl: "https://github.com/o/r/issues/70",
    branch: "local-loop/issue-70",
    attempts: [
      {
        lapIndex: 0,
        runId: "run-1",
        timestamp: new Date().toISOString(),
        status,
        candidateHead: "abc123",
        changedFiles: [],
        reviewFindings: [],
        qaFailures: [],
        sessions: { builder: { sessionId: "sess-1", provider: "pi" } },
        ...overrides,
      },
    ],
  };
  saveIssueDossier(stateRoot, dossier);
}

function writeTranscript(runDirectory: string, sessionId: string): void {
  const dir = join(runDirectory, "0-builder-session", "--/cwd--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`), "");
}

beforeEach(() => {
  process.env.FACTORY_LOOP_RESUME_BUILDER_SESSION = "1";
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env.FACTORY_LOOP_RESUME_BUILDER_SESSION;
  else process.env.FACTORY_LOOP_RESUME_BUILDER_SESSION = originalEnv;
});

describe("resume builder session resolution", () => {
  test("resumes when every precondition holds", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot);
    writeTranscript(runDirectory, "sess-1");

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory,
      }),
    ).toBe("sess-1");
  });

  test("does not resume on a simple lap", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot);
    writeTranscript(runDirectory, "sess-1");

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "simple",
        runDirectory,
      }),
    ).toBeUndefined();
  });

  test("does not resume when the toggle is off", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot);
    writeTranscript(runDirectory, "sess-1");
    delete process.env.FACTORY_LOOP_RESUME_BUILDER_SESSION;

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory,
      }),
    ).toBeUndefined();
  });

  test("does not resume after a failed lap or without a candidate", () => {
    const failed = makeRoot();
    writeDossier(failed.stateRoot, {}, "failed");
    writeTranscript(failed.runDirectory, "sess-1");
    expect(
      resolveResumeBuilderSessionIdForLap({
        root: failed.root,
        stateRoot: failed.stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory: failed.runDirectory,
      }),
    ).toBeUndefined();

    const noCandidate = makeRoot();
    writeDossier(noCandidate.stateRoot, { candidateHead: undefined });
    writeTranscript(noCandidate.runDirectory, "sess-1");
    expect(
      resolveResumeBuilderSessionIdForLap({
        root: noCandidate.root,
        stateRoot: noCandidate.stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory: noCandidate.runDirectory,
      }),
    ).toBeUndefined();
  });

  test("does not resume when the provider changed", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot, {
      sessions: { builder: { sessionId: "sess-1", provider: "claude" } },
    });
    writeTranscript(runDirectory, "sess-1");

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory,
      }),
    ).toBeUndefined();
  });

  test("does not resume when the transcript is gone", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot);

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory,
      }),
    ).toBeUndefined();
  });

  test("refuses providers whose session layout is unverified", () => {
    const { root, stateRoot, runDirectory } = makeRoot();
    writeDossier(stateRoot, {
      sessions: { builder: { sessionId: "sess-1", provider: "commandcode" } },
    });
    writeTranscript(runDirectory, "sess-1");

    expect(
      resolveResumeBuilderSessionIdForLap({
        root,
        stateRoot,
        issueNumber: 70,
        route: "continue",
        runDirectory,
        providerOverride: "commandcode",
      }),
    ).toBeUndefined();
  });
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
