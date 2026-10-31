export interface CiJobNeedResult {
  result: "success" | "failure" | "cancelled" | "skipped" | (string & {});
  outputs?: Record<string, string | boolean>;
}

export interface CiGateEvaluation {
  ok: boolean;
  failures: string[];
}

export type CiGatesConfig =
  | string[]
  | {
      requiredJobs?: string[];
      isDraft?: boolean;
      draft?: boolean;
      is_draft?: boolean;
      [key: string]: unknown;
    }
  | string
  | boolean;

export const DEFAULT_REQUIRED_JOBS: string[];

export function evaluateCiGateOutcome(
  needs?: Record<string, CiJobNeedResult | string> | string | null,
  gates?: CiGatesConfig,
): CiGateEvaluation;
