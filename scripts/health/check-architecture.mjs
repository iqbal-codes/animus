import { fileURLToPath } from "node:url";
import { scanSnippet, checkArchitectureRules } from "./rules/code-boundaries.mjs";
import { checkWorkspacePackageEdges } from "./rules/workspace-edges.mjs";
import { checkOpenSourceGovernanceFiles } from "./governance/index.mjs";

// Re-export public API
export {
  scanSnippet,
  checkArchitectureRules,
  checkWorkspacePackageEdges,
  checkOpenSourceGovernanceFiles,
};

// Attach sub-methods for namespace compatibility
Object.assign(checkArchitectureRules, {
  scanSnippet,
  checkWorkspacePackageEdges,
  checkOpenSourceGovernanceFiles,
});

const isMain =
  process.argv[1] &&
  process.argv[1].endsWith("check-architecture.mjs") &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const repoRoot = process.cwd();
  let hasFailure = false;

  const archResult = checkArchitectureRules(repoRoot);
  if (!archResult.ok) {
    console.error("Architecture boundary check failed:");
    for (const v of archResult.violations) {
      console.error("  -", v);
    }
    hasFailure = true;
  }

  const pkgEdgesResult = checkWorkspacePackageEdges(repoRoot);
  if (!pkgEdgesResult.ok) {
    console.error("Workspace package edges check failed:");
    for (const v of pkgEdgesResult.violations) {
      console.error("  -", v);
    }
    hasFailure = true;
  }

  const govResult = checkOpenSourceGovernanceFiles(repoRoot);
  if (!govResult.ok) {
    console.error("Open-source governance check failed:");
    for (const v of govResult.violations) {
      console.error("  -", v);
    }
    hasFailure = true;
  }

  if (hasFailure) {
    process.exit(1);
  }

  console.log(
    "Architecture boundary rules, workspace package edges, and open-source governance passed cleanly.",
  );
}
