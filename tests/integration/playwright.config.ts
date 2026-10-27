import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.test.ts",
  workers: 1,
  timeout: 30000,
  use: { browserName: "chromium", headless: true },
});
