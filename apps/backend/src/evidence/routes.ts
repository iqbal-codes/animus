import {
  candidateVerificationSubmissionSchema,
  candidateVerificationRecordSchema,
  landingSubmissionSchema,
  landingExecutionResultSchema,
  tieredActionSubmissionSchema,
  tieredActionResultSchema,
  runCancellationSubmissionSchema,
  runCancellationResultSchema,
  gateApprovalSubmissionSchema,
  gateApprovalRecordSchema,
  releaseReadinessResultSchema,
  sanitizedReportSchema,
  landingGuardResultSchema,
  executionObservationRequestSchema,
  executionObservationRecordSchema,
  observationListSchema,
  findingListSchema,
  factoryFindingRecordSchema,
  findingFixSubmissionSchema,
  findingRecheckSubmissionSchema,
  acceptanceDecisionSchema,
  runEvidenceReportSchema,
} from "@animus/contracts/operator";
import type { EvidenceService } from "./service";
import { EvidenceError } from "./errors";

export async function handleProjectEvidenceRoute(
  request: Request,
  projectId: string,
  parts: string[],
  service: EvidenceService,
): Promise<Response | null> {
  // Support both parts = ["projects", projectId, "evidence", subAction, ...]
  // and parts = [projectId, "evidence", subAction, ...] from main.ts
  const offset = parts[0] === "projects" ? 1 : 0;
  if (parts.length < offset + 2 || parts[offset + 1] !== "evidence") return null;

  const subAction = parts[offset + 2];

  try {
    // Candidate-bound execution observations, findings and finalized artifacts.
    if (subAction === "observations") {
      if (parts.length === offset + 4) {
        if (request.method !== "GET") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        }
        const record = service.observations.getObservation(
          projectId,
          decodeURIComponent(parts[offset + 3]!),
        );
        return Response.json(executionObservationRecordSchema.parse(record));
      }
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = executionObservationRequestSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const { run_id, ...submission } = parsed.data;
        const record = service.observations.recordRunObservation(projectId, run_id, submission);
        return Response.json(executionObservationRecordSchema.parse(record), { status: 201 });
      }
      if (request.method === "GET") {
        const url = new URL(request.url);
        const records = service.observations.listObservations(projectId, {
          runId: url.searchParams.get("run_id") ?? undefined,
          deliveryId: url.searchParams.get("delivery_id") ?? undefined,
          candidateHeadSha: url.searchParams.get("candidate_head_sha") ?? undefined,
          workId: url.searchParams.get("work_id") ?? undefined,
        });
        return Response.json(observationListSchema.parse(records));
      }
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    }

    if (subAction === "findings") {
      if (parts.length === offset + 5) {
        const findingId = decodeURIComponent(parts[offset + 3]!);
        const operation = parts[offset + 4];
        if (request.method !== "POST") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "POST" } },
          );
        }
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        if (operation === "fix") {
          const parsed = findingFixSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const finding = service.observations.recordFindingFix(projectId, findingId, parsed.data);
          return Response.json(factoryFindingRecordSchema.parse(finding));
        }
        if (operation === "recheck") {
          const parsed = findingRecheckSubmissionSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const finding = service.observations.recordFindingRecheck(
            projectId,
            findingId,
            parsed.data,
          );
          return Response.json(factoryFindingRecordSchema.parse(finding));
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      }

      if (parts.length === offset + 4) {
        if (request.method !== "GET") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { Allow: "GET" } },
          );
        }
        const finding = service.observations.getFinding(
          projectId,
          decodeURIComponent(parts[offset + 3]!),
        );
        return Response.json(factoryFindingRecordSchema.parse(finding));
      }

      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const url = new URL(request.url);
      const findings = service.observations.listFindings(projectId, {
        runId: url.searchParams.get("run_id") ?? undefined,
        deliveryId: url.searchParams.get("delivery_id") ?? undefined,
        workId: url.searchParams.get("work_id") ?? undefined,
        status: (url.searchParams.get("status") as "open" | "resolved" | null) ?? undefined,
      });
      return Response.json(findingListSchema.parse(findings));
    }

    if (subAction === "acceptance" && parts.length === offset + 4) {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const decision = service.observations.evaluateAcceptance(
        projectId,
        decodeURIComponent(parts[offset + 3]!),
      );
      return Response.json(acceptanceDecisionSchema.parse(decision));
    }

    if (subAction === "runs" && parts.length === offset + 4) {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const report = service.observations.getRunEvidence(
        projectId,
        decodeURIComponent(parts[offset + 3]!),
      );
      return Response.json(runEvidenceReportSchema.parse(report));
    }

    // 1. Verification Records (AC1, AC2)
    if (subAction === "verification") {
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const parsed = candidateVerificationSubmissionSchema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "invalid_payload" }, { status: 400 });
        }
        const record = service.recordVerification(projectId, parsed.data);
        return Response.json(candidateVerificationRecordSchema.parse(record), { status: 201 });
      }

      if (request.method === "GET") {
        if (parts.length === offset + 4) {
          const prNumber = parseInt(parts[offset + 3], 10);
          if (isNaN(prNumber) || prNumber <= 0) {
            return Response.json({ error: "invalid_payload" }, { status: 400 });
          }
          const record = service.getVerificationByPr(projectId, prNumber);
          if (!record) {
            return Response.json({ error: "verification_not_found" }, { status: 404 });
          }
          return Response.json(candidateVerificationRecordSchema.parse(record));
        }
        const records = service.listVerifications(projectId);
        return Response.json(records.map((r) => candidateVerificationRecordSchema.parse(r)));
      }

      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    }

    // 2. Landing Guard (AC1, AC2)
    if (subAction === "landing-guard") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      if (parts.length !== offset + 4) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const prNumber = parseInt(parts[offset + 3], 10);
      if (isNaN(prNumber) || prNumber <= 0) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      const url = new URL(request.url);
      const currentHeadSha = url.searchParams.get("headSha") || undefined;
      const currentBaseSha = url.searchParams.get("baseSha") || undefined;

      const evalResult = await service.evaluateLanding(projectId, prNumber, {
        currentHeadSha,
        currentBaseSha,
      });

      return Response.json(landingGuardResultSchema.parse(evalResult));
    }

    // 3. Execute Landing (AC1, AC2)
    if (subAction === "landing") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = landingSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      const result = await service.executeLanding(projectId, parsed.data);
      return Response.json(landingExecutionResultSchema.parse(result));
    }

    // 4. Tiered Action Matrix Execution (AC3)
    if (subAction === "tiered-action") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = tieredActionSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      // Live freshness resolver querying git checkout & live prerequisites (AC3)
      const resolver = service.createLiveFreshnessResolver(projectId);

      const result = await service.executeTieredAction(projectId, parsed.data, resolver);
      return Response.json(tieredActionResultSchema.parse(result));
    }

    // 5. Run Cancellation & Process Tree Termination (AC4)
    if (subAction === "cancel-run") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = runCancellationSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      const result = await service.cancelRun(projectId, parsed.data);
      return Response.json(runCancellationResultSchema.parse(result));
    }

    // 6. Gate Approval (AC5)
    if (subAction === "gate-approval") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "POST" } },
        );
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const parsed = gateApprovalSubmissionSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }

      const result = service.approveGate(projectId, parsed.data);
      return Response.json(gateApprovalRecordSchema.parse(result), { status: 201 });
    }

    // 7. Release Readiness (AC5)
    if (subAction === "release-readiness") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      if (parts.length !== offset + 4) {
        return Response.json({ error: "invalid_payload" }, { status: 400 });
      }
      const candidateSha = decodeURIComponent(parts[offset + 3]);
      const result = service.getReleaseReadiness(projectId, candidateSha);
      return Response.json(releaseReadinessResultSchema.parse(result));
    }

    // 8. Sanitized Reports (AC6 - Invariant 4: Always sanitized)
    if (subAction === "report" && parts.length >= offset + 4) {
      if (request.method !== "GET") {
        return Response.json(
          { error: "method_not_allowed" },
          { status: 405, headers: { Allow: "GET" } },
        );
      }
      const prNumber = parseInt(parts[offset + 3], 10);
      const isSanitized = parts[offset + 4] === "sanitized";
      const verif = service.getVerificationByPr(projectId, prNumber);
      if (!verif) {
        return Response.json({ error: "report_not_found" }, { status: 404 });
      }

      const rawReport = `# Verification Report for PR #${prNumber}
Candidate Head: ${verif.candidateHeadSha}
Base: ${verif.mergeBaseSha}
Status: ${verif.verificationStatus}
Producer: ${verif.producerIdentity.id} (${verif.producerIdentity.role})

## Checks
${verif.checks.map((c) => `- [${c.result}] ${c.name}: \`${c.command}\``).join("\n")}

## Review
${verif.review ? verif.review.summary : "No review conducted."}`;

      // Invariant 4: Always sanitized before transport to client
      const sanitized = service.sanitizeReport(rawReport);

      if (isSanitized || request.headers.get("Accept")?.includes("application/json")) {
        return Response.json(sanitizedReportSchema.parse(sanitized));
      }

      return new Response(sanitized.report, {
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }

    return null;
  } catch (err: any) {
    if (err instanceof EvidenceError) {
      const statusMap: Record<string, number> = {
        project_not_found: 404,
        verification_not_found: 404,
        report_not_found: 404,
        gate_not_found: 404,
        confirmation_required: 400,
        invalid_payload: 400,
        unauthorized_control: 403,
        landing_guard_blocked: 422,
        builder_self_approval_rejected: 422,
        candidate_drift: 422,
        base_drift: 422,
        verification_failed: 422,
        action_drift_detected: 422,
        freshness_check_failed: 422,
        prerequisite_drift_detected: 422,
        run_not_cancellable: 422,
        operation_unsupported: 422,
        stale_candidate_drift: 422,
        unverified_candidate_blocked: 422,
        release_policy_incomplete: 422,
        process_tree_termination_failed: 500,
        observation_not_found: 404,
        finding_not_found: 404,
        artifact_not_found: 404,
        run_not_found: 404,
        artifact_corrupt: 422,
        artifact_unsafe_path: 422,
        forged_ownership: 422,
        self_certification_rejected: 422,
        stale_candidate_evidence: 422,
        acceptance_blocked: 422,
        invalid_stage_producer: 422,
      };
      const status = statusMap[err.code] ?? 400;
      return Response.json({ error: err.code, details: err.details }, { status });
    }
    return Response.json({ error: "control_failed" }, { status: 500 });
  }
}
