import { createFactoryClient, FactoryClientError, type FactoryErrorCode } from "@labq/client";
import "./style.css";

const status = document.querySelector<HTMLElement>("#status");
const identities = document.querySelector<HTMLElement>("#identities");
const backendId = document.querySelector<HTMLElement>("#backend-id");
const hostId = document.querySelector<HTMLElement>("#host-id");
const refresh = document.querySelector<HTMLButtonElement>("#refresh");
if (!status || !identities || !backendId || !hostId || !refresh)
  throw new Error("Missing health view");
const elements = { status, identities, backendId, hostId, refresh };
const client = createFactoryClient({ baseUrl: location.origin });
const messages: Record<FactoryErrorCode, string> = {
  host_unavailable: "Unavailable: engine host is not reachable.",
  host_unauthorized: "Unavailable: engine host authentication failed.",
  invalid_host_response: "Unavailable: engine host returned invalid data.",
  candidate_mismatch: "Unavailable: backend and host candidates differ.",
  transport_unavailable: "Unavailable: backend is not reachable.",
  invalid_operator_response: "Unavailable: backend returned invalid data.",
  native_source_unavailable: "Unavailable: native engine source is not configured or reachable.",
  native_state_unavailable: "Unavailable: native engine state could not be read.",
  lap_not_found: "Not found: requested lap does not exist.",
  scope_mismatch: "Unavailable: requested resource belongs to another scope.",
  launch_brake_set: "Refused: local launch brake is active.",
  native_launch_failed: "Failed: native workflow launch failed.",
  invalid_payload: "Invalid: launch request payload is malformed.",
  intake_unavailable: "Unavailable: backlog intake could not be loaded.",
  issue_not_found: "Not found: requested issue does not exist.",
  control_failed: "Failed: control action could not be completed.",
  report_not_found: "Not found: requested evidence report does not exist.",
  evidence_unavailable: "Unavailable: candidate evidence could not be determined.",
  no_unpromoted_commits: "Refused: no unpromoted commits found between develop and main.",
  promotion_pr_already_open: "Refused: a promotion PR is already open.",
  promotion_failed: "Failed: promotion PR creation failed.",
  partial_promotion_effect: "Warning: PR created, but local freeze brake failed.",
  project_not_found: "Not found: requested project does not exist.",
  project_already_exists: "Refused: an active project with this repository ID already exists.",
  project_checkout_invalid: "Invalid: project checkout path is missing or invalid.",
  project_has_active_runs: "Refused: project has active runs and cannot be deregistered.",
  partial_registration_effect:
    "Warning: remote repository created or cloned, but checkout validation failed.",
  retarget_rejected: "Refused: retarget repository ID does not match the active project.",
  target_drift: "Rejected: remote target drifted between admission and dispatch.",
  admission_rejected: "Rejected: target issue does not satisfy canonical admission criteria.",
  spec_parse_error: "Invalid: spec or ticket contract could not be parsed.",
};
const controlStatus = document.querySelector<HTMLElement>("#control-status");
const btnHalt = document.querySelector<HTMLButtonElement>("#btn-halt");
const btnUnhalt = document.querySelector<HTMLButtonElement>("#btn-unhalt");
const btnPause = document.querySelector<HTMLButtonElement>("#btn-pause");
const btnUnpause = document.querySelector<HTMLButtonElement>("#btn-unpause");

async function loadControls() {
  if (!controlStatus) return;
  try {
    const state = await client.controlState();
    controlStatus.textContent = `Controls: ${state.halted ? "HALTED" : "Running"} | ${state.paused ? "PAUSED" : "Active"} (Brake: ${state.active_brake.toUpperCase()})`;
  } catch (error) {
    controlStatus.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Unavailable: control request failed.";
  }
}

async function handleControl(action: "halt" | "unhalt" | "pause" | "unpause") {
  if (!controlStatus) return;
  controlStatus.textContent = `Applying ${action}…`;
  try {
    const state = await client.control(action);
    controlStatus.textContent = `Controls: ${state.halted ? "HALTED" : "Running"} | ${state.paused ? "PAUSED" : "Active"} (Brake: ${state.active_brake.toUpperCase()})`;
  } catch (error) {
    controlStatus.textContent =
      error instanceof FactoryClientError ? messages[error.code] : "Failed: control action failed.";
  }
}

btnHalt?.addEventListener("click", () => void handleControl("halt"));
btnUnhalt?.addEventListener("click", () => void handleControl("unhalt"));
btnPause?.addEventListener("click", () => void handleControl("pause"));
btnUnpause?.addEventListener("click", () => void handleControl("unpause"));
void loadControls();
const intakeList = document.querySelector<HTMLElement>("#intake-list");
const intakeStatus = document.querySelector<HTMLElement>("#intake-status");
const intakeRefresh = document.querySelector<HTMLButtonElement>("#intake-refresh");

async function loadIntake(force = false) {
  if (!intakeList || !intakeStatus) return;
  if (intakeRefresh) intakeRefresh.disabled = true;
  intakeStatus.textContent = "Loading intake…";
  try {
    const intake = await client.intake({ refresh: force });
    intakeStatus.textContent = `Intake: ${intake.admitted_count} admitted, ${intake.held_count} held, ${intake.excluded_count} excluded (total ${intake.total_count}).`;
    intakeList.innerHTML = "";
    for (const issue of intake.issues) {
      const item = document.createElement("li");
      item.setAttribute("data-issue-number", String(issue.number));
      item.setAttribute("data-status", issue.admission_status);
      const labelText = issue.labels.join(", ") || "no labels";
      const recText = issue.recommended_label ? ` [rec: ${issue.recommended_label}]` : "";
      item.textContent = `#${issue.number} ${issue.title} - ${issue.admission_status.toUpperCase()} (${issue.reason}) [${labelText}]${recText}`;
      intakeList.appendChild(item);
    }
  } catch (error) {
    intakeStatus.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Unavailable: intake request failed.";
  } finally {
    if (intakeRefresh) intakeRefresh.disabled = false;
  }
}

if (intakeRefresh) {
  intakeRefresh.addEventListener("click", () => {
    void loadIntake(true);
  });
}
void loadIntake();
const evidenceStatus = document.querySelector<HTMLElement>("#evidence-status");
const evidenceDetails = document.querySelector<HTMLElement>("#evidence-details");
const reportContent = document.querySelector<HTMLPreElement>("#report-content");

export async function showEvidence(lapId: string) {
  if (!evidenceStatus || !evidenceDetails || !reportContent) return;
  evidenceStatus.textContent = `Loading evidence for ${lapId}…`;
  evidenceDetails.innerHTML = "";
  reportContent.hidden = true;
  try {
    const ev = await client.evidence(lapId);
    evidenceStatus.textContent = `Lap ${lapId}: Verification [${ev.runtime_verification.status.toUpperCase()}] | Review [${ev.peer_review.status.toUpperCase()}]`;
    const summary = document.createElement("p");
    summary.textContent = `Candidate Head: ${ev.candidate_head ?? "None"} | Outcome: ${ev.peer_review.outcome ?? "None"} | Blocking findings: ${ev.peer_review.blocking_findings}`;
    evidenceDetails.appendChild(summary);

    if (ev.peer_review.report.available) {
      const btnReport = document.createElement("button");
      btnReport.type = "button";
      btnReport.textContent = "View Report";
      btnReport.addEventListener("click", async () => {
        try {
          const rep = await client.report(lapId);
          reportContent.textContent = rep;
          reportContent.hidden = false;
        } catch (e) {
          reportContent.textContent =
            e instanceof FactoryClientError ? messages[e.code] : "Failed to load report.";
          reportContent.hidden = false;
        }
      });
      evidenceDetails.appendChild(btnReport);
    }
  } catch (error) {
    evidenceStatus.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Unavailable: evidence request failed.";
  }
}

async function load() {
  elements.refresh.disabled = true;
  elements.identities.hidden = true;
  elements.backendId.textContent = "";
  elements.hostId.textContent = "";
  elements.status.textContent = "Loading…";
  try {
    const health = await client.health();
    elements.backendId.textContent = health.buildId;
    elements.hostId.textContent = health.host.buildId;
    elements.identities.hidden = false;
    elements.status.textContent = "Healthy: backend and engine host connected.";
  } catch (error) {
    elements.status.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Unavailable: health request failed.";
  } finally {
    elements.refresh.disabled = false;
  }
}
elements.refresh.addEventListener("click", () => {
  void load();
});
void load();

const promotionStatus = document.querySelector<HTMLElement>("#promotion-status");
const promotionDetails = document.querySelector<HTMLElement>("#promotion-details");
const btnPromote = document.querySelector<HTMLButtonElement>("#btn-promote");

async function loadPromotionStatus() {
  if (!promotionStatus || !promotionDetails) return;
  promotionStatus.textContent = "Loading promotion status…";
  try {
    const status = await client.promotionStatus();
    promotionStatus.textContent = `Promotion: ${status.unpromoted_count} unpromoted commits (Freeze: ${status.candidate_freeze ? "ACTIVE" : "None"}). Ready: ${status.ready_to_promote ? "YES" : "NO"}`;
    promotionDetails.innerHTML = "";
    if (status.existing_pr) {
      const p = document.createElement("p");
      p.textContent = `Open PR: #${status.existing_pr.number} - ${status.existing_pr.title} (${status.existing_pr.url})`;
      promotionDetails.appendChild(p);
    }
    if (btnPromote) btnPromote.disabled = !status.ready_to_promote;
  } catch (error) {
    promotionStatus.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Unavailable: promotion status failed.";
  }
}

async function handlePromote() {
  if (!promotionStatus || !promotionDetails) return;
  promotionStatus.textContent = "Preparing promotion PR…";
  if (btnPromote) btnPromote.disabled = true;
  try {
    const res = await client.preparePromotion();
    if (res.partial_effect) {
      promotionStatus.textContent = `Warning: PR #${res.pr_number} created, but local freeze failed: ${res.local_effect_error}`;
    } else {
      promotionStatus.textContent = `Success: PR #${res.pr_number} prepared! Candidate freeze active.`;
    }
    void loadPromotionStatus();
    void loadControls();
  } catch (error) {
    promotionStatus.textContent =
      error instanceof FactoryClientError
        ? messages[error.code]
        : "Failed: promotion prepare failed.";
    if (btnPromote) btnPromote.disabled = false;
  }
}

btnPromote?.addEventListener("click", () => void handlePromote());
void loadPromotionStatus();
