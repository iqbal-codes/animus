/**
 * Runtime scheduling policy shared by the loop, monitor, board, and CLI.
 *
 * The policy lives inside each configuration layer's `schedule:` block — never
 * in a separate `schedule.json`. `normalizeScheduleBlock` is the single
 * validation point for every layer, so a malformed operator file fails with the
 * offending path named instead of silently falling back to defaults.
 */

export interface WorkWindowConfig {
  enabled: boolean;
  start_time: string;
  end_time: string;
  timezone: string;
}

export interface ScheduleConfig {
  workflow: string;
  parallel: number;
  max_laps: number;
  interval_seconds: number;
  inputs?: Record<string, unknown>;
  work_window?: WorkWindowConfig;
}

/** A layer may set any subset; the cascade fills the rest. */
export type ScheduleLayer = Partial<Omit<ScheduleConfig, "work_window">> & {
  work_window?: Partial<NonNullable<ScheduleConfig["work_window"]>>;
};

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates one layer's schedule block. `source` names the file/block so the
 * error points at what the operator actually edited.
 */
export function normalizeScheduleBlock(raw: unknown, source: string): ScheduleLayer | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid schedule block in '${source}': expected a mapping`);
  }
  const block = raw as Record<string, unknown>;

  const interval = block.interval_seconds;
  if (interval !== undefined && (!Number.isFinite(interval) || (interval as number) <= 0)) {
    throw new Error(`Invalid schedule interval in '${source}': must be a positive number`);
  }
  const parallel = block.parallel;
  if (parallel !== undefined && (!Number.isSafeInteger(parallel) || (parallel as number) <= 0)) {
    throw new Error(
      `Invalid schedule parallel capacity in '${source}': must be a positive integer`,
    );
  }
  const maxLaps = block.max_laps;
  if (maxLaps !== undefined && (!Number.isSafeInteger(maxLaps) || (maxLaps as number) <= 0)) {
    throw new Error(`Invalid schedule max_laps in '${source}': must be a positive integer`);
  }

  const workWindow = block.work_window;
  if (workWindow !== undefined && workWindow !== null) {
    if (typeof workWindow !== "object" || Array.isArray(workWindow)) {
      throw new Error(`Invalid schedule work_window in '${source}': expected a mapping`);
    }
    const window = workWindow as Record<string, unknown>;
    if (window.enabled) {
      if (
        typeof window.start_time !== "string" ||
        typeof window.end_time !== "string" ||
        !HH_MM.test(window.start_time) ||
        !HH_MM.test(window.end_time)
      ) {
        throw new Error(`Invalid schedule work window times in '${source}': expected HH:MM format`);
      }
      const tz =
        typeof window.timezone === "string" && window.timezone ? window.timezone : "Asia/Jakarta";
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
      } catch {
        throw new Error(`Invalid timezone in schedule config '${source}': '${tz}'`);
      }
    }
  }

  return {
    ...(typeof block.workflow === "string" ? { workflow: block.workflow } : {}),
    ...(typeof parallel === "number" && parallel > 0 ? { parallel } : {}),
    ...(typeof maxLaps === "number" && maxLaps > 0 ? { max_laps: maxLaps } : {}),
    ...(typeof interval === "number" && interval > 0 ? { interval_seconds: interval } : {}),
    ...(typeof block.inputs === "object" && block.inputs !== null
      ? { inputs: block.inputs as Record<string, unknown> }
      : {}),
    ...(typeof workWindow === "object" && workWindow !== null
      ? {
          work_window: {
            enabled: Boolean((workWindow as Record<string, unknown>).enabled),
            start_time:
              ((workWindow as Record<string, unknown>).start_time as string | undefined) || "20:00",
            end_time:
              ((workWindow as Record<string, unknown>).end_time as string | undefined) || "05:00",
            timezone:
              ((workWindow as Record<string, unknown>).timezone as string | undefined) ||
              "Asia/Jakarta",
          },
        }
      : {}),
  };
}

/** Deep-merges a schedule block onto a base layer; `work_window` merges per field. */
export function mergeScheduleLayer(base: ScheduleLayer, next: ScheduleLayer | null): ScheduleLayer {
  if (!next) return base;
  return {
    ...base,
    ...next,
    inputs: { ...base.inputs, ...next.inputs },
    work_window: { ...base.work_window, ...next.work_window },
  };
}
