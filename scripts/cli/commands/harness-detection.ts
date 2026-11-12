import { spawnSync } from "node:child_process";
import {
  PROVIDER_DESCRIPTORS,
  SUPPORTED_PROVIDERS,
  type EffortRung,
  type SupportedProvider,
} from "../../loop/providers";

export interface DetectedHarnessProvider {
  id: SupportedProvider;
  displayName: string;
  binaryName: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  status: "active" | "coming_soon";
  supportedEfforts: readonly EffortRung[];
}

/**
 * Detects which agent harness binaries exist on this machine. Presence is not
 * authentication: a harness can be installed and still be logged out.
 */
export function detectAvailableHarnesses(): DetectedHarnessProvider[] {
  const results: DetectedHarnessProvider[] = [];

  for (const id of SUPPORTED_PROVIDERS) {
    const desc = PROVIDER_DESCRIPTORS[id];
    const whichRes = spawnSync("which", [desc.binaryName], {
      encoding: "utf-8",
      timeout: 3000,
    });
    const installed = whichRes.status === 0 && Boolean((whichRes.stdout || "").trim());
    const binaryPath = installed ? (whichRes.stdout || "").trim() : null;

    let version: string | null = null;
    if (installed) {
      try {
        const verRes = spawnSync(desc.binaryName, ["--version"], {
          encoding: "utf-8",
          timeout: 3000,
        });
        const firstLine = ((verRes.stdout || verRes.stderr || "").split("\n")[0] || "").trim();
        if (firstLine) version = firstLine.slice(0, 80);
      } catch {}
    }

    results.push({
      id,
      displayName: desc.displayName,
      binaryName: desc.binaryName,
      installed,
      binaryPath,
      version,
      status: desc.status,
      supportedEfforts: desc.supportedEfforts,
    });
  }

  return results;
}
