import { expect, test } from "vitest";
import { createFactoryClient, FactoryClientError } from "@labq/client";

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
