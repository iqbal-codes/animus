import type { SanitizedReport } from "./operator";

export interface SanitizationResult extends SanitizedReport {
  rawLength: number;
  sanitizedLength: number;
}

export class ReportSanitizer {
  // Regex patterns for credential tokens
  private tokenPatterns: Array<{ name: string; regex: RegExp; replacement: string }> = [
    {
      name: "github_pat",
      regex: /github_pat_[a-zA-Z0-9_]{36,}/g,
      replacement: "[REDACTED_GH_PAT]",
    },
    {
      name: "github_token",
      regex: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
      replacement: "[REDACTED_GH_TOKEN]",
    },
    {
      name: "openrouter_key",
      regex: /sk-or-v1-[a-zA-Z0-9]{32,}/g,
      replacement: "[REDACTED_OPENROUTER_KEY]",
    },
    {
      name: "openai_key",
      regex: /sk-[a-zA-Z0-9_-]{20,}/g,
      replacement: "[REDACTED_API_KEY]",
    },
    {
      name: "bearer_token",
      regex: /Bearer\s+[A-Za-z0-9_\-.]{16,}/g,
      replacement: "Bearer [REDACTED_TOKEN]",
    },
    {
      name: "host_token",
      regex: /FACTORY_HOST_TOKEN=[A-Za-z0-9_\-.]+/g,
      replacement: "FACTORY_HOST_TOKEN=[REDACTED]",
    },
    {
      name: "generic_secret",
      regex:
        /(?:api[_-]?key|secret|password|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi,
      replacement: "secret=[REDACTED]",
    },
  ];

  // Regex patterns for private holdouts and evaluator data
  private holdoutPatterns: Array<{ name: string; regex: RegExp; replacement: string }> = [
    {
      name: "holdout_path",
      regex: /(?:\/[a-zA-Z0-9_\-.]+)*\/[a-zA-Z0-9_\-.]*\.holdout\.[a-zA-Z0-9_\-.]+/gi,
      replacement: "[PROTECTED_HOLDOUT_PATH]",
    },
    {
      name: "holdout_prefix_path",
      regex: /(?:\/[a-zA-Z0-9_\-.]+)*\/holdout_[a-zA-Z0-9_\-.]+/gi,
      replacement: "[PROTECTED_HOLDOUT_PATH]",
    },
    {
      name: "private_holdout_dir",
      regex: /(?:private_holdouts?|holdout_evaluator)\/[a-zA-Z0-9_\-./]+/gi,
      replacement: "[PROTECTED_HOLDOUT_PATH]",
    },
    {
      name: "holdout_secret_content",
      regex: /HOLDOUT_SECRET_[A-Za-z0-9_]+/gi,
      replacement: "[PROTECTED_HOLDOUT_CONTENT]",
    },
    {
      name: "synthetic_fixture_secret",
      regex: /synthetic_fixture_secret_[A-Za-z0-9_]+/gi,
      replacement: "[PROTECTED_HOLDOUT_CONTENT]",
    },
  ];

  sanitizeMarkdown(content: string): SanitizationResult {
    let sanitized = content;
    let redactedTokensCount = 0;
    let scrubbedHoldoutsCount = 0;

    // 1. Scrub holdouts first so evaluator/holdout content is classified as holdout
    for (const pattern of this.holdoutPatterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      const matches = sanitized.match(regex);
      if (matches) {
        scrubbedHoldoutsCount += matches.length;
        sanitized = sanitized.replace(regex, pattern.replacement);
      }
    }

    // 2. Scrub credential tokens
    for (const pattern of this.tokenPatterns) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      const matches = sanitized.match(regex);
      if (matches) {
        redactedTokensCount += matches.length;
        sanitized = sanitized.replace(regex, pattern.replacement);
      }
    }

    // 3. Scrub unsafe HTML elements and scripts
    sanitized = sanitized
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "[REMOVED_SCRIPT]")
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "[REMOVED_IFRAME]")
      .replace(/<embed\b[^<]*(?:(?!<\/embed>)<[^<]*)*<\/embed>/gi, "[REMOVED_EMBED]")
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "[REMOVED_OBJECT]")
      .replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "")
      .replace(/javascript:[^\s"'`)]+/gi, "[REMOVED_JS_LINK]");

    return {
      report: sanitized,
      sanitized: true,
      redactedTokensCount,
      scrubbedHoldoutsCount,
      rawLength: content.length,
      sanitizedLength: sanitized.length,
    };
  }
}
