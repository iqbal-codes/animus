import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface ExtractChangelogNotesOptions {
  appendVerification?: boolean;
  appendInstallInstructions?: boolean;
  repo?: string;
}

/**
 * Extracts release notes for a specified version from CHANGELOG.md text.
 * Optionally appends multi-channel installation instructions and SHA-256 checksum verification instructions.
 */
export function extractChangelogNotes(
  changelogText: string,
  version: string,
  options: ExtractChangelogNotesOptions = {},
): string {
  const cleanVersion = version.replace(/^v/, "").trim();
  const escaped = cleanVersion.replace(/\./g, "\\.");
  const headingRegex = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s+-\\s+.*)?$`, "m");
  const match = changelogText.match(headingRegex);

  let body = "";
  if (!match || match.index === undefined) {
    body = `## Release v${cleanVersion}\n\nAutomated release build for animus v${cleanVersion}.`;
  } else {
    const startIndex = match.index;
    const afterHeading = changelogText.slice(startIndex + match[0].length);
    const nextHeadingMatch = afterHeading.match(/\n##\s+/);
    const nextIndex = nextHeadingMatch?.index;
    const section =
      nextIndex !== undefined
        ? changelogText.slice(startIndex, startIndex + match[0].length + nextIndex)
        : changelogText.slice(startIndex);
    body = section.trim();
  }

  const repo = (options.repo ?? "iqbal-codes/animus").trim();

  if (options.appendInstallInstructions !== false) {
    const installBlock = [
      "",
      "### Installation",
      "```sh",
      "# POSIX Shell Installer (macOS & Linux)",
      `curl -fsSL https://github.com/${repo}/releases/latest/download/install.sh | sh`,
      "",
      "# Bun Global Package",
      `bun add -g github:${repo}`,
      "",
      "# Homebrew Tap (macOS & Linux)",
      "brew install iqbal-codes/tap/animus",
      "```",
    ].join("\n");
    body = `${body}\n${installBlock}\n`;
  }

  if (options.appendVerification !== false) {
    const verificationBlock = [
      "",
      "### Verification",
      "Verify downloaded assets against `checksums.txt`:",
      "```sh",
      "sha256sum -c checksums.txt",
      "```",
    ].join("\n");
    body = `${body}\n${verificationBlock}\n`;
  }

  return body;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let version = "0.2.0";
  let changelogPath = resolve(process.cwd(), "CHANGELOG.md");
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version" && args[i + 1]) {
      version = args[++i];
    } else if (args[i] === "--changelog" && args[i + 1]) {
      changelogPath = resolve(args[++i]);
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = resolve(args[++i]);
    }
  }

  if (!existsSync(changelogPath)) {
    console.error(`Changelog file not found: ${changelogPath}`);
    process.exit(1);
  }

  const text = readFileSync(changelogPath, "utf-8");
  const notes = extractChangelogNotes(text, version);

  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, notes, "utf-8");
    console.log(`Extracted release notes for v${version} to ${outputPath}`);
  } else {
    console.log(notes);
  }
}
