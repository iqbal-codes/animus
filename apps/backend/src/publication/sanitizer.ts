import { ReportSanitizer } from "@animus/contracts/sanitizer";

const LOCAL_PATH_PATTERNS: RegExp[] = [
  /file:\/\/[^\s)\]"'`]+/g,
  /(?:\/(?:Users|home|opt|tmp|private|var|mnt|workspace|root|etc))(?:\/[^\s)\]"'`]+)+/g,
  /[A-Za-z]:\\[^\s)\]"'`]+/g,
];

function localPathSanitize(value: string): string {
  let next = value;
  for (const pattern of LOCAL_PATH_PATTERNS) {
    next = next.replace(pattern, "[LOCAL_PATH]");
  }
  return next;
}

/**
 * Canonical publication sanitation policy shared by PR audit and issue
 * publication: scrub credentials/holdouts, unsafe HTML, and local-only paths
 * before any text crosses the remote boundary.
 *
 * This lives in its own leaf module so evidence-side helpers can reuse the exact
 * same policy without importing the publication service (and creating a cycle).
 */
export function sanitizePublicationText(
  value: string,
  sanitizer: ReportSanitizer = new ReportSanitizer(),
): string {
  return localPathSanitize(sanitizer.sanitizeMarkdown(value).report);
}
