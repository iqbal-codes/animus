# Security Policy

## Reporting a Vulnerability

We take the security of `labq-software-factory` seriously. If you believe you have discovered a vulnerability, please disclose it responsibly rather than opening a public issue.

### Private Reporting Channels

- **GitHub Security Advisory**: Open a private draft security advisory under the repository's **Security** > **Advisories** tab.
- **Email**: Send vulnerability reports directly to `security@labq.dev`.

Please include:
1. A description of the vulnerability and affected surfaces.
2. Step-by-step reproduction instructions or proof-of-concept code.
3. Impact assessment and potential mitigations.

We will acknowledge receipt within 48 business hours and coordinate remediation before public disclosure.

## Supported Scope

The following monorepo components and runtime surfaces are in scope for security reports:

| Component | Path | Description |
| --- | --- | --- |
| CLI | `scripts/cli/` | Local operator and factory tooling |
| Backend | `apps/backend/` | Factory control plane, project monitor, and intake |
| Engine Host | `apps/engine-host/` | Authenticated private workflow runtime |
| Launcher | `apps/launcher/` | Multi-process supervisor and coordinator |
| Client | `packages/client/` | Typed operator Fetch client |
| Contracts | `packages/contracts/` | Shared domain schemas and interface types |

Third-party dependencies and external harness providers are governed by their respective security policies.

## Operator Security Best Practices

When operating `labq-software-factory`, adhere to the following defaults and controls:

1. **Loopback Default Binding**: Services default strictly to loopback (`127.0.0.1` or `::1`). Non-loopback binds (e.g. `0.0.0.0`) are rejected unless remote access is explicitly enabled with TLS.
2. **Session Secret Permissions**: Session secrets (`session.secret`) must be stored with POSIX mode `0600` (read/write only by the operating user). The backend tightens permissions automatically on startup.
3. **Token Authentication**: Set `FACTORY_HOST_TOKEN` and `FACTORY_TOKEN` with high-entropy values (minimum 32 printable non-whitespace characters). Never transmit tokens over plaintext HTTP or log them in telemetry.
4. **Subsystem Isolation**: `apps/backend` and `apps/engine-host` operate across an isolated boundary. Engine-host endpoints require mutual token authentication and refuse unauthenticated requests.
