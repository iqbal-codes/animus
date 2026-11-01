import { defineConfig } from "vite-plus";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

if (process.versions.bun) throw new Error("Vite+ tooling requires Node");

export default defineConfig({
  plugins: [
    {
      name: "animus-prompt-text",
      enforce: "pre",
      async load(id) {
        if (!id.endsWith(".md") || !id.includes("/scripts/prompts/")) return null;
        return `export default ${JSON.stringify(await readFile(id, "utf8"))};`;
      },
    },
  ],
  lint: {
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "assets/**",
      ".animus/**",
      ".factory/**",
      "harness/**",
    ],
    options: { typeAware: true, typeCheck: true },
    rules: { "no-debugger": "error" },
    overrides: [
      {
        files: ["apps/**/*.{ts,tsx,js,jsx}", "packages/**/*.{ts,tsx,js,jsx}"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              patterns: [
                "@animus/backend",
                "@animus/backend/*",
                "@animus/engine-host",
                "@animus/engine-host/*",
                "**/apps/**",
                "**/packages/**",
                "../../*",
                "../../**",
              ],
            },
          ],
        },
      },
      {
        files: [
          "apps/web/src/**/*.{ts,tsx,js,jsx}",
          "packages/client/src/**/*.{ts,js}",
          "packages/contracts/src/operator.ts",
          "packages/contracts/src/health.ts",
        ],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: [...builtinModules, "@animus/contracts/host"],
              patterns: [
                "node:*",
                "bun",
                "bun:*",
                "@animus/backend*",
                "@animus/engine-host*",
                "**/apps/**",
                "**/packages/**",
                "**/config",
                "**/config.*",
                "**/host",
                "**/host.*",
                "../../*",
                "../../**",
              ],
            },
          ],
        },
      },
    ],
  },
  fmt: { ignorePatterns: ["**/node_modules/**", "**/dist/**"] },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/*.test.ts", "tests/integration/*.test.tsx"],
    exclude: ["**/*.bun.test.ts"],
  },
  run: {
    tasks: {
      "neutral-suite": { command: "vp test run", cache: false },
      "bun-suite": {
        command:
          "bun test --timeout 30000 tests/integration/local-loop-deadlines.bun.test.ts tests/integration/scheduler-discovery.bun.test.ts tests/integration/onboarding-http.bun.test.ts tests/integration/loop-script.bun.test.ts tests/integration/loop-watch.bun.test.ts tests/integration/loop-modules.bun.test.ts tests/integration/health.bun.test.ts tests/integration/local-loop.bun.test.ts tests/integration/onboarding-monitor.bun.test.ts tests/integration/loop-ci.bun.test.ts tests/integration/loop-report-schema.bun.test.ts tests/integration/loop-pr-reporting.bun.test.ts tests/integration/loop-evidence-cli.bun.test.ts tests/integration/loop-dossier-findings.bun.test.ts tests/integration/loop-publication.bun.test.ts",
        cache: false,
      },
      "toolchain-check": { command: "node scripts/health/check-toolchain.mjs", cache: false },
      "static-check": { command: "bun run check", cache: false },
      "verify-all": {
        command: "node -e \"console.log('Verification passed')\"",
        dependsOn: ["toolchain-check", "static-check", "test-all"],
        cache: false,
      },
      "test-all": {
        command: "node -e \"console.log('All suites passed')\"",
        dependsOn: ["neutral-suite", "bun-suite"],
        cache: false,
      },
    },
  },
});
