export function scanSnippet(filePath: string, content: string): string[];
export function checkWorkspacePackageEdges(repoRoot: string): {
  ok: boolean;
  violations: string[];
};
export function checkOpenSourceGovernanceFiles(repoRoot: string): {
  ok: boolean;
  violations: string[];
};
export function checkArchitectureRules(repoRoot: string): {
  ok: boolean;
  violations: string[];
};
export namespace checkArchitectureRules {
  export { scanSnippet, checkWorkspacePackageEdges, checkOpenSourceGovernanceFiles };
}
