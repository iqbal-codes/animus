import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {string} repoRoot
 * @returns {{ ok: boolean, violations: string[] }}
 */
export function checkWorkspacePackageEdges(repoRoot) {
  /** @type {string[]} */
  const violations = [];

  const workspaceRules = [
    {
      pkgRel: "packages/contracts/package.json",
      forbidden: [
        "@animus/client",
        "@animus/backend",
        "@animus/engine-host",
        "@animus/launcher",
        "@animus/web",
      ],
    },
    {
      pkgRel: "packages/client/package.json",
      forbidden: ["@animus/backend", "@animus/engine-host", "@animus/launcher", "@animus/web"],
    },
    {
      pkgRel: "apps/backend/package.json",
      forbidden: ["@animus/engine-host"],
    },
    {
      pkgRel: "apps/engine-host/package.json",
      forbidden: ["@animus/backend"],
    },
    {
      pkgRel: "apps/launcher/package.json",
      forbidden: [],
    },
    {
      pkgRel: "apps/web/package.json",
      forbidden: ["@animus/backend", "@animus/engine-host", "@animus/launcher"],
    },
  ];

  for (const { pkgRel, forbidden } of workspaceRules) {
    const fullPath = join(repoRoot, pkgRel);
    if (!existsSync(fullPath)) {
      violations.push(`${pkgRel}: package.json missing`);
      continue;
    }

    let pkgJson;
    try {
      const raw = readFileSync(fullPath, "utf-8");
      pkgJson = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      violations.push(`${pkgRel}: failed to parse package.json: ${message}`);
      continue;
    }

    const depSections = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];

    for (const section of depSections) {
      const deps = pkgJson[section];
      if (deps && typeof deps === "object") {
        for (const dep of Object.keys(deps)) {
          if (forbidden.includes(dep)) {
            violations.push(
              `${pkgRel}: forbidden workspace dependency "${dep}" declared in ${section}`,
            );
          }
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
  };
}
