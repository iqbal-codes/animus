/**
 * Personal preferences from `R5yIDY` ("Animus / Settings / Personal /
 * Preferences"). The source scopes them to "Only your experience" and "Does not
 * change how jobs run.", so they live in this browser and never reach the
 * factory API.
 *
 * `theme` ships a single value: the app has one palette and the document's light
 * theme is not implemented, so the select must not offer what it cannot render.
 */
export type CardDensity = "comfortable" | "compact";
export type StartupView = "inbox" | "jobs";

export type Preferences = {
  cardDensity: CardDensity;
  startupView: StartupView;
  notifyNeedsAttention: boolean;
  notifyFailedJobs: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  cardDensity: "comfortable",
  startupView: "inbox",
  notifyNeedsAttention: true,
  notifyFailedJobs: true,
};

const STORAGE_KEY = "animus.preferences.v1";

export function loadPreferences(): Preferences {
  if (typeof localStorage === "undefined") return DEFAULT_PREFERENCES;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_PREFERENCES;
    const value = parsed as Partial<Preferences>;
    return {
      cardDensity: value.cardDensity === "compact" ? "compact" : "comfortable",
      startupView: value.startupView === "jobs" ? "jobs" : "inbox",
      notifyNeedsAttention:
        typeof value.notifyNeedsAttention === "boolean"
          ? value.notifyNeedsAttention
          : DEFAULT_PREFERENCES.notifyNeedsAttention,
      notifyFailedJobs:
        typeof value.notifyFailedJobs === "boolean"
          ? value.notifyFailedJobs
          : DEFAULT_PREFERENCES.notifyFailedJobs,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(next: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be denied (private mode, disabled cookies); the session still
    // holds the values, so the modal keeps working without persistence.
  }
}
