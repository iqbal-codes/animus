import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  parseYamlSimple,
  resolveEffortForRole,
  resolveModelForRole,
  resolveModelTier,
  resolveProviderForRole,
  serializeAnimusConfigYaml,
  type AnimusConfig,
} from "../../scripts/loop/config";
import { buildProviderArgv } from "../../scripts/loop/providers";
import registerLoopGuard from "../../.factory/hooks/loop-guard";
import { evaluateTriageToolCall, isTriageCommandAllowed } from "../../scripts/loop/triage-policy";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("Triage Role Configuration & Tier Resolution", () => {
  const tempDirs: string[] = [];
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FACTORY_LOOP_MODEL;
    delete process.env.FACTORY_LOOP_PROVIDER;
    delete process.env.FACTORY_LOOP_EFFORT;
    delete process.env.FACTORY_LOOP_ROLE;
    delete process.env.FACTORY_LOOP_TRIAGE_EFFORT;
    delete process.env.FACTORY_LOOP_BUILDER_EFFORT;
    delete process.env.FACTORY_LOOP_QA_EFFORT;
  });

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
    process.env = { ...origEnv };
  });

  function makeRepo(config?: AnimusConfig): string {
    const root = mkdtempSync(join(tmpdir(), "triage-config-test-"));
    tempDirs.push(root);
    if (config) {
      const cfgDir = join(root, ".animus");
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(join(cfgDir, "config.yaml"), serializeAnimusConfigYaml(config));
    }
    return root;
  }

  test("resolveModelTier defaults triage to medium tier", () => {
    expect(resolveModelTier("triage")).toBe("medium");
  });

  test("resolveModelTier respects role tier overrides from config", () => {
    const configWithRoleObject: AnimusConfig = {
      roles: {
        triage: { tier: "large" },
      },
    };
    expect(resolveModelTier("triage", configWithRoleObject)).toBe("large");

    const configWithRoleString: AnimusConfig = {
      roles: {
        triage: "large" as any,
      },
    };
    expect(resolveModelTier("triage", configWithRoleString)).toBe("large");
  });

  test("resolveModelForRole, resolveProviderForRole, resolveEffortForRole map triage to medium tier defaults", () => {
    const root = makeRepo({
      tiers: {
        medium: {
          provider: "claude",
          model: "claude-3-7-sonnet",
          effort: "high",
        },
      },
    });

    expect(resolveModelForRole(root, "triage")).toBe("claude-3-7-sonnet");
    expect(resolveProviderForRole(root, "triage")).toBe("claude");
    expect(resolveEffortForRole(root, "triage")).toBe("high");
  });

  test("resolveModelForRole and provider respect specific role overrides in config", () => {
    const root = makeRepo({
      tiers: {
        medium: {
          provider: "pi",
          model: "default-medium",
        },
      },
      roles: {
        triage: {
          provider: "anthropic",
          model: "claude-3-5-haiku",
          effort: "medium",
        },
      },
    });

    expect(resolveModelForRole(root, "triage")).toBe("claude-3-5-haiku");
    expect(resolveProviderForRole(root, "triage")).toBe("anthropic");
    expect(resolveEffortForRole(root, "triage")).toBe("medium");
  });

  test("FACTORY_LOOP_* environment overrides take precedence over config for triage", () => {
    const root = makeRepo({
      tiers: {
        medium: {
          provider: "pi",
          model: "pi-medium",
        },
      },
      roles: {
        triage: {
          provider: "anthropic",
          model: "haiku",
        },
      },
    });

    process.env.FACTORY_LOOP_MODEL = "env-model-override";
    process.env.FACTORY_LOOP_PROVIDER = "env-provider-override";
    process.env.FACTORY_LOOP_EFFORT = "max";

    expect(resolveModelForRole(root, "triage")).toBe("env-model-override");
    expect(resolveProviderForRole(root, "triage")).toBe("env-provider-override");
    expect(resolveEffortForRole(root, "triage")).toBe("max");
  });

  test("FACTORY_LOOP_<ROLE>_EFFORT overrides global FACTORY_LOOP_EFFORT and config for specific role", () => {
    const root = makeRepo({
      tiers: {
        medium: {
          provider: "pi",
          model: "pi-medium",
          effort: "high",
        },
      },
      roles: {
        triage: {
          effort: "medium",
        },
      },
    });

    process.env.FACTORY_LOOP_EFFORT = "high";
    process.env.FACTORY_LOOP_TRIAGE_EFFORT = "low";
    process.env.FACTORY_LOOP_QA_EFFORT = "minimal";

    // Triage gets role-specific override "low" despite global FACTORY_LOOP_EFFORT="high"
    expect(resolveEffortForRole(root, "triage")).toBe("low");
    // QA gets role-specific override "minimal"
    expect(resolveEffortForRole(root, "qa")).toBe("minimal");
    // Builder has no role-specific override, so it gets global FACTORY_LOOP_EFFORT="high"
    expect(resolveEffortForRole(root, "builder")).toBe("high");
  });

  test("serializeAnimusConfigYaml and parseYamlSimple round-trip roles configuration cleanly", () => {
    const config: AnimusConfig = {
      assistant: "pi",
      tiers: {
        medium: { provider: "pi", model: "standard" },
      },
      roles: {
        triage: {
          tier: "medium",
          provider: "claude",
          model: "claude-3-5-haiku",
          effort: "low",
        },
      },
    };

    const yaml = serializeAnimusConfigYaml(config);
    expect(yaml).toContain("roles:");
    expect(yaml).toContain("  triage:");
    expect(yaml).toContain("    tier: medium");
    expect(yaml).toContain("    provider: claude");
    expect(yaml).toContain("    model: claude-3-5-haiku");
    expect(yaml).toContain("    effort: low");

    const parsed = parseYamlSimple(yaml);
    expect(parsed.roles?.triage?.tier).toBe("medium");
    expect(parsed.roles?.triage?.provider).toBe("claude");
    expect(parsed.roles?.triage?.model).toBe("claude-3-5-haiku");
    expect(parsed.roles?.triage?.effort).toBe("low");
  });
});

describe("Triage Read-Only & Command Guard (.factory/hooks/loop-guard.ts)", () => {
  const origEnv = { ...process.env };
  const origCwd = process.cwd();
  let tempRoot: string;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "triage-guard-test-"));
    process.env.FACTORY_LOOP_ROLE = "triage";
    delete process.env.FACTORY_LOOP_HARD_DEADLINE_MS;
    delete process.env.FACTORY_LOOP_SOFT_DEADLINE_MS;
  });

  afterEach(() => {
    process.env = { ...origEnv };
    process.chdir(origCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function setupHook() {
    const handlers = new Map<string, (event: any) => Promise<any>>();
    registerLoopGuard({
      on: (name: string, handler: (event: any) => Promise<any>) => handlers.set(name, handler),
    });
    return handlers.get("tool_call")!;
  }

  describe("Registered Hook Integration", () => {
    test("preserves existing non-triage semantics when FACTORY_LOOP_ROLE is not triage", async () => {
      delete process.env.FACTORY_LOOP_ROLE;
      const call = setupHook();

      // write to regular file is not blocked by triage guard
      const writeResult = await call({
        toolName: "write",
        input: { path: "src/sample.ts", content: "export const x = 1;" },
      });
      expect(writeResult).toBeUndefined();

      // bash commands are not blocked by triage guard
      const bashResult = await call({
        toolName: "bash",
        input: { command: "bun test" },
      });
      expect(bashResult).toBeUndefined();
    });

    test("blocks write and edit tool calls unconditionally when FACTORY_LOOP_ROLE=triage", async () => {
      const call = setupHook();

      const writeRes = await call({
        toolName: "write",
        input: { path: "src/feature.ts", content: "new code" },
      });
      expect(writeRes?.block).toBe(true);
      expect(writeRes?.reason).toContain("TRIAGE GUARD");

      const editRes = await call({
        toolName: "edit",
        input: {
          path: "README.md",
          edits: [{ oldText: "a", newText: "b" }],
        },
      });
      expect(editRes?.block).toBe(true);
      expect(editRes?.reason).toContain("TRIAGE GUARD");
    });

    test("blocks codemode and custom exec tools when FACTORY_LOOP_ROLE=triage", async () => {
      const call = setupHook();

      const codemodeRes = await call({
        toolName: "codemode",
        input: { code: "await tools.write({ path: 'test.txt', content: 'hack' });" },
      });
      expect(codemodeRes?.block).toBe(true);
      expect(codemodeRes?.reason).toContain("TRIAGE GUARD");

      const customExecRes = await call({
        toolName: "custom_exec",
        input: { command: "rm -rf ." },
      });
      expect(customExecRes?.block).toBe(true);
      expect(customExecRes?.reason).toContain("TRIAGE GUARD");
    });

    test("allows safe read and inspection tools when FACTORY_LOOP_ROLE=triage", async () => {
      const call = setupHook();

      const readRes = await call({
        toolName: "read",
        input: { path: "src/types.ts" },
      });
      expect(readRes).toBeUndefined();

      const listDirRes = await call({
        toolName: "list_dir",
        input: { path: "docs" },
      });
      expect(listDirRes).toBeUndefined();
    });

    test("evaluateTriageToolCall public API seam validates tools and commands directly", () => {
      expect(evaluateTriageToolCall("write", { path: "a.ts" }).allowed).toBe(false);
      expect(evaluateTriageToolCall("edit", { path: "a.ts" }).allowed).toBe(false);
      expect(evaluateTriageToolCall("codemode", {}).allowed).toBe(false);
      expect(evaluateTriageToolCall("custom_tool", {}).allowed).toBe(false);
      expect(evaluateTriageToolCall("read", { path: "a.ts" }).allowed).toBe(true);
      expect(evaluateTriageToolCall("list_dir", { path: "." }).allowed).toBe(true);
      expect(evaluateTriageToolCall("bash", { command: "git status" }).allowed).toBe(true);
      expect(evaluateTriageToolCall("bash", { command: "git commit" }).allowed).toBe(false);
      expect(evaluateTriageToolCall("bash", { command: "" }).allowed).toBe(false);
    });
  });

  describe("Hostile Shell Commands Blocked", () => {
    test("registered hook blocks shell expansion and option smuggling before execution", async () => {
      const call = setupHook();
      const commands = [
        "find . -maxdepth 0 $'\\x2d'exec touch pwned {} $'\\x3b'",
        'git log $"--output=pwned" -n 1',
        "git log {--output=pwned,} -n 1",
        "git log --format --output=pwned",
        "git show --pretty --output=pwned",
        "git log -n --output=pwned",
        "git log --format HEAD",
        "rg -m --pre=touch pattern",
        "diff -U --output=pwned a b",
        "find . -maxdepth -delete",
        "git log *",
        "git log ?",
        "git log [a-z]*",
        'git log "$1"',
        "git log $@",
        "git log $0",
        "git log --format",
        "git -C",
      ];
      for (const command of commands) {
        expect((await call({ toolName: "bash", input: { command } }))?.block).toBe(true);
      }
    });

    test("blocks mutating git branch creation (git branch NEW)", () => {
      const branchCreationCommands = [
        "git branch new-feature",
        "git branch evil-branch HEAD",
        "git branch -c old-branch new-branch",
        "git branch -m old-branch new-branch",
      ];
      for (const cmd of branchCreationCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
        expect(res.reason).toContain("git branch");
      }
    });

    test("blocks file writes via git diff/log/show --output=FILE", () => {
      const outputWriteCommands = [
        "git diff --output=pwned.txt",
        "git diff --output evil.txt",
        "git log --output=pwned.txt",
        "git log --output evil.txt",
        "git show --output=pwned.txt",
        "git show --output evil.txt",
      ];
      for (const cmd of outputWriteCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks custom pager execution via git --paginate / -p", () => {
      const paginateCommands = ["git --paginate log", "git -p diff", "git --paginate status"];
      for (const cmd of paginateCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks external diff/textconv driver execution via git diff --ext-diff / --textconv", () => {
      const extDiffCommands = [
        "git diff --ext-diff",
        "git diff --textconv",
        "git show --ext-diff",
        "git show --textconv",
      ];
      for (const cmd of extDiffCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks file writes via find -fprint/-fprintf/-fls", () => {
      const findWriteCommands = [
        "find . -name '*.ts' -fprint out.txt",
        "find . -fprintf out.txt '%p\n'",
        "find . -fls out.txt",
        "find . -fprint0 out.txt",
      ];
      for (const cmd of findWriteCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks arbitrary preprocessor command execution via rg --pre", () => {
      const rgPreCommands = ["rg --pre evil.sh 'pattern'", "rg --pre=evil.sh 'pattern'"];
      for (const cmd of rgPreCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks arbitrary binary paths like /tmp/ls or ./ls", () => {
      const arbitraryBinaryPaths = [
        "/tmp/ls",
        "./ls",
        "/tmp/evil/git status",
        "../bin/cat README.md",
        "~/bin/ls",
      ];
      for (const cmd of arbitraryBinaryPaths) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks gh api to arbitrary endpoints even when field includes sub_issue substring", () => {
      const bypassGhApiCommands = [
        "gh api repos/owner/repo/releases -F sub_issue=1",
        "gh api repos/owner/repo/pulls -F sub_issue_id=1",
        "gh api repos/owner/repo/actions/runs -F note=sub_issues",
        "gh api repos/owner/repo/issues/1/comments -F body=sub_issues",
        "gh api repos/owner/repo/delete",
      ];
      for (const cmd of bypassGhApiCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks external program execution via gh issue --editor and --web", () => {
      const editorWebCommands = [
        "gh issue create --title 'x' --body 'y' --editor",
        "gh issue create --title 'x' -e",
        "gh issue edit 121 --web",
        "gh issue edit 121 -w",
        "gh issue view 121 --web",
        "gh issue view 121 -w",
        "gh issue comment 121 --editor",
      ];
      for (const cmd of editorWebCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });
    test("blocks compound commands and separators", () => {
      const hostileCommands = [
        "ls -la ; rm -rf .",
        "cat README.md && git commit -m 'evil'",
        "git status || echo 'bypass'",
        "ls -la & rm -rf /",
        "ls\nrm -rf .",
        "ls\r\ncat secret.txt",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
        expect(res.reason).toBeDefined();
      }
    });

    test("blocks pipelines", () => {
      const hostileCommands = [
        "ls | grep foo",
        "cat file.txt | sh",
        "find . | xargs rm",
        "git log |& tee out.txt",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks shell redirects", () => {
      const hostileCommands = [
        "cat README.md > pwned.txt",
        "echo 'data' >> .env",
        "cat < secret.txt",
        "ls 2> err.log",
        "ls &> all.log",
        "ls >/dev/null",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks command and variable substitutions and process substitution", () => {
      const hostileCommands = [
        "echo $(whoami)",
        "echo `id`",
        "echo `rm -rf /`",
        "echo ${SHELL}",
        "diff <(ls) <(ls -a)",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks arbitrary interpreters and shells", () => {
      const hostileCommands = [
        "node -e 'console.log(1)'",
        "bun -e 'console.log(1)'",
        "python -c 'print(1)'",
        "python3 -c 'print(1)'",
        "ruby -e 'puts 1'",
        "perl -e 'print 1'",
        "bash script.sh",
        "sh run.sh",
        "zsh",
        "exec ls",
        "eval 'ls'",
        "sudo rm -rf /",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks heavy build, test, and typecheck commands", () => {
      const hostileCommands = [
        "bun test",
        "npm test",
        "npm run build",
        "bun run build",
        "bun run typecheck",
        "vp check",
        "vp test",
        "cargo build",
        "tsc",
        "make",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks package installation and modification", () => {
      const hostileCommands = [
        "bun add zod",
        "bun install",
        "bun i",
        "bun remove lodash",
        "npm install",
        "npm i react",
        "yarn add vue",
        "pnpm add svelte",
        "pip install requests",
        "brew install jq",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks git mutations including -C and flag variants", () => {
      const hostileCommands = [
        "git commit -m 'mutated'",
        "git push origin main",
        "git checkout -b new-branch",
        "git checkout main",
        "git switch main",
        "git reset --hard HEAD~1",
        "git rebase main",
        "git merge feature",
        "git add .",
        "git rm src/types.ts",
        "git clean -fd",
        "git restore .",
        "git branch -D main",
        "git branch -d feature",
        "git remote add origin https://attacker.example/repo.git",
        "git -C /tmp/repo commit -m 'mutated'",
        "git -C . checkout main",
        "git --git-dir=.git push",
        "git --work-tree=. reset --hard",
        "git -c core.fsmonitor='sh -c pwn' status",
        "git tag v1.0.0",
        "git stash",
        "git apply patch.diff",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks unauthorized gh commands outside issue view/list/comment/edit/create + linking", () => {
      const hostileCommands = [
        "gh pr merge 42",
        "gh pr create --title 'x' --body 'y'",
        "gh repo delete owner/repo",
        "gh issue delete 42",
        "gh issue close 42",
        "gh auth login",
        "gh run list",
        "gh release create v1.0.0",
        "gh api repos/owner/repo/pulls",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks inline environment variable prefixes", () => {
      const hostileCommands = [
        "FOO=bar git status",
        "LD_PRELOAD=/evil.so ls",
        "PATH=/tmp:$PATH git diff",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });

    test("blocks hostile find variants with -exec, -delete", () => {
      const hostileCommands = [
        "find . -name '*.ts' -exec rm {} +",
        "find . -delete",
        "find . -ok rm {} ;",
      ];
      for (const cmd of hostileCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(false);
      }
    });
  });

  describe("Allowed Inspection & Authorized Operations", () => {
    test("allows safe read, list, and search commands", () => {
      const safeCommands = [
        "ls",
        "ls -la",
        "ls src/features",
        "cat README.md",
        "head -n 25 package.json",
        "tail -n 50 logs/app.log",
        "grep -rn 'resolveAllowedSkills' scripts/",
        "rg 'LoopRole' scripts/",
        "find . -name '*.ts'",
        "wc -l scripts/loop/types.ts",
        "pwd",
        "diff fileA.txt fileB.txt",
        "file package.json",
      ];
      for (const cmd of safeCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(true);
      }
    });

    test("allows read-only git inspection commands", () => {
      const safeGitCommands = [
        "git status",
        "git status --short",
        "git diff",
        "git diff --stat",
        "git diff HEAD~1",
        "git log -n 5 --oneline",
        "git show HEAD",
        "git rev-parse HEAD",
        "git ls-files",
        "git ls-tree HEAD",
        "git check-ignore src/ignored.txt",
        "git -C . status",
        "git -C src/ status --short",
        "git --no-pager diff",
        "git branch --list",
        "git branch -a",
        "git remote -v",
      ];
      for (const cmd of safeGitCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(true);
      }
    });

    test("allows authorized gh issue commands", () => {
      const safeGhCommands = [
        "gh issue view 121",
        "gh issue view 121 --json number,title,body,labels,comments",
        "gh issue list --state open --label needs-triage",
        "gh issue comment 121 --body 'Clarification needed on acceptance criteria'",
        "gh issue comment 121 --body '> quote from previous discussion\\n\\nAgreed.'",
        "gh issue edit 121 --add-label needs-info --remove-label needs-triage",
        "gh issue create --title 'Feature: interactive triage' --body '## Source and problem...'",
        "gh issue create --parent 116 --title 'Child slice' --body 'Part of #116'",
        "gh issue edit 116 --add-sub-issue 121",
        "gh -R owner/repo issue view 42",
        "gh api repos/owner/repo/issues/116/sub_issues",
        "gh api --method POST repos/owner/repo/issues/121/dependencies/blocked_by -F issue_id=120",
      ];
      for (const cmd of safeGhCommands) {
        const res = isTriageCommandAllowed(cmd);
        expect(res.allowed).toBe(true);
      }
    });
  });
});

describe("buildProviderArgv Triage Skill Optimization & Lazy Materialization", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function makeSkill(name: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), `skill-${name}-`));
    tempDirs.push(dir);
    const skillPath = join(dir, name);
    mkdirSync(skillPath, { recursive: true });
    writeFileSync(join(skillPath, "SKILL.md"), content);
    return skillPath;
  }

  test("provider pi skips materializing skills and passes --skill flags directly", () => {
    const triageSkill = makeSkill("animus-triage", "# Animus Triage Full Content");
    const brainstormSkill = makeSkill("animus-brainstorm", "# Animus Brainstorm Full Content");

    const argv = buildProviderArgv("pi", {
      prompt: "Triage this issue",
      skills: [triageSkill, brainstormSkill],
    });

    expect(argv[0]).toBe("pi");
    expect(argv).toContain("--skill");
    expect(argv).toContain(triageSkill);
    expect(argv).toContain(brainstormSkill);
    // Pi does not include materialized skill bodies in append-system-prompt
    expect(argv.some((arg) => arg.includes("Animus Triage Full Content"))).toBe(false);
    expect(argv.some((arg) => arg.includes("Animus Brainstorm Full Content"))).toBe(false);
  });

  test("non-Pi provider with animus-triage inlines animus-triage in full and formats companion planning skills as concise path pointers", () => {
    const triageSkill = makeSkill(
      "animus-triage",
      "# Animus Triage\nFull triage methodology and instructions.",
    );
    const brainstormSkill = makeSkill(
      "animus-brainstorm",
      "# Animus Brainstorm\nVery long brainstorm content (30KB).",
    );
    const grillSkill = makeSkill("animus-grill", "# Animus Grill\nVery long grill content (20KB).");

    const argv = buildProviderArgv("claude", {
      prompt: "Triage this issue",
      skills: [triageSkill, brainstormSkill, grillSkill],
    });

    expect(argv[0]).toBe("claude");
    // animus-triage is inlined in full
    expect(argv.some((arg) => arg.includes("Full triage methodology and instructions."))).toBe(
      true,
    );

    // companion skills are NOT inlined in full
    expect(argv.some((arg) => arg.includes("Very long brainstorm content"))).toBe(false);
    expect(argv.some((arg) => arg.includes("Very long grill content"))).toBe(false);

    // companion skills ARE listed as concise on-demand path references
    expect(
      argv.some((arg) => arg.includes("animus-brainstorm") && arg.includes(brainstormSkill)),
    ).toBe(true);
    expect(argv.some((arg) => arg.includes("animus-grill") && arg.includes(grillSkill))).toBe(true);
  });

  test("non-Pi provider without animus-triage inlines all passed skills in full", () => {
    const brainstormSkill = makeSkill(
      "animus-brainstorm",
      "# Animus Brainstorm\nFull content when standalone.",
    );

    const argv = buildProviderArgv("claude", {
      prompt: "Brainstorm design",
      skills: [brainstormSkill],
    });

    expect(argv[0]).toBe("claude");
    expect(argv.some((arg) => arg.includes("Full content when standalone."))).toBe(true);
  });
});
