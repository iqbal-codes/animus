import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@labq/client";

test("real backend enrolls a checkout, provisions labels, reports held setup, and preserves admission", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-onboarding-http-")));
  const checkout = join(root, "product");
  const bin = join(root, "bin");
  mkdirSync(bin);
  execFileSync("git", ["init", "-q", checkout]);
  execFileSync("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    "https://github.com/acme/product.git",
  ]);
  const labelsPath = join(root, "labels.json");
  writeFileSync(
    labelsPath,
    JSON.stringify([{ name: "custom", color: "123456", description: "Keep" }]),
  );
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst path = process.env.TEST_LABELS;\nif (args[0] !== "api") process.exit(2);\nif (args[1] === "repos/acme/product") { console.log(JSON.stringify({id:42,nameWithOwner:"acme/product"})); process.exit(0); }\nif (args[1] !== "repos/acme/product/labels") process.exit(3);\nconst labels = await Bun.file(path).json();\nif (args.includes("POST")) { const fields=Object.fromEntries(args.filter((value,index)=>args[index-1]==="-f").map(value=>{const at=value.indexOf("=");return [value.slice(0,at),value.slice(at+1)];}));labels.push(fields);await Bun.write(path, JSON.stringify(labels));console.log(JSON.stringify(fields)); } else console.log(JSON.stringify([labels]));\n`,
    { mode: 0o700 },
  );
  const secret = randomBytes(32).toString("hex");
  const host = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ error: "unused" }, { status: 404 }),
  });
  const backend = Bun.spawn([process.execPath, "apps/backend/src/main.ts", "--port", "0"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TEST_LABELS: labelsPath,
      FACTORY_STATE_DIR: join(root, "state"),
      FACTORY_HOST_URL: host.url.origin,
      FACTORY_HOST_TOKEN: secret,
      FACTORY_RUNTIME_CANDIDATE: "onboarding-test",
      FACTORY_MONITOR_INTERVAL_MS: "20",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = backend.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(5000).then(() => {
        throw new Error("Backend startup deadline");
      }),
    ]);
    if (!first.value) throw new Error(await new Response(backend.stderr).text());
    const { url } = JSON.parse(new TextDecoder().decode(first.value));
    reader.releaseLock();
    const client = createFactoryClient({ baseUrl: url });
    const registration = {
      method: "local_checkout" as const,
      name: "Product",
      checkout_path: checkout,
    };
    const project = await client.registerProject(registration);
    expect(project.repo_id).toBe(42);
    expect((await client.registerProject(registration)).id).toBe(project.id);
    expect((await client.projects()).map((entry) => entry.id)).toEqual([project.id]);
    const labels = (await Bun.file(labelsPath).json()) as { name: string }[];
    expect(labels.map((label) => label.name).sort()).toEqual([
      "custom",
      "needs-info",
      "needs-triage",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
    ]);
    let monitoring = await client.monitoring();
    const deadline = Date.now() + 5000;
    while (monitoring.projects[0]?.state !== "held" && Date.now() < deadline) {
      await Bun.sleep(20);
      monitoring = await client.monitoring();
    }
    expect(monitoring.enabled).toBe(true);
    expect(monitoring.projects[0]?.reason).toBe("setup_incomplete");
    expect(monitoring.projects[0]?.run_id).toBeUndefined();
    expect((await client.deregisterProject(project.id)).status).toBe("tombstone");
    expect(await client.projects()).toEqual([]);
  } finally {
    if (backend.exitCode === null) backend.kill("SIGTERM");
    const exit = await Promise.race([backend.exited, Bun.sleep(5000).then(() => "timeout")]);
    if (exit === "timeout") {
      backend.kill("SIGKILL");
      await backend.exited;
    }
    await host.stop(true);
    rmSync(root, { recursive: true, force: true });
    expect(exit).toBe(0);
  }
}, 15000);
