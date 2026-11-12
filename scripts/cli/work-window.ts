export interface WorkWindowSpec {
  start: string;
  end: string;
}

/**
 * Parses an operator-supplied work window. Returns null for "off"; throws for
 * anything that is neither a 24-hour HH:MM-HH:MM range nor an explicit off.
 */
export function parseWorkWindow(value: string): WorkWindowSpec | null {
  const normalized = value.trim();
  if (["off", "false", "none"].includes(normalized)) return null;
  const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(normalized);
  if (!match || !match.slice(1).every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time!))) {
    throw new Error("Work window must be HH:MM-HH:MM with valid 24-hour times, or off.");
  }
  return { start: match[1]!, end: match[2]! };
}
