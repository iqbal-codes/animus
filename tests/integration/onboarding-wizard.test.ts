import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyRepositorySetup, runConfigCliCommand } from "../../scripts/cli/commands/setup";
import { readArchonConfig, writeArchonConfig } from "../../scripts/loop/config";
import {
  OnboardingCancelled,
  type WizardChoice,
  type WizardPrompts,
} from "../../scripts/cli/commands/onboarding-prompts";

const roots: string[] = [];
function repo() {
  const root = mkdtempSync(join(tmpdir(), "onboarding-wizard-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Answers implements WizardPrompts {
  notes: string[] = [];
  selections: { message: string; choices: WizardChoice[]; searchable?: boolean }[] = [];
  initiallyChecked: string[] = [];
  closed = false;
  constructor(
    public selected: string[],
    public selects: string[] = ["continue"],
    public texts: string[] = [],
  ) {}
  async checkbox(_message: string, _choices: WizardChoice[], selected: string[]) {
    this.initiallyChecked = [...selected];
    return this.selected;
  }
  async select(message: string, choices: WizardChoice[], _initial?: string, searchable?: boolean) {
    this.selections.push({ message, choices, searchable });
    const next = this.selects.shift() ?? choices[0]!.value;
    expect(choices.map((c) => c.value)).toContain(next);
    return next;
  }
  async text(_message: string, initial: string) {
    return this.texts.shift() ?? initial;
  }
  note(message: string) {
    this.notes.push(message);
  }
  close() {
    this.closed = true;
  }
}
const offline = { detectHarnesses: () => [] };

describe("onboarding wizard setup", () => {
  test.each(["maxLaps", "parallel", "intervalSeconds"] as const)(
    "noninteractive %s validation rejects zero",
    async (field) => {
      const root = repo();
      await expect(
        applyRepositorySetup({ repoRoot: root, nonInteractive: true, [field]: 0 }, offline),
      ).rejects.toThrow("positive safe integer");
      expect(existsSync(join(root, ".factory"))).toBe(false);
    },
  );

  test("noninteractive setup keeps explicit cross-harness tier overrides in the selected subset", async () => {
    const root = repo();
    const result = await applyRepositorySetup(
      {
        repoRoot: root,
        provider: "claude",
        nonInteractive: true,
        smallTier: "codex:private/model:low",
        maxLaps: 5,
      },
      offline,
    );
    expect(result.archonConfig.tiers?.small).toEqual({
      provider: "codex",
      model: "private/model",
      effort: "low",
    });
    expect(Object.keys(result.archonConfig.assistants!)).toEqual(["claude", "codex"]);
    expect(result.scheduleConfig.max_laps).toBe(5);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid numeric flags before writing (%s)",
    async (value) => {
      const root = repo();
      await expect(
        applyRepositorySetup({ repoRoot: root, nonInteractive: true, parallel: value }, offline),
      ).rejects.toThrow("positive safe integer");
      expect(existsSync(join(root, ".archon"))).toBe(false);
    },
  );

  test("numeric prompts retain default preview and reprompt until a positive safe integer", async () => {
    const root = repo();
    const prompts = new Answers(
      ["codex"],
      ["continue"],
      ["0", "2.5", "9007199254740992", "4", "2", "60"],
    );
    const result = await applyRepositorySetup({ repoRoot: root }, { ...offline, prompts });
    expect(result.scheduleConfig.max_laps).toBe(4);
    expect(result.scheduleConfig.parallel).toBe(2);
    expect(result.scheduleConfig.interval_seconds).toBe(60);
    expect(prompts.notes.filter((note) => note.includes("positive safe integer"))).toHaveLength(3);
  });

  test.each([
    { provider: "unknown" },
    { smallTier: "opencode:vendor/model:ultra" },
    { mediumTier: "codex:" },
    { workWindow: "25:00-06:00" },
  ])("rejects invalid setup values before writing (%j)", async (options) => {
    const root = repo();
    await expect(
      applyRepositorySetup({ repoRoot: root, nonInteractive: true, ...options }, offline),
    ).rejects.toThrow();
    expect(existsSync(join(root, ".archon"))).toBe(false);
  });

  test("config tier rejects effort unsupported by its harness and does not write", async () => {
    const root = repo();
    const code = await runConfigCliCommand({
      repoRoot: root,
      subcommand: "tier",
      positionals: ["config", "tier", "large", "opencode", "vendor/model"],
      effort: "ultra",
      json: true,
    });
    expect(code).toBe(1);
    expect(existsSync(join(root, ".archon"))).toBe(false);
  });

  test("tier editing searches only selected harnesses, uses a real catalog and limits effort to harness vocabulary", async () => {
    const root = repo();
    const prompts = new Answers(
      ["codex", "opencode"],
      ["large", "opencode", "vendor/reasoner", "high", "continue"],
    );
    const result = await applyRepositorySetup(
      { repoRoot: root },
      {
        ...offline,
        prompts,
        catalog: async (provider) => {
          expect(provider).toBe("opencode");
          return { models: [{ id: "vendor/reasoner", name: "Reasoner" }], source: "local CLI" };
        },
      },
    );
    expect(result.archonConfig.tiers?.large).toEqual({
      provider: "opencode",
      model: "vendor/reasoner",
      effort: "high",
    });
    expect(prompts.notes.join("\n")).toContain("Model capabilities unknown");
    const effort = prompts.selections.find((s) => s.message === "Reasoning effort")!;
    expect(effort.choices.map((c) => c.value)).toEqual(["default", "low", "medium", "high"]);
    const harness = prompts.selections.find((s) => s.message.startsWith("Harness ("))!;
    expect(harness.searchable).toBe(true);
    expect(harness.choices.map((c) => c.value)).toEqual(["codex", "opencode"]);
  });

  test("a catalog model without reasoning support does not offer a reasoning selector", async () => {
    const root = repo();
    const prompts = new Answers(["pi"], ["small", "pi", "vendor/plain", "continue"]);
    const result = await applyRepositorySetup(
      { repoRoot: root },
      {
        ...offline,
        prompts,
        catalog: async () => ({
          models: [{ id: "vendor/plain", reasoning: false }],
          source: "local catalog",
        }),
      },
    );
    expect(result.archonConfig.tiers?.small).toEqual({ provider: "pi", model: "vendor/plain" });
    expect(prompts.selections.some((selection) => selection.message === "Reasoning effort")).toBe(
      false,
    );
    expect(prompts.notes.join("\n")).toContain("does not support reasoning");
  });

  test("unavailable catalog explains manual entry and keeps the literal model ID", async () => {
    const root = repo();
    const prompts = new Answers(
      ["codex"],
      ["medium", "codex", "default", "continue"],
      ["private:model-v2"],
    );
    const result = await applyRepositorySetup(
      { repoRoot: root },
      {
        ...offline,
        prompts,
        catalog: async () => ({
          models: [],
          unavailableReason: "No documented model listing command.",
        }),
      },
    );
    expect(result.archonConfig.tiers?.medium).toEqual({
      provider: "codex",
      model: "private:model-v2",
    });
    expect(prompts.notes.join("\n")).toContain("No documented model listing command");
  });

  test("cancellation during tier editing leaves existing config byte-for-byte unchanged", async () => {
    const root = repo();
    writeArchonConfig(root, { assistant: "codex", assistants: { codex: { model: "existing" } } });
    const before = readFileSync(join(root, ".archon/config.yaml"), "utf-8");
    const prompts = new Answers(["codex"]);
    prompts.select = async () => {
      throw new OnboardingCancelled();
    };
    await expect(applyRepositorySetup({ repoRoot: root }, { ...offline, prompts })).rejects.toThrow(
      "cancelled",
    );
    expect(prompts.closed).toBe(true);
    expect(readFileSync(join(root, ".archon/config.yaml"), "utf-8")).toBe(before);
    expect(existsSync(join(root, ".factory"))).toBe(false);
  });

  test("legacy noninteractive setup keeps configured mixed-provider tiers", async () => {
    const root = repo();
    writeArchonConfig(root, {
      assistant: "pi",
      tiers: { large: { provider: "codex", model: "existing-codex", effort: "xhigh" } },
    });
    const result = await applyRepositorySetup({ repoRoot: root, nonInteractive: true }, offline);
    expect(result.archonConfig.tiers?.large).toEqual({
      provider: "codex",
      model: "existing-codex",
      effort: "xhigh",
    });
  });

  test("deselected aliases cannot route a role outside the selected subset, default effort stays unset", async () => {
    const root = repo();
    writeArchonConfig(root, {
      assistant: "claude",
      assistants: { claude: { model: "old" } },
      aliases: { "@old": { provider: "claude", model: "old" } },
    });
    const prompts = new Answers(["codex"], ["large", "codex", "default", "continue"]);
    const result = await applyRepositorySetup(
      { repoRoot: root },
      { ...offline, prompts, catalog: async () => ({ models: [] }) },
    );
    expect(result.archonConfig.aliases?.["@old"]).toBeUndefined();
    expect(result.archonConfig.aliases?.["@reasoning"]?.effort).toBeUndefined();
  });

  test("persists exactly checked harnesses and moves every tier off deselected harnesses", async () => {
    const root = repo();
    writeArchonConfig(root, {
      assistant: "claude",
      assistants: { claude: { model: "old" }, codex: { model: "configured-codex" } },
      tiers: { small: { provider: "claude", model: "old" } },
    });
    const prompts = new Answers(["codex"]);
    const result = await applyRepositorySetup({ repoRoot: root }, { ...offline, prompts });
    const config = readArchonConfig(root);
    expect(Object.keys(config.assistants!)).toEqual(["codex"]);
    expect(Object.values(config.tiers!).map((b) => b.provider)).toEqual([
      "codex",
      "codex",
      "codex",
    ]);
    expect(config.assistant).toBe("codex");
    expect(result.archonConfig.tiers?.medium?.model).toBe("configured-codex");
    expect(prompts.closed).toBe(true);
    expect(prompts.initiallyChecked).toEqual(["claude", "codex"]);
  });
});
