export function scanSnippet(filePath: string, content: string): string[];
export function checkArchitectureRules(repoRoot: string): {
  ok: boolean;
  violations: string[];
};
export namespace checkArchitectureRules {
  export { scanSnippet };
}
