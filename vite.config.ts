import { defineConfig } from "vite-plus";
import { builtinModules } from "node:module";

if (process.versions.bun) throw new Error("Vite+ tooling requires Node");

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
      "web/**",
      "assets/**",
      ".archon/**",
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
                "@labq/backend",
                "@labq/backend/*",
                "@labq/engine-host",
                "@labq/engine-host/*",
                "@labq/web",
                "@labq/web/*",
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
              paths: [...builtinModules, "@labq/contracts/host"],
              patterns: [
                "node:*",
                "bun",
                "bun:*",
                "@labq/backend*",
                "@labq/engine-host*",
                "@labq/web*",
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
  test: {
    include: ["tests/integration/*.test.ts"],
    exclude: ["**/*.bun.test.ts", "**/*.browser.test.ts"],
  },
  run: {
    tasks: {
      "neutral-suite": { command: "vp test run", cache: false },
      "bun-suite": {
        command:
          "bun test tests/integration/health.bun.test.ts tests/integration/control-worktree.bun.test.ts",
        cache: false,
      },
      "web-artifacts": { command: "node scripts/health/build-and-inspect.mjs", cache: false },
      "browser-suite": {
        command:
          "node node_modules/@playwright/test/cli.js test --config tests/integration/playwright.config.ts",
        dependsOn: ["web-artifacts"],
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
        dependsOn: ["neutral-suite", "bun-suite", "browser-suite"],
        cache: false,
      },
    },
  },
});
