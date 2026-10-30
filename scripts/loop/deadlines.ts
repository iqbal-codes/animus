import type { LocalLoopOptions, LoopRole, RoleBudget } from "./types";

const roles: LoopRole[] = ["builder", "qa", "reviewer", "reflector", "planner", "investigator", "manager", "auditor", "simplifier"];
const MAX_TIMER_MS = 2_147_483_647;

export function validateTimeout(ms: number) {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    throw new Error("Timeout must be a positive integer within the platform timer range");
  }
}

// CLI callers inherit FACTORY_LOOP_<ROLE>_SOFT_MS / HARD_MS; explicit options win.
export function resolveRoleBudgets(
  options: LocalLoopOptions,
  env: Record<string, string | undefined> = process.env,
): Record<LoopRole, RoleBudget> {
  if (options.timeoutMs !== undefined) validateTimeout(options.timeoutMs);
  const continuations = options.maxContinuations ?? 1;
  if (!Number.isInteger(continuations) || continuations < 0 || continuations > 2) {
    throw new Error("maxContinuations must be an integer from 0 to 2");
  }
  for (const [role, budget] of Object.entries(options.roleBudgets ?? {})) {
    if (!roles.includes(role as LoopRole) || !budget) throw new Error(`Invalid role budget: ${role}`);
    validateTimeout(budget.softMs);
    validateTimeout(budget.hardMs);
    if (budget.softMs >= budget.hardMs) throw new Error(`Soft deadline must precede hard deadline: ${role}`);
  }
  return Object.fromEntries(roles.map((role) => {
    const prefix = `FACTORY_LOOP_${role.toUpperCase()}`;
    const defaults = role === "builder"
      ? { softMs: 20 * 60_000, hardMs: 25 * 60_000 }
      : { softMs: 15 * 60_000, hardMs: 20 * 60_000 };
    if (options.timeoutMs !== undefined) {
      return [role, { softMs: Math.floor(options.timeoutMs * 0.8), hardMs: options.timeoutMs }];
    }
    const configured = options.roleBudgets?.[role] ?? {
      softMs: env[`${prefix}_SOFT_MS`] === undefined ? defaults.softMs : Number(env[`${prefix}_SOFT_MS`]),
      hardMs: env[`${prefix}_HARD_MS`] === undefined ? defaults.hardMs : Number(env[`${prefix}_HARD_MS`]),
    };
    validateTimeout(configured.softMs);
    validateTimeout(configured.hardMs);
    if (configured.softMs >= configured.hardMs) throw new Error(`Soft deadline must precede hard deadline: ${role}`);
    return [role, configured];
  })) as Record<LoopRole, RoleBudget>;
}

export class RoleInterrupted extends Error {}

// Read interruption reports before normal verdict normalization, which rejects incomplete work.
export function interruptionReport(stdout: string): boolean {
  const interrupted = (value: any) => value?.verdict === "interrupted" || value?.status === "interrupted";
  const parse = (text: string): boolean => {
    try { return interrupted(JSON.parse(text)); } catch { return false; }
  };
  if (parse(stdout)) return true;
  for (const block of stdout.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/g)) {
    if (parse(block[1]!)) return true;
  }
  let finalText = "";
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        finalText = (Array.isArray(event.message.content) ? event.message.content : []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("");
      }
      if (typeof event.result === "string") finalText = event.result;
      if (typeof event.content === "string") finalText = event.content;
    } catch { /* Non-JSON provider output is handled above. */ }
  }
  return finalText ? interruptionReport(finalText) : false;
}
