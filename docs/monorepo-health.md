# Bun/Vite+ migration health journey (#28)

This page is **verification infrastructure**, not the replacement operator dashboard.
Python (`python3 app.py --port {port}`) remains the sole owner of operational
workflows, intake, controls, diagnostics, evidence, scheduling and promotion. Its
existing dashboard and harness-memory controls remain available. The new services
own only their health/identity journey: no workflow launches, stores, native reads,
scheduler, Python forwarding or fallback.

## Qualified environment and install

Use exactly **Bun 1.4.2**, **Node 26.8.1**, and project-local **Vite+ 1.4.0**.
`.bun-version`, `.node-version`, root engines and `packageManager` record these
versions. Provision the runtimes before running commands; put the selected Bun on
`PATH`. No command upgrades a global runtime. Install from the checkout root:

```sh
bun install --frozen-lockfile
bun run toolchain
```

Root Bun workspaces and the single `bun.lock` own all dependencies. Workspace
references use `workspace:*`; library exports are TypeScript source, not published
build artifacts. External Archon remains pinned by `factory/pack.json` and located
by the existing consumer settings; it is **not** a workspace dependency. Bun 1.4.2
matches that engine revision's requirement. CLI boot compatibility is not native
workflow/recovery qualification (#29 and later slices own that evidence).

| Workspace | Ownership / dependencies |
| --- | --- |
| `@labq/contracts` | Runtime-neutral Zod schemas/types; explicit `/operator` and private `/host` exports, no root barrel |
| `@labq/client` | Operator-only Fetch client and classified errors; imports only `/operator` |
| `@labq/backend` | Bun public health HTTP and authenticated host request; imports contracts, no other app |
| `@labq/engine-host` | Bun authenticated private process health HTTP; imports private contract, no other app |
| `@labq/web` | Vanilla browser health view via client; Node-backed Vite+ dev/preview proxy |

## Start three independent processes

Choose distinct loopback ports and use the same non-secret candidate in all three
processes. `FACTORY_RUNTIME_CANDIDATE` is exact public text, including empty,
whitespace and Unicode. When absent each app resolves Git HEAD **once** from its
delivering checkout (not the caller's working directory). Git failure aborts boot.
Do not use credentials as identities.

Generate a token out of band (for example `openssl rand -hex 32`) and securely
provision it only in the host/backend environments. It must contain at least 32
printable ASCII characters and no whitespace. Never put its value in argv, source,
logs, browser env, `VITE_*`, or a committed env file. `.env.example` lists names,
not usable values. Bun may read local `.env`; keep it private and avoid providing
host credentials to the web process.

Exact start-command argv, from the checkout root:

```text
["bun", "apps/engine-host/src/main.ts", "--port", "{host_port}"]
["bun", "apps/backend/src/main.ts", "--port", "{backend_port}"]
["bun", "run", "--cwd", "apps/web", "dev", "--host", "127.0.0.1", "--port", "{web_port}", "--strictPort"]
```

| Process | Required environment |
| --- | --- |
| Host | `FACTORY_HOST_TOKEN` |
| Backend | `FACTORY_HOST_TOKEN`, `FACTORY_HOST_URL=http://127.0.0.1:{host_port}` |
| Web dev/preview | `FACTORY_BACKEND_URL=http://127.0.0.1:{backend_port}` |

Set `FACTORY_RUNTIME_STATE` to a fresh directory per attempt. It is reserved for
future writable migration behavior: this slice never creates files, directories,
databases or native state there. All three processes can start with their peers
absent, provided their own configuration is valid. Boot does not attest peer
availability. Missing/invalid settings abort without printing values.

Bun listeners require `--port` (0 is allowed for isolated process tests and actual
bound URL is reported). Optional `--host` accepts only `127.0.0.1` or `::1`, default
`127.0.0.1`. Vite dev/preview require an explicit nonzero `--port`, loopback host,
and strict port binding. Backend target URLs must be literal loopback HTTP origins
with explicit nonzero ports: no DNS, userinfo, paths, queries or fragments. The web
proxy forwards only the `/api/v1` namespace, never private host paths. It does not
provide remote authentication or permissive CORS.

For built assets and preview:

```sh
bun run build:web
# FACTORY_BACKEND_URL must be present in this server process only:
bun run --cwd apps/web preview --host 127.0.0.1 --port 8082 --strictPort
```

Build requires no backend or host configuration. Open the web URL, observe both
candidate identities, and use Refresh. Stopping the host must produce unavailable,
not stale healthy; restarting the same candidate restores healthy. Host health
means **the host process answered**, not that Archon or a provider is healthy.
SIGTERM/SIGINT stop Bun services and release listeners; backend lifetime does not
own the independently launched host.

## HTTP and client contract

| Endpoint | Meaning |
| --- | --- |
| Backend/web `GET /health` | Local liveness, 200 JSON `{"status":"healthy"}`, independent of host/backend availability |
| Backend/web `GET /build-id` | Exact startup identity, UTF-8 plain text, no added newline |
| Backend `GET /api/v1/health` | Real authenticated host roundtrip; 200 validated `{status:"healthy",buildId,host:{status:"healthy",buildId}}` only when identities match exactly |
| Host `GET /health`, `/build-id`, `/internal/v1/health` | All require `Authorization: Bearer <private token>`; internal health returns real startup identity |

Host authenticates before routing using constant-time comparison of fixed-size
hashes. Missing/wrong credentials both return 401 `{"error":"unauthorized"}`.
Backend sends its token only to the configured internal health endpoint, bypasses
ambient HTTP proxies for that loopback host, never follows redirects, never retries,
and bounds headers/body by a two-second deadline.
Unknown service paths return 404; unsupported methods on declared paths return
405. Error bodies contain no upstream text or private configuration:

| Operator error | HTTP |
| --- | --- |
| `host_unavailable` (network, deadline, upstream non-success other than auth) | 503 |
| `host_unauthorized` (host 401/403) | 503 |
| `invalid_host_response` (invalid JSON/schema) | 502 |
| `candidate_mismatch` | 503 |

`createFactoryClient({baseUrl, fetch?}).health()` from `@labq/client` resolves only
validated success. It throws `FactoryClientError` with a typed operator code or
`transport_unavailable` / `invalid_operator_response`. Standard Fetch and injectable
transports work under browser/Node; there are no env defaults, tokens, Bun imports,
private host exports or automatic retries. Unknown additive fields are stripped
by schemas rather than propagated into operator responses. Refresh clears prior
identities before the request, and rendering uses text content, not HTML.

## Checks and offline runtime evidence

All JS tooling uses local Vite+'s **Node** executable; application/process suites
explicitly use **Bun**. Bundling/transpiling is not type checking. Root policy enables
both integrated `typeAware` and `typeCheck`; strict projects separately scope Bun
apps/tests, Node tooling/tests and neutral/browser code. Vite+ alone owns formatting,
lint and integrated type diagnostics. Cross-app, relative-workspace bypass and
private client imports are lint errors; production build additionally inspects the
browser module graph and assets. New source/config/test/tooling paths are checked,
not reformatted legacy Python/dashboard/governance files.

```sh
bun run format       # non-mutating; format:write explicitly mutates
bun run lint         # warnings fail
bun run typecheck    # integrated static diagnostics, not execution
bun run check        # format + lint + typecheck
bun run build:web    # production build + module/asset authority inspection
bun run test         # Vite Task: neutral Vitest, Bun processes, browser, unchanged Python
bun run verify       # Vite Task: exact toolchain + static + test (including browser build)
```

Every introduced config task has `cache:false`; package scripts are uncached by
default. No task-result cache or native compatibility guarantee is adopted here.
Suite failures propagate through the aggregate; Python is not analyzed by Vite+.
For focused development use `vp` via `node_modules/.bin/vp`, never a global CLI or
`bun --bun`:

```sh
node_modules/.bin/vp test run tests/integration/client.test.ts
bun test tests/integration/health.bun.test.ts
bun run build:web && node node_modules/@playwright/test/cli.js test --config tests/integration/playwright.config.ts
```

Build the web assets (`bun run build:web`) and provision Chromium **before** offline testing:
`node node_modules/@playwright/test/cli.js install chromium`. Tests make only
loopback network requests, use random test-only credentials, and own/stop their
processes. Process tests cover real auth, exact/empty/unusual/Git identities,
independence, partial TCP connections, signal shutdown and listener release.
Controlled host adapters prove malformed/upstream/deadline/redirect failures;
they are not native engine evidence. Browser tests use actual built preview and
dev routing with live backend/host, outage and recovery, plus Node Fetch client.

After committing, qualify deliberate format/lint/type/boundary/runner failures in
a disposable detached worktree (ordinary tests never mutate candidate source):

```sh
node scripts/health/qualify.mjs /absolute/existing/scratch-parent
```

It frozen-installs twice, checks positive gates, injects each violation, requires
the expected diagnostic, and verifies test/verify failure propagation for each
runner with unrelated suites isolated in disposable config. It removes its owned
worktree. Record logs with the tested HEAD. Do not call these intentional red
controls a failing positive check.

The unchanged Python aggregate still includes a historical-run evidence test
(`tests/test_app.py:HealthIdentityTests.test_evidence_and_report_against_real_app`)
that requires operator-owned native history. A clean `ARCHON_HOME` lacks that
prerequisite; do not fabricate history, skip the assertion or claim portable clean
Python success. The new health slice needs no such history. Full native process-tree,
parent-death, provider, OS portability, later migration and task-cache qualification
remain **NOT RUN** by these tests. Report actual OS/candidate/results separately.
