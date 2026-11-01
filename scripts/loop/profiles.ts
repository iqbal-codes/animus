import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalIssue, VerificationProfile } from "./types";

export interface ProfileInstructions {
  depth: "light" | "normal" | "deep";
  runtimeInstructions: string;
  skipAppLaunch: boolean;
  description: string;
}

/**
 * Resolves the appropriate verification profile for a given issue and optional changed files list.
 * Precedence:
 * 1. Explicit profile property on issue (`issue.verificationProfile`)
 * 2. Explicit label tag (`profile:docs`, `profile:ui`, `profile:logic`, `profile:api`, `profile:core`)
 * 3. Explicit tag in issue body / Contract (`Verification Profile: <profile>`)
 * 4. Changed files extension & directory heuristics (if available)
 * 5. Title & body keyword heuristics
 */
export function resolveVerificationProfile(
  issue: LocalIssue,
  changedFiles: string[] = [],
): VerificationProfile {
  if (issue.verificationProfile) {
    return issue.verificationProfile;
  }

  // 1. Check labels
  const labels = (issue.labels ?? []).map((l) => l.toLowerCase());
  for (const label of labels) {
    if (label === "profile:docs" || label === "type:docs" || label === "documentation") {
      return "docs";
    }
    if (
      label === "profile:ui" ||
      label === "type:ui" ||
      label === "frontend" ||
      label === "area:web" ||
      label === "area:ui"
    ) {
      return "ui";
    }
    if (label === "profile:api" || label === "type:api" || label === "area:api" || label === "backend:api") {
      return "api";
    }
    if (
      label === "profile:core" ||
      label === "security" ||
      label === "migration" ||
      label === "auth" ||
      label === "database"
    ) {
      return "core";
    }
    if (label === "profile:logic") {
      return "logic";
    }
  }

  // 2. Check issue body for explicit profile directive
  const bodyText = `${issue.title}\n${issue.body}`;
  const directiveMatch = /(?:verification\s*profile|profile):\s*(docs|ui|logic|api|core)\b/i.exec(bodyText);
  if (directiveMatch && directiveMatch[1]) {
    return directiveMatch[1].toLowerCase() as VerificationProfile;
  }

  // 3. Check changed files (e.g. continuing PR or builder finished)
  if (changedFiles.length > 0) {
    const isAllDocs = changedFiles.every((f) =>
      /\.(md|markdown|txt|rst|png|jpg|jpeg|svg)$|^docs\/|^LICENSE/i.test(f),
    );
    if (isAllDocs) return "docs";

    const hasCore = changedFiles.some((f) =>
      /auth|security|schema|migration|\.factory\/holdout|harness\//i.test(f),
    );
    if (hasCore) return "core";

    const hasUi = changedFiles.some((f) =>
      /apps\/web\/|\.(css|scss|tsx|jsx)$|src\/components\//i.test(f),
    );
    if (hasUi) return "ui";

    const hasApi = changedFiles.some((f) =>
      /routes|controller|endpoint|apps\/backend\/src\/main\.ts/i.test(f),
    );
    if (hasApi) return "api";
  }

  // 4. Keyword heuristics fallback
  if (/auth|security|migration|schema|database|holdout/i.test(bodyText)) {
    return "core";
  }
  if (/^(docs|doc|readme|documentation)[:\s]/i.test(issue.title) || /\b(typo|readme|documentation|markdown)\b/i.test(issue.title)) {
    return "docs";
  }
  if (/ui|button|color|theme|css|layout|frontend|view|component|screen/i.test(bodyText)) {
    return "ui";
  }
  if (/api|endpoint|http|route|rest|grpc/i.test(bodyText)) {
    return "api";
  }

  return "logic";
}

/**
 * Returns customized QA and verification execution instructions tuned specifically for
 * the target verification profile to eliminate token and time waste.
 */
export function getProfileInstructions(profile: VerificationProfile, root: string): ProfileInstructions {
  const runtimeDocPath = existsSync(join(root, "docs/runtime.md"))
    ? "docs/runtime.md"
    : existsSync(join(root, "harness/END-TO-END.md"))
      ? "harness/END-TO-END.md"
      : "engineering.md";

  switch (profile) {
    case "docs":
      return {
        depth: "light",
        skipAppLaunch: true,
        runtimeInstructions:
          "Documentation only. Do NOT launch background HTTP servers, mock drivers, or browser E2E suites. Verify markdown syntax, links, and documents directly.",
        description: "Documentation change; app startup omitted, verification focused on content and format.",
      };

    case "ui":
      return {
        depth: "normal",
        skipAppLaunch: false,
        runtimeInstructions:
          "Frontend / UI change. Build the web app and verify the specific visual and interactive components modified. Verify all 7 interactive states (hover, focus-visible, disabled, empty, loading, error, long-content), check 1440px desktop and 390px mobile viewports for zero horizontal overflow, enforce WCAG 2.2 AA contrast (>=4.5:1) and >=44px touch targets, and follow .agents/skills/ui-quality/SKILL.md. Do not execute deep backend holdout sweeps.",
        description: "Frontend UI change; targeted web/component and 7-state viewport verification.",
      };

    case "api":
      return {
        depth: "normal",
        skipAppLaunch: false,
        runtimeInstructions: `See project runtime guide in ${runtimeDocPath} for launching backend services. Verify target endpoints with HTTP requests or curl. Do not launch web browser sessions.`,
        description: "API endpoint change; service launch and HTTP endpoint verification.",
      };

    case "core":
      return {
        depth: "deep",
        skipAppLaunch: false,
        runtimeInstructions: `See project runtime guide in ${runtimeDocPath} for launching services and black-box verification. Probe security, data transitions, and holdouts.`,
        description: "Core architecture, security, or data change; deep verification with holdouts.",
      };

    case "logic":
    default:
      return {
        depth: "normal",
        skipAppLaunch: true,
        runtimeInstructions:
          "Backend logic or library change. Run unit and integration tests. Do not start web browsers or UI servers unless required by contract.",
        description: "Backend logic change; targeted test verification.",
      };
  }
}
