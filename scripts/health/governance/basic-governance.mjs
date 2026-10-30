/**
 * Validates baseline open-source community, security, and contribution files:
 * LICENSE (MIT), CONTRIBUTING.md, SECURITY.md, and CHANGELOG.md.
 */

/**
 * @param {string} repoRoot
 * @param {(relPath: string, label: string) => string | null} readRequiredFile
 * @param {string[]} violations
 */
function validateBasicGovernance(repoRoot, readRequiredFile, violations) {
  // 1. LICENSE (MIT)
  const licenseContent = readRequiredFile("LICENSE", "License file");
  if (licenseContent !== null) {
    const hasMitMention = /MIT License|MIT/i.test(licenseContent);
    const hasGrant = /Permission is hereby granted/i.test(licenseContent);
    const hasRights = /without restriction/i.test(licenseContent);
    const hasDisclaimer = /without warranty of any kind/i.test(licenseContent);
    if (!hasMitMention || !hasGrant || !hasRights || !hasDisclaimer) {
      violations.push("LICENSE does not specify a valid MIT license");
    }
  }

  // 2. CONTRIBUTING.md
  const contributingContent = readRequiredFile("CONTRIBUTING.md", "Contributing guide");
  if (contributingContent !== null) {
    if (!contributingContent.includes("26.8.1")) {
      violations.push("CONTRIBUTING.md must document pinned Node version 26.8.1");
    }
    if (!contributingContent.includes("1.4.2")) {
      violations.push("CONTRIBUTING.md must document pinned Bun version 1.4.2");
    }
    if (!contributingContent.includes("labq-factory setup --local-only")) {
      violations.push("CONTRIBUTING.md must document 'labq-factory setup --local-only'");
    }
    if (!contributingContent.includes("bun run check")) {
      violations.push("CONTRIBUTING.md must document 'bun run check'");
    }
    if (!contributingContent.includes("bun run test")) {
      violations.push("CONTRIBUTING.md must document 'bun run test'");
    }
    if (!contributingContent.includes("bun run verify")) {
      violations.push("CONTRIBUTING.md must document 'bun run verify'");
    }
    if (
      !contributingContent.includes("@labq/contracts") ||
      !contributingContent.includes("@labq/client") ||
      !contributingContent.includes("apps/backend") ||
      !contributingContent.includes("apps/engine-host")
    ) {
      violations.push(
        "CONTRIBUTING.md must document architecture boundaries (@labq/contracts, @labq/client, apps/backend, apps/engine-host)",
      );
    }
  }

  // 3. SECURITY.md
  readRequiredFile("SECURITY.md", "Security policy");

  // 4. CHANGELOG.md
  const changelogContent = readRequiredFile("CHANGELOG.md", "Changelog");
  if (changelogContent !== null) {
    if (!changelogContent.includes("# Changelog")) {
      violations.push("CHANGELOG.md must contain '# Changelog' header");
    }
  }
}

export { validateBasicGovernance };
