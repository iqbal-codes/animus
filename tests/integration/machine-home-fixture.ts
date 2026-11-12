import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformSettingsSchema, writeMachineConfig } from "@animus/contracts/machine-config";

export interface OnboardedHomeFixture {
  home: string;
  restore: () => void;
}

/**
 * Points ANIMUS_HOME at a temporary directory containing an onboarded machine
 * configuration. Per-repository `animus setup` refuses to run without one, so
 * every test that executes setup must establish this precondition explicitly.
 */
export function installOnboardedAnimusHome(): OnboardedHomeFixture {
  const previous = process.env.ANIMUS_HOME;
  const home = mkdtempSync(join(tmpdir(), "animus-home-"));
  writeMachineConfig(
    platformSettingsSchema.parse({
      schemaVersion: 1,
      system: {
        onboardedAt: "2026-01-01T00:00:00.000Z",
        defaultProvider: "pi",
        runtimeRoot: join(home, "source"),
      },
      providers: [],
      automation: {
        parallelJobs: 2,
        maxLaps: 3,
        pollInterval: 300,
        continuations: 1,
        limitWorkWindow: false,
        startTime: "20:00",
        endTime: "05:00",
        timezone: "Asia/Jakarta (UTC+7)",
        schedulePaused: false,
        globalBrake: false,
      },
    }),
    home,
  );

  process.env.ANIMUS_HOME = home;

  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.ANIMUS_HOME;
      else process.env.ANIMUS_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
