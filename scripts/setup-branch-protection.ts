#!/usr/bin/env bun
/**
 * Configures or verifies branch protection rules on GitHub.
 *
 * Note: On GitHub Free accounts, branch protection API requires
 * the repository to be PUBLIC. For PRIVATE repositories, GitHub Pro,
 * Team, or Enterprise is required by GitHub.
 */

import { spawnSync } from "node:child_process";

const OWNER_REPO = "iqbal-codes/animus";
const TARGET_BRANCHES = ["main", "development", "develop"];

export function applyBranchProtection(branch: string): { ok: boolean; message: string } {
  const protectionPayload = {
    required_status_checks: {
      strict: true,
      contexts: ["Gate Aggregate: CI Pass/Fail Evaluator"],
    },
    enforce_admins: false,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: 1,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };

  const res = spawnSync(
    "gh",
    [
      "api",
      "-X",
      "PUT",
      `repos/${OWNER_REPO}/branches/${branch}/protection`,
      "-H",
      "Accept: application/vnd.github+json",
      "--input",
      "-",
    ],
    {
      input: JSON.stringify(protectionPayload),
      encoding: "utf-8",
    },
  );

  if (res.status === 0) {
    return { ok: true, message: `Successfully protected ${branch}` };
  }

  const err = res.stderr || res.stdout;
  return { ok: false, message: err.trim() };
}

if (import.meta.main) {
  console.log(`Setting up branch protection for ${OWNER_REPO}...`);

  for (const branch of TARGET_BRANCHES) {
    const result = applyBranchProtection(branch);
    if (result.ok) {
      console.log(`✅ [${branch}] ${result.message}`);
    } else {
      console.warn(`⚠️ [${branch}] Could not apply GitHub API protection: ${result.message}`);
    }
  }
}
