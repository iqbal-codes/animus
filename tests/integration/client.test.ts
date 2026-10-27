import { expect, expectTypeOf, test } from "vitest";
import { hostHealthSchema, type HostHealth } from "@labq/contracts/host";
import {
  healthSchema,
  type Health,
  type Diagnostics,
  type WorkflowCatalog,
  type LapList,
  type LapDetail,
} from "@labq/contracts/operator";
import { createFactoryClient, FactoryClientError } from "@labq/client";

test("private host and public health values conform without propagating additive fields", () => {
  expectTypeOf<HostHealth>().toEqualTypeOf<Health["host"]>();
  const host = hostHealthSchema.parse({
    status: "healthy",
    buildId: "candidate",
    privateExtra: "secret",
  });
  expect(healthSchema.parse({ status: "healthy", buildId: "candidate", host })).toEqual({
    status: "healthy",
    buildId: "candidate",
    host: { status: "healthy", buildId: "candidate" },
  });
});

test("portable client validates exact identities and refuses malformed operator data", async () => {
  const candidate = "  candidate-é\n";
  const health = {
    status: "healthy",
    buildId: candidate,
    host: { status: "healthy", buildId: candidate },
  };
  const client = createFactoryClient({
    baseUrl: "http://localhost:1234",
    fetch: async (input) => {
      expect(String(input)).toBe("http://localhost:1234/api/v1/health");
      return Response.json(health);
    },
  });
  expect(await client.health()).toEqual(health);
  for (const body of [
    {},
    { ...health, host: { status: "healthy", buildId: "other" } },
    { status: "healthy", buildId: 1 },
  ]) {
    await expect(
      createFactoryClient({
        baseUrl: "http://localhost",
        fetch: async () => Response.json(body),
      }).health(),
    ).rejects.toMatchObject({ code: "invalid_operator_response" });
  }
});

test("portable client reads diagnostics, catalog, and lap history cleanly", async () => {
  const diagnosticsData: Diagnostics = {
    status: "healthy",
    revision_required: "5c4f5e484262185926b37b070457fabb9bfedae0",
    digest: "test-digest-sha256",
    captured_at: "2026-10-27T00:00:00Z",
    source_directory: ".archon/workflows/sdlc",
    file_count: 444,
    default_workflows_loaded: true,
  };
  const catalogData: WorkflowCatalog = {
    workflows: [
      {
        name: "archon-loop",
        description: "One move loop",
        default_inputs: { holdout: "holdout-path" },
      },
    ],
  };
  const lapListData: LapList = [
    {
      id: "run-1",
      workflow_name: "archon-loop",
      native_status: "completed",
      product_status: "completed",
      candidate_head: "c".repeat(40),
      work_item: "#28",
      pull_request: null,
      transitions: [],
    },
  ];
  const lapDetailData: LapDetail = {
    ...lapListData[0],
    source_commit: "b".repeat(40),
    tokens: { in: 100, out: 200, cache_read: 50, cost_usd: 0.05 },
  };

  const client = createFactoryClient({
    baseUrl: "http://localhost:1234",
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/diagnostics")) return Response.json(diagnosticsData);
      if (url.endsWith("/api/v1/catalog")) return Response.json(catalogData);
      if (url.endsWith("/api/v1/laps")) return Response.json(lapListData);
      if (url.endsWith("/api/v1/laps/run-1")) return Response.json(lapDetailData);
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });

  expect(await client.diagnostics()).toEqual(diagnosticsData);
  expect(await client.catalog()).toEqual(catalogData);
  expect(await client.laps()).toEqual(lapListData);
  expect(await client.lap("run-1")).toEqual(lapDetailData);
});

test("portable client exposes only classified errors, never raw transport/upstream text", async () => {
  for (const code of [
    "host_unavailable",
    "host_unauthorized",
    "invalid_host_response",
    "candidate_mismatch",
    "native_source_unavailable",
    "native_state_unavailable",
    "lap_not_found",
    "scope_mismatch",
  ]) {
    await expect(
      createFactoryClient({
        baseUrl: "http://localhost",
        fetch: async () => Response.json({ error: code }, { status: 503 }),
      }).health(),
    ).rejects.toMatchObject({ code });
  }
  for (const response of [
    new Response("secret", { status: 500 }),
    Response.json({ error: "secret" }, { status: 503 }),
    new Response("{"),
  ]) {
    await expect(
      createFactoryClient({ baseUrl: "http://localhost", fetch: async () => response }).health(),
    ).rejects.toMatchObject({ code: "invalid_operator_response" });
  }
  const client = createFactoryClient({
    baseUrl: "http://localhost",
    fetch: () => {
      throw new Error("secret");
    },
  });
  await expect(client.health()).rejects.toEqual(new FactoryClientError("transport_unavailable"));
});
