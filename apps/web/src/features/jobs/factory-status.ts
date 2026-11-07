/** Factory API link state, shared by the shell, the board and the inbox. */
export type BackendState = "connected" | "disconnected" | "connecting";

/** Shared factory-link labels for the status footers on Jobs and Inbox. */
export const HEALTH: Record<BackendState, { label: string; dot: string }> = {
  connected: { label: "Factory connected", dot: "bg-success" },
  disconnected: { label: "Factory unreachable", dot: "bg-error" },
  connecting: { label: "Checking factory…", dot: "bg-warning" },
};
