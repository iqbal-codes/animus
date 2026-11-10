import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { initializeDatabase } from "../../apps/backend/src/registry/db";
import { ProjectRegistryService, SyntheticForgeAdapter } from "../../apps/backend/src/registry";
import { PlanService } from "../../apps/backend/src/plans";
import { CommandLedger } from "../../apps/backend/src/command/ledger";
import { BrakeService } from "../../apps/backend/src/command/brakes";
import { DispatchService } from "../../apps/backend/src/dispatch";
import { ExecutionObservationService } from "../../apps/backend/src/evidence";
import { ExecutionBudgetService } from "../../apps/backend/src/work/budget";
import { seedActivatedAuthority } from "./support/activated-authority";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ORIGINAL_ANIMUS_HOME = process.env.ANIMUS_HOME;
const ORIGINAL_ANIMUS_STATE_DIR = process.env.ANIMUS_STATE_DIR;
const REPO = "owner/delivery-claim-cross-process";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function specBody(): string {
  return [
    "## Source and problem",
    "",
    "s",
    "",
    "## Outcome",
    "",
    "o",
    "",
    "## Invariants",
    "",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1 — parent one",
    "",
    "## Boundary",
    "",
    "b",
  ].join("\n");
}

function ticketBody(partOf: number): string {
  return [
    `Part of #${partOf}`,
    "",
    "Source acceptance coverage: AC1",
    "",
    "## Source and problem",
    "",
    "s",
    "",
    "## Outcome",
    "",
    "o",
    "",
    "## Invariants",
    "",
    "- i",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] AC1: child",
    "",
    "## Boundary",
    "",
    "b",
    "",
    "Depends on: None",
  ].join("\n");
}

describe("delivery-role claim across two OS processes", () => {
  let root: string;
  let stateDir: string;
  let checkoutPath: string;
  let bareOrigin: string;
  let artifactRoot: string;
  let projectId: string;
  let planId: string;
  let scripts: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "animus-delivery-claim-xproc-"));
    const home = join(root, "home");
    stateDir = join(home, "state");
    mkdirSync(stateDir, { recursive: true });
    process.env.ANIMUS_HOME = home;
    process.env.ANIMUS_STATE_DIR = stateDir;
    artifactRoot = join(stateDir, "artifacts");

    bareOrigin = join(root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", bareOrigin]);
    checkoutPath = join(root, "checkout");
    mkdirSync(checkoutPath, { recursive: true });
    execFileSync("git", ["init", "-q", checkoutPath]);
    git(checkoutPath, "remote", "add", "origin", `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", `url.${bareOrigin}.insteadOf`, `https://github.com/${REPO}.git`);
    git(checkoutPath, "config", "user.email", "test@example.com");
    git(checkoutPath, "config", "user.name", "Test");
    writeFileSync(join(checkoutPath, "base.txt"), "base\n");
    git(checkoutPath, "add", "base.txt");
    git(checkoutPath, "commit", "-q", "-m", "base");
    git(checkoutPath, "branch", "-M", "main");
    git(checkoutPath, "push", "-q", "origin", "main");
    mkdirSync(join(checkoutPath, ".factory"), { recursive: true });
    writeFileSync(join(checkoutPath, ".factory", "schedule.json"), '{"max_laps":3}\n');

    const db = initializeDatabase(join(stateDir, "console.db"));
    seedActivatedAuthority(db);
    const forge = new SyntheticForgeAdapter({ [REPO]: 9910 });
    forge.addIssue(REPO, {
      number: 9911,
      title: "Spec",
      body: specBody(),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }, { name: "spec" }],
      comments: [],
    });
    forge.addIssue(REPO, {
      number: 9912,
      title: "Ticket",
      body: ticketBody(9911),
      state: "OPEN",
      labels: [{ name: "ready-for-agent" }],
      comments: [],
    });
    const registry = new ProjectRegistryService(db, forge);
    const project = await registry.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkoutPath,
    });
    projectId = project.id;
    const plans = new PlanService(db, forge);
    const plan = await plans.importPlan(projectId, { issue_number: 9911, kind: "spec" });
    planId = plan.id;
    const branch = "factory/spec-9911-integration";
    git(checkoutPath, "branch", "-f", branch, "main");
    git(checkoutPath, "push", "-q", "origin", branch);

    const observations = new ExecutionObservationService(db, { artifactRoot });
    const budget = new ExecutionBudgetService(db);
    const dispatch = new DispatchService(db, {
      plans,
      ledger: new CommandLedger(db),
      brakes: new BrakeService(db),
      observations,
      budget,
      processAlive: () => true,
      ownerPid: () => 4242,
      runner: async (context) => {
        const name = `impl-built-${context.run_id.slice(-6)}.txt`;
        writeFileSync(join(context.worktree_path, name), "implemented\n");
        git(context.worktree_path, "add", name);
        git(context.worktree_path, "commit", "-q", "-m", `implement ${name}`);
        return { success: true, headSha: git(context.worktree_path, "rev-parse", "HEAD") };
      },
    });
    const built = await dispatch.dispatch(projectId, { plan_id: planId, actor: "operator" });
    expect(built.state).toBe("succeeded");
    db.close();
    scripts = [];
  });

  afterEach(() => {
    for (const script of scripts) rmSync(script, { force: true });
    if (ORIGINAL_ANIMUS_HOME === undefined) delete process.env.ANIMUS_HOME;
    else process.env.ANIMUS_HOME = ORIGINAL_ANIMUS_HOME;
    if (ORIGINAL_ANIMUS_STATE_DIR === undefined) delete process.env.ANIMUS_STATE_DIR;
    else process.env.ANIMUS_STATE_DIR = ORIGINAL_ANIMUS_STATE_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  test("two normal ticks start together and only one executes the review", async () => {
    const reviewLog = join(root, "review.log");
    const barrier = join(root, "go");
    const script = join(REPO_ROOT, "tests/integration", `.tmp-claim-${randomUUID()}.ts`);
    scripts.push(script);
    writeFileSync(
      script,
      `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CODE_ROOT = process.env.CODE_ROOT!;
const STATE_DIR = process.env.ANIMUS_STATE_DIR!;
const REPO = process.env.REPO!;
const projectId = process.env.PROJECT_ID!;
const checkoutPath = process.env.CHECKOUT!;
const bareOrigin = process.env.BARE_ORIGIN!;
const artifactRoot = join(process.env.ANIMUS_HOME!, "state", "artifacts");
const reviewLog = process.env.REVIEW_LOG!;
const barrier = process.env.BARRIER!;
const out = process.env.OUT!;
const worker = process.env.WORKER!;

const { initializeDatabase, ProjectRegistryService, SyntheticForgeAdapter } = await import(
  \`\${CODE_ROOT}/apps/backend/src/registry/index.ts\`
);
const { PlanService } = await import(\`\${CODE_ROOT}/apps/backend/src/plans/index.ts\`);
const { CommandLedger } = await import(\`\${CODE_ROOT}/apps/backend/src/command/ledger.ts\`);
const { BrakeService } = await import(\`\${CODE_ROOT}/apps/backend/src/command/brakes.ts\`);
const { DispatchService, runLocalDispatchTick } = await import(
  \`\${CODE_ROOT}/apps/backend/src/dispatch/index.ts\`
);
const { ExecutionObservationService } = await import(
  \`\${CODE_ROOT}/apps/backend/src/evidence/index.ts\`
);
const { ExecutionBudgetService } = await import(\`\${CODE_ROOT}/apps/backend/src/work/budget.ts\`);
const { PublicationService } = await import(\`\${CODE_ROOT}/apps/backend/src/publication/index.ts\`);
const { createLocalExecutionRuntime } = await import(
  \`\${CODE_ROOT}/apps/backend/src/local-runtime.ts\`
);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function remoteHead(branch: string): string | null {
  try {
    return (
      execFileSync("git", ["--git-dir", bareOrigin, "rev-parse", "--verify", \`refs/heads/\${branch}\`], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
function mergeOnBareOrigin(pr: any): { sha: string } {
  const headSha = pr.headRefOid ?? remoteHead(pr.head);
  const baseSha = remoteHead(pr.base);
  if (!headSha || !baseSha) throw new Error("merge transport missing a remote ref");
  const treeSha = git(checkoutPath, "merge-tree", "--write-tree", baseSha, headSha).split("\\n")[0]!.trim();
  const mergeSha = git(checkoutPath, "commit-tree", treeSha, "-p", baseSha, "-p", headSha, "-m",
    \`Merge \${pr.head} into \${pr.base}\`);
  git(checkoutPath, "update-ref", \`refs/heads/\${pr.base}\`, mergeSha, baseSha);
  git(checkoutPath, "push", "-q", "origin", \`refs/heads/\${pr.base}\`);
  return { sha: mergeSha };
}

const forge = new SyntheticForgeAdapter({ [REPO]: 9910 }, {
  requireRemoteSourceRef: true,
  resolveHeadRefOid: (_repo: string, branch: string) => remoteHead(branch),
  mergeRemote: (_repo: string, pr: any) => mergeOnBareOrigin(pr),
});
const db = initializeDatabase(join(STATE_DIR, "console.db"));
const registry = new ProjectRegistryService(db, forge);
const plans = new PlanService(db, forge);
const observations = new ExecutionObservationService(db, { artifactRoot });
const budget = new ExecutionBudgetService(db);
const publication = new PublicationService(db, forge);
const dispatch = new DispatchService(db, {
  plans,
  ledger: new CommandLedger(db),
  brakes: new BrakeService(db),
  observations,
  budget,
  processAlive: () => true,
  ownerPid: () => 4242,
  runner: async () => {
    throw new Error("no builder expected on a gate-only run");
  },
});

const transport = async (request: any) => {
  const head = git(request.cwd, "rev-parse", "HEAD");
  if (request.role !== "reviewer") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        type: "result",
        finalText: JSON.stringify({ head, overall: "PASS", summary: "ok" }),
      }),
      stderr: "",
    };
  }
  appendFileSync(reviewLog, JSON.stringify({ worker, head }) + "\\n");
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      type: "result",
      finalText: JSON.stringify({
        sha: head,
        outcome: "approved",
        summary: "independent review passed",
        findings: [],
      }),
    }),
    stderr: "",
  };
};

const runtime = createLocalExecutionRuntime({
  db,
  plans,
  dispatch,
  forge,
  observations,
  budget,
  publication,
  artifactRoot,
  technicalChecks: ["echo tech-ok"],
  regressionChecks: ["true"],
  engine: {
    transport,
    provider: "pi",
    model: "test-model",
    roleBudgets: {
      qa: { softMs: 5_000, hardMs: 10_000 },
      reviewer: { softMs: 5_000, hardMs: 10_000 },
    },
  },
});

while (!existsSync(barrier)) await Bun.sleep(2);
const result = await runLocalDispatchTick({
  db,
  registry,
  plans,
  dispatch,
  actor: \`monitor-\${worker}\`,
  deliveryRuntime: runtime.delivery,
});
writeFileSync(out, JSON.stringify(result));
db.close();
`,
    );

    const children = ["A", "B"].map((worker) => {
      const out = join(root, `result-${worker}.json`);
      const child = Bun.spawn([process.execPath, script], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          CODE_ROOT: REPO_ROOT,
          REPO,
          PROJECT_ID: projectId,
          CHECKOUT: checkoutPath,
          BARE_ORIGIN: bareOrigin,
          REVIEW_LOG: reviewLog,
          BARRIER: barrier,
          OUT: out,
          WORKER: worker,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return { worker, out, child };
    });
    await Bun.sleep(150);
    writeFileSync(barrier, "go\n");

    const results = await Promise.all(
      children.map(async ({ worker, out, child }) => {
        const exitCode = await child.exited;
        const stderr = await new Response(child.stderr).text();
        expect(exitCode).toBe(0);
        expect(existsSync(out)).toBe(true);
        return { worker, result: JSON.parse(readFileSync(out, "utf-8")), stderr };
      }),
    );

    const reviewEntries = readFileSync(reviewLog, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { worker: string; head: string });
    expect(reviewEntries).toHaveLength(1);

    const launched = results.filter(({ result }) => result.action === "launched");
    const skipped = results.filter(({ result }) => result.action === "skipped");
    expect(launched).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.result.reason).toBe("delivery_already_claimed");

    const verify = initializeDatabase(join(stateDir, "console.db"));
    try {
      const integrations = verify
        .prepare("SELECT run_id, candidate_head_sha FROM delivery_merges")
        .all() as Array<{ run_id: string; candidate_head_sha: string }>;
      expect(integrations).toHaveLength(1);
      const reviews = verify
        .prepare(
          "SELECT status FROM execution_observations WHERE stage = 'independent_review' AND run_id = ?",
        )
        .all(integrations[0]!.run_id) as Array<{ status: string }>;
      expect(reviews).toHaveLength(1);
      expect(reviews[0]!.status).toBe("passed");
      const claims = verify
        .prepare(
          "SELECT state, claim_generation FROM delivery_role_claims WHERE run_id = ? AND stage = 'independent_review'",
        )
        .all(integrations[0]!.run_id) as Array<{ state: string; claim_generation: number }>;
      expect(claims).toHaveLength(1);
      expect(claims[0]!.state).toBe("completed");
      expect(claims[0]!.claim_generation).toBe(1);
    } finally {
      verify.close();
    }
  }, 60_000);
});
