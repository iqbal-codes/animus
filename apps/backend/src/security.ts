import { randomBytes } from "node:crypto";
import { existsSync, statSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  resolveAnimusStateDir,
  ensureSecureDirectory,
  enforceSecureFilePermissions,
  migrateLegacyState,
} from "@animus/contracts/paths";

export function ensureSessionSecret(secretPath?: string): string {
  migrateLegacyState();
  const resolvedPath = secretPath || join(resolveAnimusStateDir(), "session.secret");
  const dir = dirname(resolvedPath);
  ensureSecureDirectory(dir);

  if (existsSync(resolvedPath)) {
    let mode = statSync(resolvedPath).mode & 0o777;
    if (mode !== 0o600) {
      try {
        chmodSync(resolvedPath, 0o600);
      } catch {}
      mode = statSync(resolvedPath).mode & 0o777;
      if (mode !== 0o600) {
        throw new Error("session_secret_insecure_mode: file permissions must be 0600");
      }
    }
    return readFileSync(resolvedPath, "utf-8").trim();
  }

  const secret = randomBytes(32).toString("hex");
  writeFileSync(resolvedPath, secret, { mode: 0o600 });
  enforceSecureFilePermissions(resolvedPath);
  return secret;
}

const PRIVATE_IP_PATTERNS = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 127.0.0.0/8
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/, // 172.16.0.0/12
  /^192\.168\.\d{1,3}\.\d{1,3}$/, // 192.168.0.0/16
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // 100.64.0.0/10 Tailscale / CGNAT
  /^::1$/, // IPv6 loopback
  /^fe80::/i, // link-local
  /^fc00::/i, // ULA
  /^fd[0-9a-f]{2}:/i, // ULA
];

export function validateBindAddress(host: string, remoteAccess: boolean): void {
  const isLoopback = host === "127.0.0.1" || host === "::1";

  if (!remoteAccess) {
    if (!isLoopback) {
      throw new Error(
        "bind_loopback_required: Remote access is disabled; listener must bind only to 127.0.0.1 or ::1",
      );
    }
    return;
  }

  // When remote access is enabled:
  if (host === "0.0.0.0" || host === "::") {
    throw new Error(
      "private_ip_required: When remote access is enabled, bind must be an explicit private IP or loopback; wildcard 0.0.0.0 is prohibited",
    );
  }

  const isPrivate = PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(host)) || isLoopback;
  if (!isPrivate) {
    throw new Error(
      "private_ip_required: When remote access is enabled, bind must be a private IP (RFC1918 or Tailscale) or loopback; public addresses are prohibited",
    );
  }
}

export function authenticateOperatorRequest(
  request: Request,
  options: { remoteAccess: boolean; operatorToken?: string },
): boolean {
  if (!options.remoteAccess) {
    return true;
  }

  const token = options.operatorToken;
  if (!token || token.length < 32) {
    throw new Error("unauthorized: missing or invalid operator token configuration");
  }

  const authHeader = request.headers.get("Authorization");
  const xOpHeader = request.headers.get("X-Operator-Token");

  let candidate: string | null = null;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    candidate = authHeader.slice(7).trim();
  } else if (xOpHeader) {
    candidate = xOpHeader.trim();
  }

  if (!candidate || candidate !== token) {
    throw new Error("unauthorized: invalid or missing operator authentication token");
  }

  return true;
}

export function validateCsrfProtection(request: Request): void {
  const method = request.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return;
  }

  // Check Sec-Fetch-Site
  const secFetchSite = request.headers.get("Sec-Fetch-Site");
  if (secFetchSite === "cross-site") {
    throw new Error("csrf_rejected: cross-site requests are strictly prohibited");
  }

  // Check Origin and Referer
  const host = request.headers.get("Host");
  const origin = request.headers.get("Origin");

  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        throw new Error("csrf_rejected: Origin header does not match Host header");
      }
    } catch {
      throw new Error("csrf_rejected: malformed Origin header");
    }
  }
}

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /key/i,
  /authorization/i,
  /auth/i,
  /credential/i,
  /forge/i,
];

export function sanitizeForTelemetry<T extends Record<string, any>>(payload: T): T {
  const sanitized: Record<string, any> = {};

  for (const [key, value] of Object.entries(payload)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (!isSensitive) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        sanitized[key] = sanitizeForTelemetry(value);
      } else {
        sanitized[key] = value;
      }
    }
  }

  return sanitized as T;
}
