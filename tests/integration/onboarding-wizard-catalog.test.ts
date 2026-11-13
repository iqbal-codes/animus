import { describe, expect, test } from "vitest";
import { createModelCatalogLoader } from "../../scripts/cli/commands/onboarding-model-catalog";

describe("onboarding model catalog", () => {
  test("Pi catalog preserves provider-qualified IDs and reported capabilities without adding models", async () => {
    const catalog = createModelCatalogLoader(async (binary, args) => {
      expect(binary).toBe("pi");
      expect(args).toContain("--offline");
      expect(args).toContain("--no-extensions");
      expect(args).toContain("--no-mcp");
      expect(args).toContain("--no-approve");
      return "provider model context max-out thinking images\nlocal test-reasoner 32K 8K yes no\nrouter vendor/text 128K 16K no yes\n";
    });
    const result = await catalog("pi");
    expect(result.models.map((m) => m.id)).toEqual(["local/test-reasoner", "router/vendor/text"]);
    expect(result.models[0]?.capabilities).toBe(
      "Context: 32K; max output: 8K; thinking: yes; images: no (reported by Pi)",
    );
  });

  test("OpenCode uses its documented models command and never claims unknown capabilities", async () => {
    const catalog = createModelCatalogLoader(async (binary, args) => {
      expect(binary).toBe("opencode");
      expect(args).toEqual(["models", "--standalone"]);
      return "vendor/reasoner\nrouter/provider/model\n";
    });
    expect((await catalog("opencode")).models).toEqual([
      { id: "vendor/reasoner" },
      { id: "router/provider/model" },
    ]);
  });

  test("Command Code uses its documented list-models output and drops section noise", async () => {
    const catalog = createModelCatalogLoader(async (binary, args) => {
      expect(binary).toBe("commandcode");
      expect(args).toEqual(["--list-models"]);
      return [
        "",
        "Available models  ·  3 models",
        "",
        "Open Source",
        "",
        "deepseek/deepseek-v4-pro                hybrid-attention long-context reasoning",
        "z-ai/glm-5.3-flash                      fast, affordable GLM coding with 1M context",
        "",
        'Pass the full id, or just the short name after the last "/":',
        "cmd --model kimi-k2.5",
        "",
        "Decision models (headless only)",
        "typesafe/jev  typed questions in, probabilities out",
        "",
      ].join("\n");
    });
    expect((await catalog("commandcode")).models).toEqual([
      {
        id: "deepseek/deepseek-v4-pro",
        name: "hybrid-attention long-context reasoning",
      },
      {
        id: "z-ai/glm-5.3-flash",
        name: "fast, affordable GLM coding with 1M context",
      },
    ]);
  });

  test("OMP uses its documented models --json command and preserves selectors and capabilities", async () => {
    const catalog = createModelCatalogLoader(async (binary, args) => {
      expect(binary).toBe("omp");
      expect(args).toEqual(["models", "--json"]);
      return JSON.stringify({
        models: [
          {
            provider: "9router",
            id: "ag/gemini-3.8-flash",
            selector: "9router/ag/gemini-3.8-flash",
            contextWindow: 1000000,
            maxTokens: 128000,
            reasoning: true,
            input: ["text", "image"],
          },
        ],
      });
    });
    const result = await catalog("omp");
    expect(result.source).toBe("omp models --json");
    expect(result.models).toEqual([
      {
        id: "9router/ag/gemini-3.8-flash",
        reasoning: true,
        capabilities:
          "Context: 1000000; max output: 128000; thinking: yes; input: text,image (reported by OMP)",
      },
    ]);
  });

  test.each(["claude", "codex"] as const)(
    "unsupported catalog for %s never launches a provider command",
    async (provider) => {
      const catalog = createModelCatalogLoader(async () => {
        throw new Error("Must not launch");
      });
      expect(await catalog(provider)).toMatchObject({
        models: [],
        unavailableReason: expect.stringContaining("Enter a model ID manually"),
      });
    },
  );

  test.each([
    "No available models\n",
    "provider model context max-out thinking images\n",
    "unrecognized output",
  ])("empty or changed output offers manual entry (%s)", async (output) => {
    const result = await createModelCatalogLoader(async () => output)("pi");
    expect(result.models).toEqual([]);
    expect(result.unavailableReason).toContain("Enter a model ID manually");
  });

  test("provider command failure reports unavailable rather than inventing fallback models", async () => {
    const result = await createModelCatalogLoader(async () => {
      throw new Error("command timed out");
    })("pi");
    expect(result.models).toEqual([]);
    expect(result.unavailableReason).toContain("command timed out");
  });
});
