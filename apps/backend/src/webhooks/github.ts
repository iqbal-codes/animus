import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProjectRegistryService } from "../registry/service";
import type { WebhookAck } from "@animus/contracts/operator";
import type { ExecutionAuthority } from "@animus/contracts/execution-authority";

export interface GitHubWebhookOptions {
  secret?: string;
  ttlMs?: number;
  /**
   * Durable authority read. After the validated cutover, issue/label/closure
   * webhooks are observation only: they never reselect work or rebind contracts.
   * Remote CI events stay supported for readiness observation.
   */
  authority?: () => ExecutionAuthority;
  onProjectWake?: (
    projectId: string,
    reason: string,
  ) => { triggered: boolean; pending_wake: boolean } | void;
}

const SIGNATURE_REGEX = /^sha256=[0-9a-fA-F]{64}$/;

export class DeliveryDeduplicationCache {
  private cache = new Map<string, number>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs = 120_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  has(deliveryId: string, now = Date.now()): boolean {
    if (!deliveryId) return false;
    this.prune(now);
    const expiresAt = this.cache.get(deliveryId);
    if (expiresAt !== undefined && expiresAt > now) {
      this.cache.set(deliveryId, now + this.defaultTtlMs);
      return true;
    }
    return false;
  }

  record(deliveryId: string, now = Date.now(), ttlMs?: number): void {
    if (!deliveryId) return;
    this.cache.set(deliveryId, now + (ttlMs ?? this.defaultTtlMs));
  }

  prune(now = Date.now()): void {
    for (const [id, expiresAt] of this.cache.entries()) {
      if (expiresAt <= now) {
        this.cache.delete(id);
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }
}

export function classifyGitHubWebhookEvent(
  eventType: string | null | undefined,
  payload: Record<string, unknown>,
  authority: ExecutionAuthority = "legacy",
): { eligible: boolean; reason: string } {
  const event = (eventType ?? "").trim().toLowerCase();
  const action = typeof payload.action === "string" ? payload.action.toLowerCase() : "";

  // Once execution authority is local (or explicitly fenced while migrating),
  // GitHub issue edits/labels/closure are not an execution control plane. Only
  // remote CI observations remain eligible; manual feedback never creates work.
  if (authority !== "legacy") {
    if (event === "check_run" || event === "workflow_run") {
      return action === "completed"
        ? { eligible: true, reason: `${event}.completed` }
        : { eligible: false, reason: "unsupported_event" };
    }
    return { eligible: false, reason: "manual_feedback_ignored" };
  }

  if (event === "issues") {
    if (action === "labeled") {
      const label = payload.label as Record<string, unknown> | undefined;
      const labelName = typeof label?.name === "string" ? label.name.toLowerCase() : "";
      if (labelName === "ready-for-agent") {
        return { eligible: true, reason: "issues.labeled" };
      }
      return { eligible: false, reason: "unsupported_event" };
    }
    if (
      action === "opened" ||
      action === "reopened" ||
      action === "edited" ||
      action === "unlabeled"
    ) {
      return { eligible: true, reason: `issues.${action}` };
    }
    return { eligible: false, reason: "unsupported_event" };
  }

  // Human PR feedback is observation only. Manual comments, reviews and
  // request-changes must never create factory findings, rebind scope or allocate laps.
  if (event === "pull_request_review" || event === "issue_comment" || event === "pull_request") {
    return { eligible: false, reason: "manual_feedback_ignored" };
  }

  if (event === "check_run" || event === "workflow_run") {
    if (action === "completed") {
      return { eligible: true, reason: `${event}.completed` };
    }
    return { eligible: false, reason: "unsupported_event" };
  }

  return { eligible: false, reason: "unsupported_event" };
}

export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || secret.trim() === "") {
    return false;
  }
  if (!signatureHeader || !SIGNATURE_REGEX.test(signatureHeader)) {
    return false;
  }
  const providedHex = signatureHeader.slice(7).toLowerCase();
  const expectedHex = createHmac("sha256", secret).update(rawBody).digest("hex").toLowerCase();
  const providedBuf = Buffer.from(providedHex, "utf-8");
  const expectedBuf = Buffer.from(expectedHex, "utf-8");
  if (providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export class GitHubWebhookService {
  private readonly secret?: string;
  private readonly dedupCache: DeliveryDeduplicationCache;

  constructor(
    private registry: ProjectRegistryService,
    private options: GitHubWebhookOptions = {},
    dedupCache?: DeliveryDeduplicationCache,
  ) {
    this.secret = options.secret;
    this.dedupCache = dedupCache ?? new DeliveryDeduplicationCache(options.ttlMs);
  }

  async handleWebhook(request: Request): Promise<Response> {
    const delivery = request.headers.get("x-github-delivery") ?? undefined;
    const deliveryId = delivery ?? "";
    const secret = this.secret ?? process.env.GITHUB_WEBHOOK_SECRET;
    const signatureHeader = request.headers.get("x-hub-signature-256");

    const rawArrayBuffer = await request.arrayBuffer();
    const bodyBuffer = Buffer.from(rawArrayBuffer);

    if (!verifyGitHubSignature(bodyBuffer, signatureHeader, secret)) {
      console.warn(
        JSON.stringify({
          event: "github_webhook",
          status: "rejected",
          reason: "invalid_signature",
          delivery,
        }),
      );
      return Response.json({ error: "invalid_signature" }, { status: 401 });
    }

    if (delivery && this.dedupCache.has(delivery)) {
      console.log(
        JSON.stringify({
          event: "github_webhook",
          status: "duplicate",
          delivery,
        }),
      );
      const ack: WebhookAck = {
        status: "ignored",
        reason: "duplicate",
        delivery: deliveryId,
      };
      return Response.json(ack, { status: 202 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(bodyBuffer.toString("utf-8"));
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    if (typeof payload !== "object" || payload === null) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }

    const repo = (payload as Record<string, unknown>).repository as
      | Record<string, unknown>
      | undefined;
    let project = null;

    if (repo && typeof repo === "object") {
      if (typeof repo.id === "number") {
        project = this.registry.getProjectByRepoId(repo.id);
      }
      if (!project && typeof repo.full_name === "string") {
        project = this.registry.getProjectByRepoName(repo.full_name);
      }
    }

    if (delivery) {
      this.dedupCache.record(delivery);
    }

    if (!project || project.status !== "active") {
      const reason = !project ? "unregistered_project" : "project_inactive";
      console.log(
        JSON.stringify({
          event: "github_webhook",
          status: "ignored",
          reason,
          delivery,
        }),
      );
      const ack: WebhookAck = {
        status: "ignored",
        reason,
        delivery: deliveryId,
      };
      return Response.json(ack, { status: 202 });
    }

    const eventType = request.headers.get("x-github-event");
    const classification = classifyGitHubWebhookEvent(
      eventType,
      payload as Record<string, unknown>,
      this.options.authority?.() ?? "legacy",
    );

    if (!classification.eligible) {
      console.log(
        JSON.stringify({
          event: "github_webhook",
          status: "ignored",
          reason: classification.reason,
          delivery,
        }),
      );
      const ack: WebhookAck = {
        status: "ignored",
        reason: classification.reason,
        delivery: deliveryId,
      };
      return Response.json(ack, { status: 202 });
    }

    let wakeResult: { triggered: boolean; pending_wake: boolean } | void = undefined;
    if (this.options.onProjectWake) {
      try {
        wakeResult = this.options.onProjectWake(project.id, classification.reason);
      } catch (err) {
        console.error("Failed to wake project monitor:", err);
      }
    }

    const isPendingWake = Boolean(wakeResult?.pending_wake);
    console.log(
      JSON.stringify({
        event: "github_webhook",
        status: "accepted",
        delivery,
        project_id: project.id,
        ...(isPendingWake ? { pending_wake: true } : {}),
      }),
    );
    const ack: WebhookAck = {
      status: "accepted",
      delivery: deliveryId,
      project_id: project.id,
      ...(isPendingWake ? { pending_wake: true } : {}),
    };
    return Response.json(ack, { status: 202 });
  }
}

export async function handleGitHubWebhookRoute(
  request: Request,
  registry: ProjectRegistryService,
  options?: GitHubWebhookOptions,
): Promise<Response> {
  const service = new GitHubWebhookService(registry, options);
  return service.handleWebhook(request);
}
