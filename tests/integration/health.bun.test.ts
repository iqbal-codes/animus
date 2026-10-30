import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { createFactoryClient } from "@labq/client";

const root = fileURLToPath(new URL("../../", import.meta.url));
const token = randomBytes(32).toString("hex");
const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
const states: string[] = [];
const toolDirs: string[] = [];
const adapters: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  const outcomes = await Promise.allSettled(
    children
      .splice(0)
      .reverse()
      .map(async (child) => {
        if (child.exitCode === null) child.kill("SIGTERM");
        const code = await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")]);
        if (code === "timeout") {
          child.kill("SIGKILL");
          await child.exited;
        }
        expect(code).toBe(0);
        expect(await new Response(child.stderr).text()).not.toContain(token);
        const reader = child.stdout.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            expect(new TextDecoder().decode(chunk.value)).not.toContain(token);
          }
        } finally {
          reader.releaseLock();
        }
      }),
  );
  for (const adapter of adapters.splice(0)) await adapter.stop(true);
  for (const state of states.splice(0)) {
    expect(
      (await readdir(state)).filter(
        (entry) => !["console.db", "console.db-wal", "console.db-shm"].includes(entry),
      ),
    ).toEqual([]);
    await rm(state, { recursive: true });
  }
  for (const directory of toolDirs.splice(0)) await rm(directory, { recursive: true });
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
});

const intakeIssue = {
  number: 1,
  title: "Deterministic offline intake issue",
  state: "OPEN",
  labels: {
    nodes: [{ name: "ready-for-agent" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  body: "Offline transport test",
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};

async function intakeGh(response?: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "factory-health-gh-"));
  toolDirs.push(directory);
  await writeFile(
    join(directory, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const query = args.find((arg) => arg.startsWith("query="))?.slice(6);
if (args[0] !== "api" || args[1] !== "graphql" || !query) {
  throw new Error("Unexpected gh operation in offline health test");
}
const issue = ${JSON.stringify(intakeIssue)};
let repository;
if (query.includes("issues(first: 100,")) {
  repository = { issues: { nodes: [issue], pageInfo: { hasNextPage: false, endCursor: null } } };
} else if (query.includes("issue(number: $number)")) {
  repository = { issue: args.includes("number=1") ? issue : null };
} else {
  throw new Error("Unexpected GraphQL query in offline health test");
}
console.log(${response === undefined ? "JSON.stringify({ data: { repository } })" : JSON.stringify(response)});
`,
    { mode: 0o755 },
  );
  return directory;
}

async function start(
  app: string,
  env: Record<string, string | undefined> = {},
  hostname = "127.0.0.1",
  intakeResponse?: string,
) {
  const ghDirectory = await intakeGh(intakeResponse);
  const state = await mkdtemp(join(tmpdir(), "factory-health-"));
  states.push(state);
  const child = Bun.spawn(
    [process.execPath, `${root}apps/${app}/src/main.ts`, "--port", "0", "--host", hostname],
    {
      cwd: "/tmp",
      env: {
        ...process.env,
        FACTORY_RUNTIME_STATE: state,
        FACTORY_STATE_DIR: state,
        FACTORY_RUNTIME_CANDIDATE: "  candidate-é\n",
        FACTORY_HOST_TOKEN: token,
        PATH: `${ghDirectory}:${process.env.PATH ?? ""}`,
        ...env,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);
  const reader = child.stdout.getReader();
  const first = await Promise.race([
    reader.read(),
    Bun.sleep(5000).then(() => {
      throw new Error("Startup deadline");
    }),
  ]);
  if (!first.value) throw new Error(await new Response(child.stderr).text());
  const startup = new TextDecoder().decode(first.value);
  expect(startup).not.toContain(token);
  const { url, runtime } = JSON.parse(startup) as {
    url: string;
    runtime: string;
  };
  expect(runtime).toBe(`Bun ${Bun.version}`);
  reader.releaseLock();
  return { child, url };
}

test("ambient intake fixture settings cannot replace GitHub transport responses", async () => {
  const backend = await start("backend", {
    FACTORY_HOST_URL: "http://127.0.0.1:1",
    FACTORY_INTAKE_FIXTURE: JSON.stringify([
      { number: 999, title: "Forged admission", state: "OPEN", labels: ["ready-for-agent"] },
    ]),
  });
  const response = await fetch(`${backend.url}/api/v1/intake`);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.issues.map((issue: { number: number }) => issue.number)).toEqual([1]);
  const targeted = await fetch(`${backend.url}/api/v1/intake/1`);
  expect(targeted.status).toBe(200);
  expect((await targeted.json()).number).toBe(1);
});

test("malformed offline transport responses fail closed despite ambient fixture settings", async () => {
  const backend = await start(
    "backend",
    {
      FACTORY_HOST_URL: "http://127.0.0.1:1",
      FACTORY_INTAKE_FIXTURE: "[]",
    },
    "127.0.0.1",
    "not-json",
  );
  for (const path of ["/api/v1/intake", "/api/v1/intake/1"]) {
    const response = await fetch(`${backend.url}${path}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "intake_unavailable" });
  }
});

test("real authenticated host and independently started backend report exact candidate", async () => {
  const host = await start("engine-host");
  const backend = await start("backend", { FACTORY_HOST_URL: host.url });
  expect(await (await fetch(`${backend.url}/build-id`)).text()).toBe("  candidate-é\n");
  const response = await fetch(`${backend.url}/api/v1/health`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    status: "healthy",
    buildId: "  candidate-é\n",
    host: { status: "healthy", buildId: "  candidate-é\n" },
  });
  expect((await fetch(`${host.url}/internal/v1/health`)).status).toBe(401);
});

async function stop(child: ReturnType<typeof Bun.spawn>, signal: "SIGINT" | "SIGTERM" = "SIGTERM") {
  child.kill(signal);
  expect(await Promise.race([child.exited, Bun.sleep(3000).then(() => "timeout")])).toBe(0);
}

function adapter(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  adapters.push(server);
  return server.url.origin;
}

test("host auth protects every route and backend fails closed for wrong token, outage and mismatch", async () => {
  const host = await start("engine-host");
  for (const path of ["/health", "/build-id", "/internal/v1/health", "/unknown"]) {
    for (const authorization of ["", `Bearer ${"x".repeat(64)}`]) {
      const response = await fetch(`${host.url}${path}`, { headers: { authorization } });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
  }
  const wrong = await start("backend", {
    FACTORY_HOST_URL: host.url,
    FACTORY_HOST_TOKEN: "x".repeat(64),
  });
  expect(
    await createFactoryClient({ baseUrl: wrong.url })
      .health()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "host_unauthorized" });
  const mismatch = await start("backend", {
    FACTORY_HOST_URL: host.url,
    FACTORY_RUNTIME_CANDIDATE: "other",
  });
  expect(
    await createFactoryClient({ baseUrl: mismatch.url })
      .health()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "candidate_mismatch" });
  const backend = await start("backend", { FACTORY_HOST_URL: host.url });
  await stop(host.child);
  expect(
    await createFactoryClient({ baseUrl: backend.url })
      .health()
      .catch((error: unknown) => error),
  ).toMatchObject({ code: "host_unavailable" });
  expect(await (await fetch(`${backend.url}/health`)).json()).toEqual({ status: "healthy" });
});

test("operator classifies controlled malformed, upstream and deadline failures without forwarding secrets or redirects", async () => {
  let targetRequests = 0;
  const target = adapter(() => {
    targetRequests++;
    return Response.json({ secret: token });
  });
  for (const [kind, code] of [
    ["json", "invalid_host_response"],
    ["schema", "invalid_host_response"],
    ["upstream", "host_unavailable"],
    ["redirect", "host_unavailable"],
    ["forbidden", "host_unauthorized"],
    ["timeout", "host_unavailable"],
    ["body-timeout", "host_unavailable"],
  ]) {
    const origin = adapter(async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${token}`);
      if (kind === "timeout") await Bun.sleep(2200);
      if (kind === "body-timeout")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"status":'));
            },
          }),
        );
      if (kind === "json") return new Response(token);
      if (kind === "schema") return Response.json({ status: "healthy", buildId: 1, secret: token });
      if (kind === "redirect") return Response.redirect(target);
      return new Response(token, { status: kind === "forbidden" ? 403 : 500 });
    });
    const backend = await start("backend", { FACTORY_HOST_URL: origin });
    const response = await fetch(`${backend.url}/api/v1/health`);
    expect(response.status).toBe(code === "invalid_host_response" ? 502 : 503);
    expect(await response.json()).toEqual({ error: code });
  }
  expect(targetRequests).toBe(0);
}, 20000);

test("private host traffic bypasses ambient proxies for success, auth refusal and outage", async () => {
  const proxyRequests: { url: string; authorization: string | null }[] = [];
  const proxy = adapter((request) => {
    proxyRequests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return Response.json({ status: "healthy", buildId: "  candidate-é\n" });
  });
  for (const [key, hostname] of [
    ["HTTP_PROXY", "127.0.0.1"],
    ["http_proxy", "127.0.0.1"],
    ["HTTP_PROXY", "::1"],
    ["http_proxy", "::1"],
  ]) {
    const host = await start("engine-host", {}, hostname);
    const env = {
      FACTORY_HOST_URL: host.url,
      HTTP_PROXY: undefined,
      http_proxy: undefined,
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      all_proxy: proxy,
      NO_PROXY: "",
      no_proxy: "",
      [key]: proxy,
    };
    const backend = await start("backend", env);
    const client = createFactoryClient({ baseUrl: backend.url });
    expect((await client.health()).buildId).toBe("  candidate-é\n");
    const wrong = await start("backend", { ...env, FACTORY_HOST_TOKEN: "x".repeat(64) });
    expect(
      await createFactoryClient({ baseUrl: wrong.url })
        .health()
        .catch((error: unknown) => error),
    ).toMatchObject({ code: "host_unauthorized" });
    await stop(host.child);
    expect(await client.health().catch((error: unknown) => error)).toMatchObject({
      code: "host_unavailable",
    });
    expect(proxyRequests.length).toBe(0);
    expect(JSON.stringify(proxyRequests).includes(token)).toBe(false);
  }
});

test("candidate values, independent lifetimes, concurrent connections and released listeners", async () => {
  for (const candidate of ["candidate-a", "candidate-b", "", "  candidate-é\n", undefined]) {
    const expected =
      candidate ??
      Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
    const host = await start("engine-host", { FACTORY_RUNTIME_CANDIDATE: candidate });
    const backend = await start("backend", {
      FACTORY_HOST_URL: host.url,
      FACTORY_RUNTIME_CANDIDATE: candidate,
    });
    expect((await createFactoryClient({ baseUrl: backend.url }).health()).buildId).toBe(expected);
    const pending = connect(Number(new URL(backend.url).port), "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        pending.once("connect", resolve);
        pending.once("error", reject);
      });
      pending.write("GET /api/v1/health HTTP/1.1\r\n");
      expect(await (await fetch(`${backend.url}/build-id`)).text()).toBe(expected);
    } finally {
      pending.destroy();
    }
    await stop(backend.child, "SIGINT");
    expect(
      (await fetch(`${host.url}/health`, { headers: { Authorization: `Bearer ${token}` } })).status,
    ).toBe(200);
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(new URL(backend.url).port),
      fetch: () => new Response(),
    });
    await listener.stop(true);
    await stop(host.child);
  }
});

test("independent pairs retain their candidates and host listener releases on SIGINT", async () => {
  const absent = await start("backend", { FACTORY_HOST_URL: "http://127.0.0.1:1" });
  expect((await fetch(`${absent.url}/health`)).status).toBe(200);
  const firstHost = await start("engine-host", { FACTORY_RUNTIME_CANDIDATE: "first" });
  const secondHost = await start("engine-host", { FACTORY_RUNTIME_CANDIDATE: "second" });
  const first = await start("backend", {
    FACTORY_HOST_URL: firstHost.url,
    FACTORY_RUNTIME_CANDIDATE: "first",
  });
  const second = await start("backend", {
    FACTORY_HOST_URL: secondHost.url,
    FACTORY_RUNTIME_CANDIDATE: "second",
  });
  expect((await createFactoryClient({ baseUrl: first.url }).health()).buildId).toBe("first");
  await stop(first.child);
  await stop(firstHost.child, "SIGINT");
  expect((await createFactoryClient({ baseUrl: second.url }).health()).buildId).toBe("second");
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(new URL(firstHost.url).port),
    fetch: () => new Response(),
  });
  await listener.stop(true);
});

test("unknown methods and paths do not become healthy", async () => {
  const host = await start("engine-host");
  const backend = await start("backend", { FACTORY_HOST_URL: host.url });
  for (const [url, paths, headers] of [
    [backend.url, ["/health", "/build-id", "/api/v1/health"], {}],
    [
      host.url,
      ["/health", "/build-id", "/internal/v1/health"],
      { Authorization: `Bearer ${token}` },
    ],
  ] as const) {
    for (const path of paths)
      expect((await fetch(`${url}${path}`, { method: "POST", headers })).status).toBe(405);
    expect((await fetch(`${url}/unknown`, { headers })).status).toBe(404);
  }
});

test("invalid or missing private settings and remote binds refuse startup without leaking values", async () => {
  for (const app of ["backend", "engine-host"]) {
    const cases: { args?: string[]; env?: Record<string, string | undefined> }[] = [
      { env: { FACTORY_HOST_TOKEN: undefined } },
      { env: { FACTORY_RUNTIME_CANDIDATE: undefined, PATH: "/nonexistent-factory-test-path" } },
      { env: { FACTORY_HOST_TOKEN: "short-secret" } },
      { env: { FACTORY_HOST_TOKEN: "with whitespace".repeat(4) } },
      { args: ["--host", "0.0.0.0"] },
      { args: ["--host", "localhost"] },
      { args: ["--port", "65536"] },
      { args: ["--port", "-1"] },
    ];
    if (app === "backend")
      for (const value of [
        undefined,
        "http://example.com:12",
        "http://127.0.0.1",
        "http://127.0.0.1:12/path",
        "http://secret@127.0.0.1:12",
        "http://127.0.0.1:0",
      ])
        cases.push({ env: { FACTORY_HOST_URL: value } });
    for (const entry of cases) {
      const child = Bun.spawn(
        [process.execPath, `${root}apps/${app}/src/main.ts`, "--port", "0", ...(entry.args ?? [])],
        {
          env: {
            ...process.env,
            FACTORY_RUNTIME_CANDIDATE: "test",
            FACTORY_HOST_TOKEN: token,
            FACTORY_HOST_URL: "http://127.0.0.1:1",
            ...entry.env,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(1);
      const output = await new Response(child.stderr).text();
      expect(output).not.toContain(token);
      expect(output).not.toContain("short-secret");
      expect(await new Response(child.stdout).text()).toBe("");
    }
  }
}, 20000);

test("backend forwards diagnostics, catalog, and lap history from authenticated engine-host", async () => {
  const host = await start("engine-host");
  const backend = await start("backend", { FACTORY_HOST_URL: host.url });
  const client = createFactoryClient({ baseUrl: backend.url });

  const diagnostics = await client.diagnostics();
  expect(["healthy", "unavailable"]).toContain(diagnostics.status);
  expect(typeof diagnostics.revision_required).toBe("string");
  expect(typeof diagnostics.digest).toBe("string");
  expect(diagnostics.source_directory).toBe(".archon/workflows/sdlc");

  const catalog = await client.catalog();
  expect(Array.isArray(catalog.workflows)).toBe(true);
  expect(catalog.workflows.some((w) => w.name === "archon-loop")).toBe(true);

  const laps = await client.laps();
  expect(Array.isArray(laps)).toBe(true);

  // Attempt reading a non-existent lap ID returns classified error
  expect(client.lap("nonexistent-lap-id")).rejects.toMatchObject({
    code: "lap_not_found",
  });

  // Malformed launch payloads produce classified error
  expect(client.launch({ specification: "" })).rejects.toMatchObject({
    code: "invalid_payload",
  });
  expect(client.launch({} as any)).rejects.toMatchObject({
    code: "invalid_payload",
  });

  // End-to-end intake reading through backend client
  const intake = await client.intake();
  expect(typeof intake.repo).toBe("string");
  expect(typeof intake.total_count).toBe("number");
  expect(Array.isArray(intake.issues)).toBe(true);
  expect(typeof intake.cached).toBe("boolean");
  expect(intake.issues.map((issue) => [issue.number, issue.admission_status])).toEqual([
    [1, "admitted"],
  ]);

  // End-to-end control inspection and execution through backend client
  const initialControls = await client.controlState();
  expect(typeof initialControls.halted).toBe("boolean");
  expect(typeof initialControls.paused).toBe("boolean");
  expect(["none", "stop", "pause", "both"]).toContain(initialControls.active_brake);

  const paused = await client.control("pause");
  expect(paused.paused).toBe(true);
  expect(["pause", "both"]).toContain(paused.active_brake);

  const unpaused = await client.control("unpause");
  expect(unpaused.paused).toBe(false);

  // Evidence query on nonexistent lap returns classified error
  expect(client.evidence("nonexistent-lap-id")).rejects.toMatchObject({
    code: "lap_not_found",
  });
}, 15000);
