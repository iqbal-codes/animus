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
};
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
