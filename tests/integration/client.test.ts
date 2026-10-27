import { expect, expectTypeOf, test } from "vitest";
import { hostHealthSchema, type HostHealth } from "@labq/contracts/host";
import { healthSchema, type Health } from "@labq/contracts/operator";
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

test("portable client exposes only classified errors, never raw transport/upstream text", async () => {
  for (const code of [
    "host_unavailable",
    "host_unauthorized",
    "invalid_host_response",
    "candidate_mismatch",
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
