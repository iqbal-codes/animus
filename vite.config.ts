import { defineConfig } from "vite-plus";
import { builtinModules } from "node:module";

if (process.versions.bun) throw new Error("Vite+ tooling requires Node");

export default defineConfig({
  lint: {
    ignorePatterns: [
      "**/node_modules/**",
      "**/dist/**",
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
    exclude: ["**/*.bun.test.ts"],
  },
  run: {
    tasks: {
      "neutral-suite": { command: "vp test run", cache: false },
      "bun-suite": {
        command:
          "bun test --timeout 30000 tests/integration/local-loop-deadlines.bun.test.ts tests/integration/scheduler-discovery.bun.test.ts tests/integration/onboarding-http.bun.test.ts tests/integration/loop-script.bun.test.ts tests/integration/loop-watch.bun.test.ts tests/integration/loop-modules.bun.test.ts tests/integration/health.bun.test.ts tests/integration/local-loop.bun.test.ts tests/integration/onboarding-monitor.bun.test.ts",
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
