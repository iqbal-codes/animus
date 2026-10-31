import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Extracts release notes for a specified version from CHANGELOG.md text.
 * Optionally appends SHA-256 checksum verification instructions.
 */
export function extractChangelogNotes(
  changelogText: string,
  version: string,
  options: { appendVerification?: boolean } = {},
): string {
  const cleanVersion = version.replace(/^v/, "").trim();
  const escaped = cleanVersion.replace(/\./g, "\\.");
  const headingRegex = new RegExp(`^##\\s+\\[?${escaped}\\]?(?:\\s+-\\s+.*)?$`, "m");
  const match = changelogText.match(headingRegex);

  let body = "";
  if (!match || match.index === undefined) {
    body = `## Release v${cleanVersion}\n\nAutomated release build for labq-software-factory v${cleanVersion}.`;
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
