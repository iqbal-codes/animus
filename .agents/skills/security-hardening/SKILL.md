---
name: security-hardening
description: Harden software against vulnerabilities, validate hostile trust boundaries with strict schemas, enforce least-privilege authorization, prevent OWASP Top 10 defects, and sanitize sensitive data.
---

# Security and Hardening: Trust Boundaries & Defense-in-Depth

Build and verify software that treats external inputs as hostile, prevents OWASP Top 10 vulnerabilities, protects sensitive data, and enforces fail-closed authorization.

## When to Use

Use this playbook when:
- Designing or implementing code that accepts external user, API, webhook, file, or LLM-generated input.
- Creating or modifying authentication, session management, or access control logic.
- Storing, querying, serializing, or transmitting sensitive data, credentials, or PII.
- Auditing a code diff, endpoint, or dependency tree for security vulnerabilities during builder laps or code review.

## Steps

1. **Map trust boundaries and write abuse cases first.**
   Identify all entrypoints where untrusted data enters the application (HTTP requests, URL params, headers, cookies, webhooks, CLI arguments, environment variables, or LLM responses). Run quick STRIDE threat modeling (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) over each boundary. Write at least one failing negative test exercising an invalid input, unauthorized access, or malformed payload before writing implementation logic.
   *Completion Criterion*: Every external trust boundary is documented with at least one automated check verifying that unauthorized, malformed, or hostile inputs fail cleanly.

2. **Validate boundaries with strict schemas and parameterize queries.**
   Parse all untrusted inputs (`unknown`) at the external boundary using strict schemas (e.g. Zod or strongly-typed DTOs) into discriminated unions. Reject extra properties, unexpected types, and oversized payloads with standard 400/422 status codes before data reaches domain logic. Use parameterized queries, ORM bind parameters, or safe exec argument arrays for all database, ORM, and subprocess calls; keep string interpolation and concatenation out of SQL, NoSQL, and shell commands.
   *Completion Criterion*: Zero unvalidated `any` or raw string interpolations exist in database queries or command executions, and all boundary endpoints parse inputs through strict schemas.

3. **Enforce fail-closed authentication and resource-level authorization.**
   Require valid credentials on every protected endpoint and reject missing, expired, or invalid credentials immediately (return HTTP 401 without falling back to default or guest users). Check resource ownership on every data request by verifying that the authenticated identity possesses explicit rights to the requested resource ID (preventing Insecure Direct Object References / IDOR). Use `httpOnly`, `secure`, and `sameSite` flags for session cookies, and keep sensitive session tokens out of client-accessible local storage.
   *Completion Criterion*: Automated authorization tests confirm that unauthenticated callers receive HTTP 401 and authenticated callers attempting to access another subject's resources receive HTTP 403.

4. **Sanitize data flows, redact secrets, and eliminate information disclosure.**
   Strip sensitive fields (`passwordHash`, reset tokens, private keys) from all outbound responses, error bodies, and log records. Return generic error messages to clients while logging detailed traces securely on the server without exposing stack traces. Source all credentials and tokens from environment variables or secure secret vaults; keep secrets and key material completely out of source control, git history, and client bundles.
   *Completion Criterion*: Automated tests verify that responses and logs contain zero plaintext credentials, passwords, or stack traces, and HTTP responses emit standard security headers (CSP, HSTS, X-Content-Type-Options).

5. **Verify supply-chain integrity and prove external blast-radius safety.**
   Run the repository's native package manager audit (`bun pm audit`, `npm audit`, or equivalent) to confirm zero unmitigated high or critical vulnerabilities. When altering shared authentication middleware, cryptographic helpers, or cross-cutting data access logic, prove external blast-radius safety at Proof Level 4 (an executed test or probe script verifying that all external callers remain authenticated and safe).
   *Completion Criterion*: Package manager audit passes with zero unmitigated high/critical CVEs, and cross-boundary security changes pass Proof Level 4 verification with executed test evidence.
