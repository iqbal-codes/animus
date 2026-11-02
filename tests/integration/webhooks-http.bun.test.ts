import { expect, test, describe, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFactoryClient } from "@animus/client";
import {
  DeliveryDeduplicationCache,
  GitHubWebhookService,
  classifyGitHubWebhookEvent,
} from "../../apps/backend/src/webhooks";

function computeSignature(payload: string | Buffer, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload);
  return `sha256=${hmac.digest("hex")}`;
}

describe("GitHub webhook ingestion endpoint and deduplication", () => {
  const cleanupTasks: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const task = cleanupTasks.pop();
      if (task) await task();
    }
  });

  test("DeliveryDeduplicationCache handles sliding window and pruning", () => {
    const cache = new DeliveryDeduplicationCache(120_000);
    const now = 1_000_000;

    // Without intermediate access, expires after 120_000 ms
    expect(cache.has("del-1", now)).toBe(false);
    cache.record("del-1", now);
    expect(cache.has("del-1", now + 120_001)).toBe(false);

    // With intermediate access (sliding window): access at now + 60_000 extends expiration to now + 180_000
    cache.record("del-2", now);
    expect(cache.has("del-2", now + 60_000)).toBe(true);
    // Finally expires at (now + 60_000) + 120_001 = now + 180_001
    expect(cache.has("del-2", now + 180_001)).toBe(false);

    // Empty or falsy delivery IDs are ignored
    expect(cache.has("", now)).toBe(false);
    cache.record("", now);
    expect(cache.has("", now)).toBe(false);

    // Pruning removes expired entries
    cache.record("del-3", now);
    cache.prune(now + 130_000);
    expect(cache.has("del-3", now + 130_000)).toBe(false);

    // Clear empties all entries
    cache.record("del-4", now);
    cache.clear();
    expect(cache.has("del-4", now)).toBe(false);
  });

  test("classifyGitHubWebhookEvent filters events per #118 AC1, AC2, AC3", () => {
    // #118 AC1: issues labeled with ready-for-agent is eligible
    expect(
      classifyGitHubWebhookEvent("issues", {
        action: "labeled",
        label: { name: "ready-for-agent" },
      }),
    ).toEqual({ eligible: true, reason: "issues.labeled" });

    // Case-insensitive label name
    expect(
      classifyGitHubWebhookEvent("issues", {
        action: "labeled",
        label: { name: "READY-FOR-AGENT" },
      }),
    ).toEqual({ eligible: true, reason: "issues.labeled" });

    // Non-ready-for-agent label is ignored
    expect(
      classifyGitHubWebhookEvent("issues", {
        action: "labeled",
        label: { name: "documentation" },
      }),
    ).toEqual({ eligible: false, reason: "unsupported_event" });

    // #118 AC2 & parent spec #115: opened, reopened, edited, unlabeled
    for (const action of ["opened", "reopened", "edited", "unlabeled"]) {
      expect(classifyGitHubWebhookEvent("issues", { action })).toEqual({
        eligible: true,
        reason: `issues.${action}`,
      });
    }

    // PR reviews and check runs
    expect(classifyGitHubWebhookEvent("pull_request_review", { action: "submitted" })).toEqual({
      eligible: true,
      reason: "pull_request_review.submitted",
    });
    expect(classifyGitHubWebhookEvent("check_run", { action: "completed" })).toEqual({
      eligible: true,
      reason: "check_run.completed",
    });
    expect(classifyGitHubWebhookEvent("workflow_run", { action: "completed" })).toEqual({
      eligible: true,
      reason: "workflow_run.completed",
    });

    // #118 AC3: unsupported events
    expect(classifyGitHubWebhookEvent("issue_comment", { action: "created" })).toEqual({
      eligible: false,
      reason: "unsupported_event",
    });
    expect(classifyGitHubWebhookEvent("pull_request", { action: "synchronize" })).toEqual({
      eligible: false,
      reason: "unsupported_event",
    });
    expect(classifyGitHubWebhookEvent("push", {})).toEqual({
      eligible: false,
      reason: "unsupported_event",
    });
    expect(classifyGitHubWebhookEvent("star", { action: "created" })).toEqual({
      eligible: false,
      reason: "unsupported_event",
    });
    expect(classifyGitHubWebhookEvent(undefined, { action: "opened" })).toEqual({
      eligible: false,
      reason: "unsupported_event",
    });
  });

  test("GitHubWebhookService fails closed when secret is missing or empty", async () => {
    const fakeRegistry: any = {
      getProjectByRepoId: () => null,
      getProjectByRepoName: () => null,
    };
    const service = new GitHubWebhookService(fakeRegistry, { secret: "" });
    const req = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=" + "a".repeat(64),
        "X-GitHub-Delivery": "test-delivery",
      },
      body: JSON.stringify({ action: "opened" }),
    });

    const warned: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warned.push(msg);
    try {
      const res = await service.handleWebhook(req);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
      expect(warned.length).toBe(1);
      const log = JSON.parse(warned[0]);
      expect(log).toEqual({
        event: "github_webhook",
        status: "rejected",
        reason: "invalid_signature",
        delivery: "test-delivery",
      });
    } finally {
      console.warn = origWarn;
    }
  });

  test("GitHubWebhookService handles uppercase signature hex and rejects non-object JSON", async () => {
    const fakeProject = { id: "proj_123", status: "active" };
    const fakeRegistry: any = {
      getProjectByRepoId: (id: number) => (id === 101 ? fakeProject : null),
      getProjectByRepoName: (name: string) =>
        name.toLowerCase() === "acme/product" ? fakeProject : null,
    };
    const secret = "test-secret";
    const service = new GitHubWebhookService(fakeRegistry, { secret });

    // Uppercase hex in signature
    const validBody = JSON.stringify({ action: "opened", repository: { id: 101 } });
    const sigHex = createHmac("sha256", secret).update(validBody).digest("hex").toUpperCase();
    const req1 = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${sigHex}`,
        "X-GitHub-Delivery": "upper-case-sig",
        "X-GitHub-Event": "issues",
      },
      body: validBody,
    });
    const res1 = await service.handleWebhook(req1);
    expect(res1.status).toBe(202);
    expect(await res1.json()).toEqual({
      status: "accepted",
      delivery: "upper-case-sig",
      project_id: "proj_123",
    });

    // Valid signature but JSON payload is primitive (number) -> 400 invalid_payload
    const primBody = "12345";
    const primSig = computeSignature(primBody, secret);
    const req2 = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": primSig,
        "X-GitHub-Delivery": "primitive-json",
      },
      body: primBody,
    });
    const res2 = await service.handleWebhook(req2);
    expect(res2.status).toBe(400);
    expect(await res2.json()).toEqual({ error: "invalid_payload" });
  });

  test("GitHubWebhookService routes eligible events to onProjectWake and handles pending_wake", async () => {
    const fakeProject = { id: "proj_abc", status: "active" };
    const fakeRegistry: any = {
      getProjectByRepoId: (id: number) => (id === 101 ? fakeProject : null),
      getProjectByRepoName: () => null,
    };
    const secret = "wake-secret";
    const wakes: Array<{ projectId: string; reason: string }> = [];
    let nextWakeReturn: { triggered: boolean; pending_wake: boolean } = {
      triggered: true,
      pending_wake: false,
    };

    const service = new GitHubWebhookService(fakeRegistry, {
      secret,
      onProjectWake: (projectId, reason) => {
        wakes.push({ projectId, reason });
        return nextWakeReturn;
      },
    });

    // 1. Eligible issues.labeled with ready-for-agent
    const body1 = JSON.stringify({
      action: "labeled",
      repository: { id: 101 },
      label: { name: "ready-for-agent" },
    });
    const req1 = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": computeSignature(body1, secret),
        "X-GitHub-Delivery": "del-wake-1",
        "X-GitHub-Event": "issues",
      },
      body: body1,
    });
    const res1 = await service.handleWebhook(req1);
    expect(res1.status).toBe(202);
    expect(await res1.json()).toEqual({
      status: "accepted",
      delivery: "del-wake-1",
      project_id: "proj_abc",
    });
    expect(wakes).toEqual([{ projectId: "proj_abc", reason: "issues.labeled" }]);

    // 2. Capacity full -> pending_wake: true
    nextWakeReturn = { triggered: false, pending_wake: true };
    const body2 = JSON.stringify({
      action: "submitted",
      repository: { id: 101 },
    });
    const req2 = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": computeSignature(body2, secret),
        "X-GitHub-Delivery": "del-wake-2",
        "X-GitHub-Event": "pull_request_review",
      },
      body: body2,
    });
    const res2 = await service.handleWebhook(req2);
    expect(res2.status).toBe(202);
    expect(await res2.json()).toEqual({
      status: "accepted",
      delivery: "del-wake-2",
      project_id: "proj_abc",
      pending_wake: true,
    });
    expect(wakes.length).toBe(2);
    expect(wakes[1]).toEqual({ projectId: "proj_abc", reason: "pull_request_review.submitted" });

    // 3. Unsupported event -> 202 ignored with reason unsupported_event, onProjectWake NOT called
    const body3 = JSON.stringify({
      action: "created",
      repository: { id: 101 },
    });
    const req3 = new Request("http://localhost/api/v1/webhooks/github", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": computeSignature(body3, secret),
        "X-GitHub-Delivery": "del-wake-3",
        "X-GitHub-Event": "issue_comment",
      },
      body: body3,
    });
    const res3 = await service.handleWebhook(req3);
    expect(res3.status).toBe(202);
    expect(await res3.json()).toEqual({
      status: "ignored",
      reason: "unsupported_event",
      delivery: "del-wake-3",
    });
    // Wake count did not increment
    expect(wakes.length).toBe(2);
  });

  test("POST /api/v1/webhooks/github end-to-end against real backend server", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "factory-webhooks-http-")));
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
      `#!${process.execPath}
const args = process.argv.slice(2);
const path = process.env.TEST_LABELS;
if (args[0] !== "api") process.exit(2);
if (args[1] === "repos/acme/product") {
  console.log(JSON.stringify({ id: 101, nameWithOwner: "acme/product" }));
  process.exit(0);
}
if (args[1] !== "repos/acme/product/labels") process.exit(3);
const labels = await Bun.file(path).json();
if (args.includes("POST")) {
  const fields = Object.fromEntries(
    args
      .filter((val, idx) => args[idx - 1] === "-f")
      .map((val) => {
        const at = val.indexOf("=");
        return [val.slice(0, at), val.slice(at + 1)];
      }),
  );
  labels.push(fields);
  await Bun.write(path, JSON.stringify(labels));
  console.log(JSON.stringify(fields));
} else {
  console.log(JSON.stringify([labels]));
}
`,
      { mode: 0o700 },
    );

    const webhookSecret = "synthetic-webhook-secret-42";
    const operatorToken = randomBytes(32).toString("hex");
    const hostSecret = randomBytes(32).toString("hex");

    const mockHost = Bun.serve({
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
        FACTORY_HOST_URL: mockHost.url.origin,
        FACTORY_HOST_TOKEN: hostSecret,
        FACTORY_RUNTIME_CANDIDATE: "webhook-test",
        FACTORY_REMOTE_ACCESS: "1",
        FACTORY_OPERATOR_TOKEN: operatorToken,
        GITHUB_WEBHOOK_SECRET: webhookSecret,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    cleanupTasks.push(async () => {
      if (backend.exitCode === null) backend.kill("SIGTERM");
      const exit = await Promise.race([backend.exited, Bun.sleep(5000).then(() => "timeout")]);
      if (exit === "timeout") {
        backend.kill("SIGKILL");
        await backend.exited;
      }
      await mockHost.stop(true);
      rmSync(root, { recursive: true, force: true });
    });

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

    // Register active project via client with operator token
    const client = createFactoryClient({
      baseUrl: url,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${operatorToken}`);
        return fetch(input, { ...init, headers });
      },
    });
    const project = await client.registerProject({
      method: "local_checkout",
      name: "Product",
      checkout_path: checkout,
    });
    expect(project.repo_id).toBe(101);
    expect(project.repo_name).toBe("acme/product");
    expect(project.status).toBe("active");

    const webhookUrl = `${url}/api/v1/webhooks/github`;

    // AC1: Signature verification and authentication exemption
    // Non-POST method returns 405 with Allow: POST
    {
      const getRes = await fetch(webhookUrl, { method: "GET" });
      expect(getRes.status).toBe(405);
      expect(getRes.headers.get("Allow")).toBe("POST");
      expect(await getRes.json()).toEqual({ error: "method_not_allowed" });
    }

    // Missing signature header -> 401 { error: "invalid_signature" }
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GitHub-Delivery": "delivery-missing-sig",
        },
        body: JSON.stringify({ action: "opened" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }

    // Malformed signature header (no sha256= prefix) -> 401 { error: "invalid_signature" }
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256":
            "badformat1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcd",
          "X-GitHub-Delivery": "delivery-bad-prefix",
        },
        body: JSON.stringify({ action: "opened" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }

    // Malformed signature header (wrong hex length) -> 401 { error: "invalid_signature" }
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": "sha256=shorthex",
          "X-GitHub-Delivery": "delivery-short-sig",
        },
        body: JSON.stringify({ action: "opened" }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }

    // Signature mismatch (wrong secret / wrong digest) -> 401 { error: "invalid_signature" }
    {
      const body = JSON.stringify({ action: "opened" });
      const badSig = computeSignature(body, "wrong-secret");
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": badSig,
          "X-GitHub-Delivery": "delivery-wrong-sig",
        },
        body,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_signature" });
    }

    // Invalid JSON body with valid signature -> 400 { error: "invalid_payload" }
    {
      const invalidJson = "{ not-valid-json";
      const sig = computeSignature(invalidJson, webhookSecret);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": sig,
          "X-GitHub-Delivery": "delivery-invalid-json",
        },
        body: invalidJson,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_payload" });
    }

    // AC2: Validly signed request for active registered project -> 202 Accepted
    const validDeliveryId = "delivery-valid-001";
    const validPayload = JSON.stringify({
      action: "opened",
      repository: {
        id: 101,
        full_name: "acme/product",
      },
      issue: {
        number: 42,
        title: "Test issue",
      },
    });
    const validSig = computeSignature(validPayload, webhookSecret);
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": validSig,
          "X-GitHub-Delivery": validDeliveryId,
          "X-GitHub-Event": "issues",
        },
        body: validPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "accepted",
        delivery: validDeliveryId,
        project_id: project.id,
      });
    }

    // AC3: Re-sending identical X-GitHub-Delivery within deduplication window -> 202 Ignored (duplicate)
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": validSig,
          "X-GitHub-Delivery": validDeliveryId,
          "X-GitHub-Event": "issues",
        },
        body: validPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "ignored",
        reason: "duplicate",
        delivery: validDeliveryId,
      });
    }

    // Also match by repository full_name if id is missing or different
    // Since previous validPayload triggered monitor check, this concurrent event queues as pending_wake
    const nameDeliveryId = "delivery-by-name-002";
    const namePayload = JSON.stringify({
      action: "reopened",
      repository: {
        full_name: "acme/product",
      },
    });
    const nameSig = computeSignature(namePayload, webhookSecret);
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": nameSig,
          "X-GitHub-Delivery": nameDeliveryId,
          "X-GitHub-Event": "issues",
        },
        body: namePayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "accepted",
        delivery: nameDeliveryId,
        project_id: project.id,
        pending_wake: true,
      });
    }

    // #118 AC3: Unsupported events (issue_comment, issues labeled with non-ready-for-agent, missing X-GitHub-Event)
    {
      const commentPayload = JSON.stringify({
        action: "created",
        repository: { id: 101, full_name: "acme/product" },
      });
      const commentSig = computeSignature(commentPayload, webhookSecret);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": commentSig,
          "X-GitHub-Delivery": "delivery-unsupported-comment",
          "X-GitHub-Event": "issue_comment",
        },
        body: commentPayload,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: "ignored",
        reason: "unsupported_event",
        delivery: "delivery-unsupported-comment",
      });
    }

    {
      const docLabelPayload = JSON.stringify({
        action: "labeled",
        repository: { id: 101, full_name: "acme/product" },
        label: { name: "documentation" },
      });
      const docLabelSig = computeSignature(docLabelPayload, webhookSecret);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": docLabelSig,
          "X-GitHub-Delivery": "delivery-unsupported-label",
          "X-GitHub-Event": "issues",
        },
        body: docLabelPayload,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: "ignored",
        reason: "unsupported_event",
        delivery: "delivery-unsupported-label",
      });
    }

    {
      const noEventPayload = JSON.stringify({
        action: "opened",
        repository: { id: 101, full_name: "acme/product" },
      });
      const noEventSig = computeSignature(noEventPayload, webhookSecret);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": noEventSig,
          "X-GitHub-Delivery": "delivery-missing-event-header",
        },
        body: noEventPayload,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: "ignored",
        reason: "unsupported_event",
        delivery: "delivery-missing-event-header",
      });
    }

    // #118 AC1: issues labeled with ready-for-agent is accepted (with pending_wake coalesced while previous check is in-flight)
    {
      const readyLabelPayload = JSON.stringify({
        action: "labeled",
        repository: { id: 101, full_name: "acme/product" },
        label: { name: "ready-for-agent" },
      });
      const readyLabelSig = computeSignature(readyLabelPayload, webhookSecret);
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": readyLabelSig,
          "X-GitHub-Delivery": "delivery-ready-label",
          "X-GitHub-Event": "issues",
        },
        body: readyLabelPayload,
      });
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({
        status: "accepted",
        delivery: "delivery-ready-label",
        project_id: project.id,
        pending_wake: true,
      });
    }

    // AC4: Payloads referencing unregistered repository -> 202 Ignored ("unregistered_project")
    const unregDeliveryId = "delivery-unreg-003";
    const unregPayload = JSON.stringify({
      action: "opened",
      repository: {
        id: 99999,
        full_name: "acme/unregistered-repo",
      },
    });
    const unregSig = computeSignature(unregPayload, webhookSecret);
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": unregSig,
          "X-GitHub-Delivery": unregDeliveryId,
        },
        body: unregPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "ignored",
        reason: "unregistered_project",
        delivery: unregDeliveryId,
      });
    }

    // Payload missing repository -> 202 Ignored ("unregistered_project")
    const noRepoDeliveryId = "delivery-norepo-004";
    const noRepoPayload = JSON.stringify({
      action: "ping",
    });
    const noRepoSig = computeSignature(noRepoPayload, webhookSecret);
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": noRepoSig,
          "X-GitHub-Delivery": noRepoDeliveryId,
        },
        body: noRepoPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "ignored",
        reason: "unregistered_project",
        delivery: noRepoDeliveryId,
      });
    }

    // AC4 (cont.): Inactive project (e.g. held) -> 202 Ignored ("project_inactive")
    // Corrupt the checkout directory so integrity check marks project held
    rmSync(checkout, { recursive: true, force: true });
    // Trigger project check to ensure status updates to held
    const heldProjects = await client.projects();
    expect(heldProjects.find((p) => p.id === project.id)?.status).toBe("held");

    const heldDeliveryId = "delivery-held-005";
    const heldSig = computeSignature(validPayload, webhookSecret);
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": heldSig,
          "X-GitHub-Delivery": heldDeliveryId,
        },
        body: validPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "ignored",
        reason: "project_inactive",
        delivery: heldDeliveryId,
      });
    }

    // Re-sending held delivery within window -> 202 Ignored ("duplicate")
    {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Signature-256": heldSig,
          "X-GitHub-Delivery": heldDeliveryId,
        },
        body: validPayload,
      });
      expect(res.status).toBe(202);
      const ack = await res.json();
      expect(ack).toEqual({
        status: "ignored",
        reason: "duplicate",
        delivery: heldDeliveryId,
      });
    }
  }, 25000);
});
