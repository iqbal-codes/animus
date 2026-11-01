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
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/,
  /^::1$/,
  /^fe80::/i,
  /^fc00::/i,
  /^fd[0-9a-f]{2}:/i,
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
