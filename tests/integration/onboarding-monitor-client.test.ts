import { describe, expect, test } from "vitest";
import { createFactoryClient, FactoryClientError } from "@labq/client";
import { runProjectCommand } from "../../scripts/cli/commands/operations";

const status = {
  enabled: true,
  stopping: false,
  interval_ms: 1000,
  error: null,
  projects: [
    {
      project_id: "proj_one",
      state: "held",
      reason: "setup_incomplete",
      checked_at: null,
      next_check_at: null,
    },
  ],
};
describe("monitoring public client", () => {
  test("project monitoring command uses the same factory API", async () => {
    let fetched = false;
    expect(
      await runProjectCommand({
        subcommand: "monitoring",
        positionals: ["project", "monitoring"],
        repoRoot: "/unused",
        json: true,
        fetch: async (url) => {
          expect(url).toBe("http://127.0.0.1:3000/api/v1/monitoring");
          fetched = true;
          return Response.json(status);
        },
      }),
    ).toBe(0);
    expect(fetched).toBe(true);
  });
  test("exposes actual monitor state including held projects", async () => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: async (url) => {
        expect(url).toBe("http://127.0.0.1:3000/api/v1/monitoring");
        return Response.json(status);
      },
    });
    expect(await client.monitoring()).toEqual(status);
  });
  test.each([
    {},
    { ...status, enabled: "yes" },
    { ...status, projects: [{ ...status.projects[0], state: "approved" }] },
  ])("refuses malformed monitoring success (%j)", async (body) => {
    const client = createFactoryClient({
      baseUrl: "http://127.0.0.1:3000",
      fetch: async () => Response.json(body),
    });
    await expect(client.monitoring()).rejects.toBeInstanceOf(FactoryClientError);
  });
});
