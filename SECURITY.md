# Security Policy

## Reporting a Vulnerability

We take the security of `labq-software-factory` seriously. If you discover or suspect a security vulnerability, please report it privately. **Do not create public GitHub issues or discussions for undisclosed security vulnerabilities.**

To report a vulnerability:
1. Open a private security advisory through the repository's **Security > Advisories** tab on GitHub (preferred).
2. If private advisories are unavailable, send an email to `security@labq.dev` detailing:
   - Affected component(s) and version/commit SHA
   - Step-by-step reproduction instructions or proof-of-concept
   - Impact assessment
   - Any proposed remediation

We acknowledge receipt of reports within 48 hours and work with reporters on responsible disclosure and timeline coordination before publishing fixes and advisories.

## Supported Scope

Security updates are provided for the current active release line:

| Component | Scope / Description | Supported |
| --- | --- | --- |
| CLI (`scripts/cli/*`) | Operator commands, setup wizard, registration, monitoring | Yes |
| Backend (`apps/backend/*`) | Control plane API, forge monitoring, registry, web console | Yes |
| Engine Host (`apps/engine-host/*`) | Private native execution, engine adapter, diagnostics | Yes |
| Unified Launcher (`apps/launcher/*`) | Multi-process coordinator and lifecycle supervisor | Yes |
| Shared Contracts (`packages/contracts/*`) | Schema definitions, validation, and domain DTOs | Yes |
| Client (`packages/client/*`) | Operator Fetch client and error handling | Yes |

Legacy or unmaintained branches do not receive backported security patches.

## Operator Security Best Practices

When deploying and operating `labq-software-factory`, follow these core security practices:

1. **Loopback Binding by Default**:
   - Both `apps/backend` and `apps/engine-host` default to loopback addresses (`127.0.0.1` or `::1`).
   - Never expose raw HTTP control plane or engine-host ports directly to public or untrusted networks without TLS termination and authentication.
2. **Strict File Permissions**:
   - Session secrets, tokens, and SQLite database files (`console.db`) should have restrictive filesystem permissions (e.g. `chmod 0600` on credential and key files).
   - State directories (`FACTORY_RUNTIME_STATE`) should be protected and private to the factory user (`chmod 0700`).
3. **Secure Credential Transport**:
   - `FACTORY_TOKEN` and `FACTORY_HOST_TOKEN` must be provisioned via environment variables or protected configuration files, **never** passed via command-line arguments (`argv`), which may appear in process listings or shell history.
   - Remote access to the factory API must strictly require HTTPS termination; operator credentials are never sent over unencrypted remote networks.
4. **Autonomous Agent & Offline Safety**:
   - Automated execution loops run in isolated worktrees.
   - Project intake and check commands must obey the offline invariant during automated tests, preventing uncontrolled outbound network calls or exfiltration during evaluation.
