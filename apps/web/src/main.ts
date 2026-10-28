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
  command_not_found: "Not found: requested command does not exist.",
  brake_active: "Refused: brake is active for this scope.",
  schedule_paused: "Refused: schedule is currently paused.",
  brake_state_unknown: "Refused: brake state could not be verified.",
  storage_failed: "Failed: command ledger storage failure prior to dispatch.",
  backup_failed: "Failed: database backup could not be completed.",
  target_drift: "Rejected: remote target drifted between admission and dispatch.",
  admission_rejected: "Rejected: target issue does not satisfy canonical admission criteria.",
  spec_parse_error: "Invalid: spec or ticket contract could not be parsed.",
  method_not_allowed: "Refused: HTTP method not allowed for this route.",
  plan_not_found: "Not found: requested coordination plan does not exist.",
  child_not_in_plan: "Not found: requested child ticket is not part of this plan.",
  child_already_integrated: "Refused: child ticket is already integrated into the branch.",
  spec_not_found: "Not found: requested spec or ticket could not be found on forge.",
  project_not_active: "Refused: project is not currently in active state.",
  prerequisites_not_satisfied: "Refused: prerequisite child tickets are not integrated or closed.",
  coordination_pipeline_halted:
    "Refused: coordination pipeline is halted due to a previous failure.",
  coordination_failed: "Failed: spec coordination operation failed.",
  integration_conflict: "Failed: merge conflict detected while integrating child into branch.",
  integration_drift: "Failed: branch drift detected during compare-and-swap merge.",
  integration_branch_unresolvable: "Failed: integration branch could not be resolved.",
  worktree_lock_conflict: "Refused: isolated worktree is exclusively locked by another process.",
  starting_sha_mismatch: "Refused: starting SHA does not match expected base SHA.",
  starting_sha_unresolvable: "Failed: starting SHA could not be resolved in the worktree.",
  branch_cleanliness_check_failed: "Failed: unable to check branch cleanliness in worktree.",
  worktree_dirty: "Refused: isolated worktree has uncommitted or untracked changes.",
  unintegrated_children_remain:
    "Refused: cannot create final PR while unintegrated children remain.",
  invalid_primitive: "Refused: targeted primitive is not permitted.",
  invalid_targeted_submission: "Invalid: targeted execution payload is malformed.",
  contract_digest_mismatch: "Refused: contract content does not match recorded digest.",
  final_pr_failed: "Failed: final pull request generation failed.",
  dispatch_failed: "Failed: child execution dispatch failed.",
  invalid_spec_number: "Invalid: spec issue number is missing or invalid.",
  dependency_cycle_detected: "Refused: circular dependency detected in child tickets.",
  dependency_resolution_stuck: "Failed: unresolvable dependencies in DAG.",
  git_command_failed: "Failed: underlying git command failed.",
  git_ref_error: "Failed: git ref could not be resolved.",
  checkout_failed: "Failed: git branch checkout failed.",
  rev_parse_failed: "Failed: git revision parse failed.",
  landing_guard_blocked: "Refused: landing guard blocked merge of unverified or drifted candidate.",
  candidate_drift: "Refused: candidate head SHA has drifted from verified evidence.",
  base_drift: "Refused: merge base SHA has drifted from verified evidence.",
  evidence_missing: "Refused: verified evidence record is missing for this candidate.",
  verification_failed: "Refused: candidate verification checks or review did not pass.",
  builder_self_approval_rejected: "Refused: builder self-approval is strictly forbidden.",
  freshness_check_failed: "Refused: consequential action freshness check exceeded 10s or failed.",
  confirmation_required: "Refused: explicit confirmation modal approval is required.",
  action_drift_detected: "Refused: target branch SHA drifted between confirmation and execution.",
  prerequisite_drift_detected: "Refused: prerequisite state drifted during live freshness check.",
  unauthorized_control: "Refused: unauthorized or mismatched scope for run control.",
  operation_unsupported: "Refused: requested run operation is not supported.",
  run_not_cancellable: "Refused: run is not in a cancellable state.",
  process_tree_termination_failed: "Failed: process tree termination or cleanup failed.",
  gate_not_found: "Not found: requested approval gate does not exist.",
  stale_candidate_drift: "Refused: candidate SHA has drifted from expected gate candidate.",
  unverified_candidate_blocked:
    "Refused: unverified candidate blocked from promotion or deployment.",
  release_policy_incomplete:
    "Refused: release-complete cannot be declared while policy stages are pending.",
  verification_not_found: "Not found: requested verification record does not exist.",
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
