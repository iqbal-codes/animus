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
};
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
