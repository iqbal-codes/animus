export interface CheckResult {
  ok: boolean;
  violations: string[];
}

export const FORBIDDEN_WORKSPACE_DEPENDENCIES: Record<string, string[]>;

export function scanSnippet(filePath: string, content: string): string[];
export function checkWorkspacePackageEdges(repoRoot: string): CheckResult;
export function checkOpenSourceGovernanceFiles(repoRoot: string): CheckResult;
export function checkArchitectureRules(repoRoot: string): CheckResult;

export namespace checkArchitectureRules {
  export { scanSnippet, checkWorkspacePackageEdges, checkOpenSourceGovernanceFiles };
}
