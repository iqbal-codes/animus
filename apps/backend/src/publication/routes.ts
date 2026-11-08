import {
  draftPublicationListSchema,
  draftPublicationSchema,
  draftPublicationSubmissionSchema,
  publicationEvidenceBindingRequestSchema,
  publicationStatusListSchema,
  publicationStatusSchema,
} from "@animus/contracts/operator";
import { PublicationError } from "./errors";
import { DraftPublicationError } from "./issues";
import type { DraftPublicationService } from "./issues";
import type { PublicationService } from "./service";

function errorStatus(code: PublicationError["code"]): number {
  switch (code) {
    case "publication_target_not_found":
    case "publication_run_not_found":
    case "publication_evidence_not_found":
      return 404;
    case "publication_invalid_url":
      return 400;
    case "publication_wrong_binding":
    case "publication_summary_binding_ambiguous":
    case "publication_candidate_mismatch":
    case "publication_no_candidate":
    case "publication_remote_ref_mismatch":
    case "publication_head_unverified":
    case "publication_head_mismatch":
      return 409;
    case "publication_transport_unsupported":
    case "publication_push_failed":
    case "publication_push_unknown":
    case "publication_remote_unverified":
      return 502;
    default:
      return 500;
  }
}

function failure(error: unknown): Response {
  if (error instanceof PublicationError) {
    return Response.json(
      { error: error.code, message: error.message, details: error.details },
      { status: errorStatus(error.code) },
    );
  }
  return Response.json(
    {
      error: "publication_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}

export async function handleProjectPublicationRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: PublicationService,
): Promise<Response | null> {
  if (parts[1] !== "publication") return null;

  if (parts.length === 3 && parts[2] === "targets" && request.method === "GET") {
    const url = new URL(request.url);
    const statuses = service.listStatuses(projectId, {
      workId: url.searchParams.get("work_id") ?? undefined,
      deliveryId: url.searchParams.get("delivery_id") ?? undefined,
    });
    return Response.json(publicationStatusListSchema.parse(statuses));
  }

  if (parts.length === 3 && parts[2] === "reconcile" && request.method === "POST") {
    return Response.json(publicationStatusListSchema.parse(await service.reconcileAll(projectId)));
  }

  if (parts.length === 4 && parts[2] === "runs" && parts[3] && request.method === "GET") {
    try {
      const status = service.getStatusByRun(projectId, decodeURIComponent(parts[3]));
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 5 &&
    parts[2] === "runs" &&
    parts[3] &&
    parts[4] === "publish" &&
    request.method === "POST"
  ) {
    try {
      const status = await service.publishByRun(projectId, decodeURIComponent(parts[3]));
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (parts.length === 4 && parts[2] === "targets" && parts[3] && request.method === "GET") {
    try {
      const status = service.getStatus(projectId, decodeURIComponent(parts[3]));
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 5 &&
    parts[2] === "targets" &&
    parts[3] &&
    parts[4] === "publish" &&
    request.method === "POST"
  ) {
    try {
      const status = await service.publish(projectId, decodeURIComponent(parts[3]));
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 5 &&
    parts[2] === "targets" &&
    parts[3] &&
    parts[4] === "reconcile" &&
    request.method === "POST"
  ) {
    try {
      const status = await service.reconcile(projectId, decodeURIComponent(parts[3]));
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  if (
    parts.length === 7 &&
    parts[2] === "targets" &&
    parts[3] &&
    parts[4] === "evidence" &&
    parts[5] &&
    parts[6] === "bind" &&
    request.method === "POST"
  ) {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    const parsed = publicationEvidenceBindingRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_payload" }, { status: 400 });
    }
    try {
      const status = service.bindEvidence(
        projectId,
        decodeURIComponent(parts[3]),
        decodeURIComponent(parts[5]),
        parsed.data.hosted_url,
      );
      return Response.json(publicationStatusSchema.parse(status));
    } catch (error) {
      return failure(error);
    }
  }

  return null;
}

function draftPublicationFailure(error: unknown): Response {
  if (error instanceof DraftPublicationError) {
    const status =
      error.code === "draft_publication_not_found" ||
      error.code === "draft_publication_project_not_found"
        ? 404
        : error.code === "draft_publication_transport_unsupported"
          ? 502
          : error.code === "draft_publication_failed"
            ? 500
            : 409;
    return Response.json({ error: error.code, message: error.message }, { status });
  }
  return Response.json(
    {
      error: "draft_publication_failed",
      message: error instanceof Error ? error.message : String(error),
    },
    { status: 500 },
  );
}

/**
 * Approved-draft issue publication transport. The same durable intent ledger and
 * forge transport that #157 uses for delivery PRs is reused here; a publication
 * is never reported complete until every planned issue and relationship has been
 * read back from the remote.
 */
export async function handleProjectDraftPublicationRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: DraftPublicationService,
): Promise<Response | null> {
  if (parts[1] !== "draft-publications") return null;

  try {
    if (parts.length === 2) {
      if (request.method === "GET") {
        return Response.json(draftPublicationListSchema.parse(service.list(projectId)));
      }
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = draftPublicationSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const record = await service.publishDraft(projectId, parsed.data.draft_id);
        return Response.json(draftPublicationSchema.parse(record));
      }
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    }

    if (parts.length === 4 && parts[2] === "by-draft") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const record = service.getByDraft(projectId, decodeURIComponent(parts[3]!));
      if (!record) return Response.json({ error: "draft_publication_not_found" }, { status: 404 });
      return Response.json(draftPublicationSchema.parse(record));
    }

    if (parts.length === 3 && parts[2] && request.method === "GET") {
      const record = service.get(projectId, decodeURIComponent(parts[2]));
      return Response.json(draftPublicationSchema.parse(record));
    }

    if (parts.length === 4 && parts[2] && parts[3] === "reconcile" && request.method === "POST") {
      const record = await service.reconcile(projectId, decodeURIComponent(parts[2]));
      return Response.json(draftPublicationSchema.parse(record));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    return draftPublicationFailure(error);
  }
}
