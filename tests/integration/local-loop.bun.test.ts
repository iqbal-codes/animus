import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runLocalLoop,
  parseAgentReport,
  type LocalIssue,
  type PiTransport,
} from "../../scripts/local-loop";

test("accepts a single fenced JSON report without discarding findings and rejects ambiguous or invalid reports", () => {
  const value = { candidate: "abc", verdict: "pass", findings: ["must fix"], checks: [] };
  expect(parseAgentReport(JSON.stringify(value))).toEqual(value);
  expect(parseAgentReport(`QA summary\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(
    value,
  );
  expect(() => parseAgentReport("I checked it, looks good")).toThrow();
  expect(() => parseAgentReport("```json\n{}\n```\n```json\n{}\n```")).toThrow();
  expect(() => parseAgentReport("```json\ninvalid\n```")).toThrow();
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-loop-"));
  roots.push(root);
  git(root, "init");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Offline Test");
  await mkdir(join(root, "harness"));
  await Bun.write(
    join(root, "harness/harness.config.json"),
    JSON.stringify({
      static: "true",
      unit: "true",
      unit_count_pattern: "(\\d+) passed",
      protected_paths: "MISSION.md",
    }),
  );
  await Bun.write(join(root, "README.md"), "# Base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

test("executes one clean lap: builder commits, checks run, QA silent, reviewer posts verdict", async () => {
  const root = await fixture();
  const issue: LocalIssue = {
    number: 72,
    url: "https://github.com/owner/repo/issues/72",
    title: "fix brakes",
    body: "fix it",
    comments: [],
    dependencies: [],
    activeClaim: false,
  };

  const transport: PiTransport = async ({ cwd, role }) => {
    if (role === "builder") {
      await Bun.write(join(cwd, "fix.txt"), "fixed");
      git(cwd, "add", "fix.txt");
      git(cwd, "commit", "-m", "fix issue 72");
    }
    const head = git(cwd, "rev-parse", "HEAD");
    return {
      exitCode: 0,
      stdout:
        JSON.stringify({
          type: "agent_settled",
          aborted: false,
        }) +
        "\n" +
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: head,
                  verdict: "pass",
                  checks: [{ criterion: "AC1", result: "pass", evidence: "unit test ok" }],
                  findings: [],
                }),
              },
            ],
          },
        }),
      stderr: "",
    };
  };

  const res = await runLocalLoop(root, issue, { pi: transport, push: false });
  expect(res.status).toBe("waiting_approval");
  expect(res.route).toBe("simple");
  expect(res.evidence.filter((e) => e.kind === "pi")).toHaveLength(3); // builder, qa, reviewer
});
