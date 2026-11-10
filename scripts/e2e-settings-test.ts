import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { serve } from "bun";
import { SettingsService } from "../apps/backend/src/settings/service";
import { handleSettingsRoute } from "../apps/backend/src/settings/routes";
import { HarnessService, handleHarnessRoute } from "../apps/backend/src/harness";

const PORT = 3592;
const DIST = resolve("apps/web/dist");
const EVIDENCE_DIR = resolve("docs/design/evidence/settings");
mkdirSync(EVIDENCE_DIR, { recursive: true });

// Setup test isolated directories
const testUserAnimusDir = join(tmpdir(), `animus-e2e-user-${Date.now()}`);
const testRepoDir = join(tmpdir(), `animus-e2e-repo-${Date.now()}`);
mkdirSync(testUserAnimusDir, { recursive: true });
mkdirSync(join(testRepoDir, ".animus"), { recursive: true });
mkdirSync(join(testRepoDir, ".factory"), { recursive: true });

// Initialize isolated repo files
writeFileSync(
  join(testRepoDir, ".animus/config.yaml"),
  stringifyYaml({
    assistant: "pi",
    assistants: { pi: { model: "default" } },
    tiers: {
      small: { provider: "pi", model: "default", effort: "medium" },
      medium: { provider: "pi", model: "default", effort: "high" },
      large: { provider: "pi", model: "default", effort: "high" },
    },
    aliases: {
      "@reasoning": { provider: "pi", model: "default", effort: "high" },
    },
    worktree: { baseBranch: "main" },
    models: {
      defaultModel: "claude-3-7-sonnet",
      concurrencyLimit: 2,
    },
  }),
  "utf-8",
);

writeFileSync(
  join(testRepoDir, ".factory/tool-guidance.json"),
  JSON.stringify(
    {
      staticCmd: "bun run check",
      unitCmd: "bun test",
      countPattern: "Tests\\s+(\\d+)\\s+passed",
      protectedPaths: ["MISSION.md", "FACTORY.md", "harness/**"],
    },
    null,
    2,
  ),
  "utf-8",
);

const initialLessons = [
  {
    id: "les-094",
    topic: "Monitor lock recovery",
    trigger_patterns: ["apps/backend/src/monitor/**"],
    rule: "Verify the owner PID is no longer running before reclaiming a monitor lock.",
    evidence: "3 occurrences in monitor recovery logs",
    vetoed: false,
    occurrence_count: 3,
    created_at: "2026-03-30T10:00:00Z",
  },
  {
    id: "les-088",
    topic: "SQLite busy timeout",
    trigger_patterns: ["apps/backend/src/registry/db.ts"],
    rule: "Set PRAGMA busy_timeout = 5000 on shared SQLite connections.",
    evidence: "2 occurrences in registry timeout logs",
    vetoed: false,
    occurrence_count: 2,
    created_at: "2026-03-30T10:00:00Z",
  },
  {
    id: "les-071",
    topic: "Legacy aliases",
    trigger_patterns: ["packages/contracts/**"],
    rule: "Retain backward-compatible aliases when renaming internal helpers.",
    evidence: "Clean Cutover conflict",
    vetoed: true,
    occurrence_count: 1,
    created_at: "2026-03-30T10:00:00Z",
  },
];

writeFileSync(
  join(testRepoDir, ".factory/lessons.jsonl"),
  initialLessons.map((l) => JSON.stringify(l)).join("\n") + "\n",
  "utf-8",
);

const settingsService = new SettingsService({
  userAnimusDir: testUserAnimusDir,
  defaultRepoRoot: testRepoDir,
});
const harnessService = new HarnessService(testRepoDir);

// Start combined test server
const server = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // 1. Settings Routes
    if (path.startsWith("/api/v1/settings/") || path.startsWith("/api/settings/")) {
      const res = await handleSettingsRoute(req, path, { settingsService });
      if (res) return res;
    }

    // 2. Health
    if (path === "/api/v1/health" || path === "/health") {
      return Response.json({
        status: "healthy",
        buildId: "test-build-e2e",
        host: { status: "healthy", buildId: "test-build-e2e" },
      });
    }

    // 3. Projects
    if (path === "/api/v1/projects") {
      return Response.json([
        {
          id: "proj-animus-e2e",
          name: "animus",
          repo_id: 1,
          repo_name: "animus",
          checkout_path: testRepoDir,
          status: "active",
        },
      ]);
    }

    // 4. Brakes
    if (path === "/api/v1/brakes") {
      if (req.method === "POST") {
        return Response.json({ global_launch_brake: true });
      }
      return Response.json({ global_launch_brake: false });
    }

    if (path.includes("/brakes")) {
      return Response.json({ schedule_pause: false });
    }

    // 5. Harness lessons
    if (path.startsWith("/api/v1/harness/") || path.startsWith("/api/harness/")) {
      const res = await handleHarnessRoute(req, path, harnessService);
      if (res) return res;
    }

    // 6. Board & Jobs
    if (path.includes("/board")) {
      return Response.json({
        board: { lanes: [], totalJobs: 0 },
        projects: [],
      });
    }

    // 7. Commands (Backup & Reconcile)
    if (path.includes("/commands/backup") || path.includes("/workspace/backup")) {
      return Response.json({ ok: true, destinationPath: "backups/console-snapshot.db" });
    }
    if (path.includes("/commands/reconcile")) {
      return Response.json({ ok: true, reconciledCount: 0 });
    }

    // 8. Static Web Assets
    let filePath = `${DIST}${url.pathname}`;
    if (url.pathname === "/" || !url.pathname.includes(".")) {
      filePath = `${DIST}/index.html`;
    }
    const file = Bun.file(filePath);
    return new Response(file);
  },
});

console.log(`E2E Test Server listening at http://localhost:${PORT}`);

// Create a standalone Node script that imports playwright and performs the complete test suite
const testRunnerCode = `
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = ${PORT};
const EVIDENCE_DIR = "${EVIDENCE_DIR}";
const testUserAnimusDir = "${testUserAnimusDir}";
const testRepoDir = "${testRepoDir}";

async function run() {
  console.log("Launching Chromium for Settings E2E Verification...");
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  const results = [];

  try {
    // =========================================================================
    // Scenario 1: Scope Navigation & Section Defaults
    // =========================================================================
    console.log("Scenario 1: Testing Scope Navigation (Personal, Platform, Project)...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=personal&section=preferences\`);
    await page.waitForSelector('text=Settings', { timeout: 8000 });
    await page.waitForSelector('text=Personal', { timeout: 5000 });

    // Verify Scope Tabs exist
    const personalTab = page.locator('button:has-text("Personal")').first();
    const platformTab = page.locator('button:has-text("Platform")').first();
    const projectTab = page.locator('button:has-text("Project")').first();

    assert(await personalTab.isVisible(), "Personal scope tab must be visible");
    assert(await platformTab.isVisible(), "Platform scope tab must be visible");
    assert(await projectTab.isVisible(), "Project scope tab must be visible");

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '01-personal-preferences.png') });
    results.push({ name: "Personal Preferences Layout", status: "PASS", evidence: "01-personal-preferences.png" });

    // =========================================================================
    // Scenario 2: Personal Preferences Interaction & Disk Persistence
    // =========================================================================
    console.log("Scenario 2: Testing Personal Preferences controls & disk persistence...");
    // Select Card density -> compact
    const densitySelect = page.locator('#settings-density');
    await densitySelect.selectOption('compact');

    // Select Startup view -> jobs
    const startupSelect = page.locator('#settings-startup');
    await startupSelect.selectOption('jobs');

    // Toggle Notifications
    const notifySelect = page.locator('#settings-notify-attention');
    await notifySelect.selectOption('off');

    // Click "Save changes"
    const saveButton = page.locator('button:has-text("Save changes")');
    await saveButton.click();

    // Verify modal closes
    await page.waitForTimeout(600);
    const modalGone = await page.locator('text=Discard unsaved changes?').count() === 0;
    assert(modalGone, "Modal must close on save");

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '10-interactive-save.png') });
    results.push({ name: "Personal Preferences Update & Save", status: "PASS", evidence: "10-interactive-save.png" });

    // Assert disk persistence in ~/.animus/preferences.json
    const prefDiskPath = path.join(testUserAnimusDir, 'preferences.json');
    assert(fs.existsSync(prefDiskPath), "preferences.json must exist on disk");
    const prefData = JSON.parse(fs.readFileSync(prefDiskPath, 'utf-8'));
    assert.strictEqual(prefData.cardDensity, 'compact', 'cardDensity must be compact on disk');
    assert.strictEqual(prefData.startupView, 'jobs', 'startupView must be jobs on disk');
    assert.strictEqual(prefData.notifyNeedsAttention, false, 'notifyNeedsAttention must be false on disk');
    console.log("  ✓ preferences.json verified on disk:", prefData);

    // =========================================================================
    // Scenario 3: Platform / System (Security, Backup, Reconcile)
    // =========================================================================
    console.log("Scenario 3: Testing Platform / System features...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=platform&section=system\`);
    await page.waitForSelector('text=Security', { timeout: 5000 });
    await page.waitForSelector('text=Remote access', { timeout: 5000 });
    await page.waitForSelector('text=Database backup', { timeout: 5000 });

    // Test Backup action
    const backupBtn = page.locator('button:has-text("Create backup")');
    await backupBtn.click();
    await page.waitForTimeout(600);

    // Test Reconcile action
    const reconcileBtn = page.locator('button:has-text("Reconcile now")');
    await reconcileBtn.click();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '02-platform-system.png') });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '11-interactive-backup.png') });
    results.push({ name: "Platform System & Operations", status: "PASS", evidence: "02-platform-system.png" });

    // =========================================================================
    // Scenario 4: Platform / Providers (Primary provider & toggles)
    // =========================================================================
    console.log("Scenario 4: Testing Platform / Providers & disk persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=platform&section=providers\`);
    await page.waitForSelector('text=Platform defaults', { timeout: 5000 });
    await page.waitForSelector('text=Available providers', { timeout: 5000 });
    await page.waitForSelector('text=Pi Coding Agent', { timeout: 5000 });

    const primarySelect = page.locator('#settings-primary-provider');
    await primarySelect.selectOption('claude');
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '03-platform-providers.png') });
    results.push({ name: "Platform Providers Management", status: "PASS", evidence: "03-platform-providers.png" });

    // Assert disk persistence in config.json
    const configDiskPath = path.join(testUserAnimusDir, 'config.json');
    assert(fs.existsSync(configDiskPath), "config.json must exist on disk");
    const configData1 = JSON.parse(fs.readFileSync(configDiskPath, 'utf-8'));
    assert.strictEqual(configData1.system.defaultProvider, 'claude', 'defaultProvider must be claude in config.json');
    console.log("  ✓ config.json providers verified on disk");

    // =========================================================================
    // Scenario 5: Platform / Automation (Capacity, Work window, Brakes)
    // =========================================================================
    console.log("Scenario 5: Testing Platform / Automation & disk persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=platform&section=automation\`);
    await page.waitForSelector('text=Capacity', { timeout: 5000 });
    await page.waitForSelector('text=Work window', { timeout: 5000 });
    await page.waitForSelector('text=Launch controls', { timeout: 5000 });

    const parallelSelect = page.locator('#settings-parallel-jobs');
    await parallelSelect.selectOption('4');
    const maxLapsSelect = page.locator('#settings-max-laps');
    await maxLapsSelect.selectOption('5');
    const pollIntervalSelect = page.locator('#settings-poll-interval');
    await pollIntervalSelect.selectOption('60');
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '04-platform-automation.png') });
    results.push({ name: "Platform Automation & Brakes", status: "PASS", evidence: "04-platform-automation.png" });

    // Assert disk persistence in config.json
    const configData2 = JSON.parse(fs.readFileSync(configDiskPath, 'utf-8'));
    assert.strictEqual(configData2.automation.parallelJobs, 4, 'parallelJobs must be 4 in config.json');
    assert.strictEqual(configData2.automation.maxLaps, 5, 'maxLaps must be 5 in config.json');
    assert.strictEqual(configData2.automation.pollInterval, 60, 'pollInterval must be 60 in config.json');
    console.log("  ✓ config.json automation verified on disk:", configData2.automation);

    // =========================================================================
    // Scenario 6: Platform / GitHub (Wake event toggles & disk persistence)
    // =========================================================================
    console.log("Scenario 6: Testing Platform / GitHub & disk persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=platform&section=github\`);
    await page.waitForSelector('text=Connection', { timeout: 5000 });
    await page.waitForSelector('text=Wake events', { timeout: 5000 });

    const reviewEventSwitch = page.locator('[data-testid="settings-github-review-event"]');
    await reviewEventSwitch.click();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '05-platform-github.png') });
    results.push({ name: "Platform GitHub Integration", status: "PASS", evidence: "05-platform-github.png" });

    const configData3 = JSON.parse(fs.readFileSync(configDiskPath, 'utf-8'));
    assert.strictEqual(configData3.github.reviewEvent, false, 'reviewEvent must be false in config.json');
    console.log("  ✓ config.json github verified on disk:", configData3.github);

    // =========================================================================
    // Scenario 7: Project / Models (Dynamic Harness, Models & Reasoning Effort)
    // =========================================================================
    console.log("Scenario 7: Testing Project / Models (Harness, Dynamic Models, Reasoning Effort) & .animus/config.yaml persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=project&section=models\`);
    await page.waitForSelector('text=Model tiers', { timeout: 5000 });
    await page.waitForSelector('text=Role routing', { timeout: 5000 });

    // Select Harness: claude
    const harnessSelect = page.locator('#settings-harness-provider');
    await harnessSelect.selectOption('claude');
    await page.waitForTimeout(600);

    // Dynamic models loaded for Claude! Select claude-3-5-sonnet
    const modelSelect = page.locator('#settings-default-model');
    await modelSelect.selectOption('claude-3-5-sonnet');

    // Select Reasoning Effort: high
    const effortSelect = page.locator('#settings-reasoning-effort');
    await effortSelect.selectOption('high');

    // Select Concurrency Limit: 4
    const concurrencySelect = page.locator('#settings-concurrency-limit');
    await concurrencySelect.selectOption('4');
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '06-project-models.png') });
    results.push({ name: "Project Models, Dynamic Harness & Efforts", status: "PASS", evidence: "06-project-models.png" });

    const animusYamlPath = path.join(testRepoDir, '.animus/config.yaml');
    assert(fs.existsSync(animusYamlPath), ".animus/config.yaml must exist on disk");
    const yamlContent = fs.readFileSync(animusYamlPath, 'utf-8');
    assert(yamlContent.includes('assistant: claude'), ".animus/config.yaml must contain assistant: claude");
    assert(yamlContent.includes('claude-3-5-sonnet'), ".animus/config.yaml must contain claude-3-5-sonnet");
    assert(yamlContent.includes('concurrencyLimit: 4'), ".animus/config.yaml must contain concurrencyLimit: 4");
    assert(yamlContent.includes('effort: high'), ".animus/config.yaml must contain effort: high");
    console.log("  ✓ .animus/config.yaml verified on disk with dynamic harness & reasoning effort");

    // =========================================================================
    // Scenario 8: Project / Checks (Verification Commands & tool-guidance.json)
    // =========================================================================
    console.log("Scenario 8: Testing Project / Checks & tool-guidance.json persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=project&section=checks\`);
    await page.waitForSelector('text=Verification commands', { timeout: 5000 });
    await page.waitForSelector('text=Harness health', { timeout: 5000 });

    const staticCheckInput = page.locator('input[type="text"]').first();
    await staticCheckInput.fill('bun run check:custom');
    await staticCheckInput.blur();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '07-project-checks.png') });
    results.push({ name: "Project Checks & Harness Health", status: "PASS", evidence: "07-project-checks.png" });

    const toolGuidancePath = path.join(testRepoDir, '.factory/tool-guidance.json');
    assert(fs.existsSync(toolGuidancePath), ".factory/tool-guidance.json must exist on disk");
    const guidanceData = JSON.parse(fs.readFileSync(toolGuidancePath, 'utf-8'));
    assert.strictEqual(guidanceData.staticCmd, 'bun run check:custom', 'staticCmd must be bun run check:custom');
    console.log("  ✓ .factory/tool-guidance.json verified on disk:", guidanceData);

    // =========================================================================
    // Scenario 9: Project / Memory (Lessons Learned & Veto Interaction)
    // =========================================================================
    console.log("Scenario 9: Testing Project / Memory & lessons.jsonl persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=project&section=memory\`);
    await page.waitForSelector('text=Evidence-backed lessons', { timeout: 5000 });
    await page.waitForSelector('text=Monitor lock recovery', { timeout: 5000 });

    const vetoButton = page.locator('button:has-text("Veto lesson")').first();
    assert(await vetoButton.isVisible(), "Veto lesson button must be visible");
    await vetoButton.click();
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '08-project-memory.png') });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, '12-interactive-veto.png') });
    results.push({ name: "Project Memory & Veto Governance", status: "PASS", evidence: "08-project-memory.png" });

    const lessonsPath = path.join(testRepoDir, '.factory/lessons.jsonl');
    assert(fs.existsSync(lessonsPath), ".factory/lessons.jsonl must exist on disk");
    const lessonsLines = fs.readFileSync(lessonsPath, 'utf-8').trim().split('\\n');
    const les94 = JSON.parse(lessonsLines.find(l => l.includes('les-094')));
    assert.strictEqual(les94.vetoed, true, 'les-094 must be vetoed on disk in lessons.jsonl');
    console.log("  ✓ .factory/lessons.jsonl veto verified on disk:", les94);

    // =========================================================================
    // Scenario 10: Project / Releases (Pipeline strategy & .animus/config.yaml)
    // =========================================================================
    console.log("Scenario 10: Testing Project / Releases & config.yaml persistence...");
    await page.goto(\`http://localhost:\${PORT}/?settings=true&scope=project&section=releases\`);
    await page.waitForSelector('text=Merge policy', { timeout: 5000 });
    await page.waitForSelector('text=Promotion', { timeout: 5000 });

    const completionSelect = page.locator('#settings-completion-mode');
    await completionSelect.selectOption('auto');
    const mergeMethodSelect = page.locator('#settings-merge-method');
    await mergeMethodSelect.selectOption('rebase');
    await page.waitForTimeout(600);

    await page.screenshot({ path: path.join(EVIDENCE_DIR, '09-project-releases.png') });
    results.push({ name: "Project Release Pipelines", status: "PASS", evidence: "09-project-releases.png" });

    const updatedYaml = fs.readFileSync(animusYamlPath, 'utf-8');
    assert(updatedYaml.includes('completionMode: auto'), "config.yaml must contain completionMode: auto");
    assert(updatedYaml.includes('mergeMethod: rebase'), "config.yaml must contain mergeMethod: rebase");
    console.log("  ✓ .animus/config.yaml releases verified on disk");

    console.log("\\n=======================================================");
    console.log("ALL E2E SCENARIOS & DISK MUTATIONS PASSED CLEANLY!");
    console.log("=======================================================");
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((err) => {
  console.error("E2E Test Failure:", err);
  process.exit(1);
});
`;

const runnerPath = join(tmpdir(), "animus-settings-e2e-runner.js");
writeFileSync(runnerPath, testRunnerCode, "utf-8");

console.log("Running Playwright test suite via Node...");
const nodeProc = spawn("node", [runnerPath], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_PATH: "/Users/efishery/.vite-plus/js_runtime/node/24.17.0/lib/node_modules",
  },
});

nodeProc.on("close", (code) => {
  server.stop();
  try {
    rmSync(testUserAnimusDir, { recursive: true, force: true });
    rmSync(testRepoDir, { recursive: true, force: true });
    rmSync(runnerPath, { force: true });
  } catch {}

  if (code === 0) {
    console.log("E2E Settings Test Suite Passed Cleanly (Code 0)!");
    process.exit(0);
  } else {
    console.error(`E2E Settings Test Suite Failed with exit code ${code}`);
    process.exit(code ?? 1);
  }
});
