export interface DeploymentVerificationResult {
  healthy: boolean;
  status: number;
  buildId?: string;
  matchedHead: boolean;
  error?: string;
}

export async function verifyDeployment(
  baseUrl: string,
  expectedCandidateSha: string,
  timeoutMs = 15_000,
): Promise<DeploymentVerificationResult> {
  const url = baseUrl.replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 1. Probe health endpoint
    const healthRes = await fetch(`${url}/health`, { signal: controller.signal });
    if (!healthRes.ok) {
      clearTimeout(timer);
      return {
        healthy: false,
        status: healthRes.status,
        matchedHead: false,
        error: `Health endpoint returned status ${healthRes.status}`,
      };
    }

    // 2. Probe build-id endpoint
    let buildId: string | undefined;
    try {
      const buildRes = await fetch(`${url}/build-id`, { signal: controller.signal });
      if (buildRes.ok) {
        buildId = (await buildRes.text()).trim();
      }
    } catch {}

    clearTimeout(timer);
    const matchedHead = !expectedCandidateSha || !buildId || buildId.startsWith(expectedCandidateSha.slice(0, 7));

    return {
      healthy: true,
      status: 200,
      buildId,
      matchedHead,
    };
  } catch (err: any) {
    clearTimeout(timer);
    return {
      healthy: false,
      status: 0,
      matchedHead: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
