import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = process.argv[2];
if (!scratch) throw new Error("Supply an existing disposable scratch parent outside the checkout");
const checkout = mkdtempSync(`${resolve(scratch)}/health-qualification-`);
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("git", ["worktree", "add", "--detach", checkout, head], {
  cwd: root,
  stdio: "inherit",
});

/** @param {string[]} argv @param {string} [expected] */
function run(argv, expected) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: checkout,
    encoding: "utf8",
    timeout: 60000,
    env: process.env,
  });
  const output = result.stdout + result.stderr;
  if (
    result.error ||
    result.signal ||
    (expected ? result.status === 0 || !output.includes(expected) : result.status !== 0)
  ) {
    throw new Error(`${argv.join(" ")} did not meet expected ${expected ?? "success"}: ${output}`);
  }
  console.log(`PASS ${argv.join(" ")}${expected ? ` rejects ${expected}` : ""}`);
}
/** @param {string} path @param {string} text @param {() => void} check */
function mutation(path, text, check) {
  const full = `${checkout}/${path}`;
  const original = readFileSync(full, "utf8");
  writeFileSync(full, text);
  try {
    check();
  } finally {
    writeFileSync(full, original);
  }
}
try {
  run(["bun", "install", "--frozen-lockfile"]);
  const lock = readFileSync(`${checkout}/bun.lock`, "utf8");
  run(["bun", "install", "--frozen-lockfile"]);
  if (readFileSync(`${checkout}/bun.lock`, "utf8") !== lock)
    throw new Error("Frozen install changed lock");
  run(["bun", "run", "toolchain"]);
  run(["bun", "run", "check"]);
  const scopes = [
    "apps/backend/src/main.ts",
    "apps/engine-host/src/main.ts",
    "packages/contracts/src/operator.ts",
    "packages/client/src/index.ts",
    "tests/integration/health.bun.test.ts",
    "tests/integration/client.test.ts",
    "vite.config.ts",
    "scripts/health/check-toolchain.mjs",
  ];
  for (const path of scopes) {
    const original = readFileSync(`${checkout}/${path}`, "utf8");
    mutation(path, `${original}\nexport const qualificationBadFormat={a:1,b:2}\n`, () =>
      run(["bun", "run", "format"], path),
    );
    mutation(path, `${original}\ndebugger;\n`, () => run(["bun", "run", "lint"], "no-debugger"));
    const typeError = path.endsWith(".mjs")
      ? '\n/** @type {number} */\nexport const qualificationType = "wrong";\n'
      : '\nexport const qualificationType: number = "wrong";\n';
    mutation(path, `${original}${typeError}`, () => run(["bun", "run", "typecheck"], "TS2322"));
  }
  for (const [path, statement] of [
    ["packages/client/src/index.ts", 'import "node:fs";'],
    ["packages/contracts/src/operator.ts", 'import "./host";'],
    ["packages/contracts/src/health.ts", 'import "./host";'],
    ["apps/backend/src/main.ts", 'import "../../engine-host/src/config";'],
  ]) {
    mutation(path, `${readFileSync(`${checkout}/${path}`, "utf8")}\n${statement}\n`, () =>
      run(["bun", "run", "lint"], "no-restricted-imports"),
    );
  }
  const contract = "packages/contracts/src/health.ts";
  mutation(
    contract,
    readFileSync(`${checkout}/${contract}`, "utf8").replace(
      "buildId: z.string()",
      "buildId: z.number()",
    ),
    () => run(["bun", "run", "typecheck"], "packages/client/src/index.ts"),
  );

  const privateContract = "packages/contracts/src/host.ts";
  mutation(
    privateContract,
    readFileSync(`${checkout}/${privateContract}`, "utf8").replace(
      "export const hostHealthSchema = serviceHealthSchema;",
      "export const hostHealthSchema = serviceHealthSchema.extend({ drift: z.string() });",
    ),
    () => run(["bun", "run", "typecheck"], "tests/integration/client.test.ts"),
  );

  const configPath = "vite.config.ts";
  const config = readFileSync(`${checkout}/${configPath}`, "utf8");
  for (const [suite, path, assertion, diagnostic] of [
    [
      "neutral-suite",
      "tests/integration/client.test.ts",
      'test("qualification deliberate failure", () => { expect(1).toBe(2); });',
      "qualification deliberate failure",
    ],
    [
      "bun-suite",
      "tests/integration/health.bun.test.ts",
      'test("qualification deliberate failure", () => { expect(1).toBe(2); });',
      "qualification deliberate failure",
    ],
  ]) {
    const full = `${checkout}/${path}`;
    const original = existsSync(full) ? readFileSync(full, "utf8") : "";
    writeFileSync(full, `${original}\n${assertion}\n`);
    // Isolate the failing runner, preserving the aggregate dependency edges without rerunning unrelated suites.
    const isolated = config
      .replace('dependsOn: ["neutral-suite", "bun-suite"]', `dependsOn: ["${suite}"]`)
      .replace(
        'dependsOn: ["toolchain-check", "static-check", "test-all"]',
        'dependsOn: ["test-all"]',
      )
      .replace(
        'command: "vp test run"',
        'command: "vp test run -t \\\"qualification deliberate failure\\\""',
      )
      .replace(
        'command: "bun test tests/integration/health.bun.test.ts"',
        'command: "bun test tests/integration/health.bun.test.ts -t \\\"qualification deliberate failure\\\""',
      );
    if (isolated === config) throw new Error("Qualification could not isolate aggregate");
    try {
      mutation(configPath, isolated, () => {
        run(["bun", "run", "test"], diagnostic);
        run(["bun", "run", "verify"], diagnostic);
      });
    } finally {
      writeFileSync(full, original);
    }
  }
  run(["bun", "run", "check"]);
  console.log(
    `Qualification passed for ${head}; negative controls were confined to detached disposable source.`,
  );
} finally {
  execFileSync("git", ["worktree", "remove", "--force", checkout], { cwd: root, stdio: "inherit" });
}
