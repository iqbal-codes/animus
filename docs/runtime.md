# Factory application runtime

The application requires Python 3.10 or newer. It uses only the standard library;
Git must be available when no candidate identity is supplied. Run from the
delivering checkout's root:

```sh
FACTORY_RUNTIME_STATE=/tmp/factory-state \
FACTORY_RUNTIME_CANDIDATE=candidate-a \
python3 app.py --port 8080
```

The start-command argv is `["python3", "app.py", "--port", "{port}"]`, with
`{port}` replaced by the assigned port. The listener binds only `127.0.0.1`, not
all network interfaces. No workflow, provider, or scheduler starts at boot.

## Inputs and state

- `--port` is required; use a different assigned port for each concurrent process.
- `FACTORY_RUNTIME_CANDIDATE`, when set, is the exact response text for
  `/build-id`, including an empty value or whitespace. Supply a non-secret candidate
  identifier: this value is intentionally public to local HTTP clients.
- When `FACTORY_RUNTIME_CANDIDATE` is unset, startup runs `git rev-parse HEAD` in
  the directory containing `app.py`. Git failures fail startup rather than
  returning a placeholder identity. The identity is resolved once at boot, so
  changing checkout HEAD later does not relabel an already-running process.
- `FACTORY_RUNTIME_STATE` specifies the directory for any writable application
  state. Supply a fresh directory for each attempt. These health and identity
  endpoints are stateless: they do not create directories, databases, or files,
  and they do not need a default state directory. Future persistence must use
  this input, not write into the source checkout or shared factory directories.

## HTTP contract

| Request | Status | Content type | Response body |
| --- | --- | --- | --- |
| `GET /health` | 200 | `application/json` | `{"status": "healthy"}` |
| `GET /build-id` | 200 | `text/plain; charset=utf-8` | Exact startup candidate or Git commit, with no added newline |

Neither endpoint redirects. Other paths return 404. Access logging is disabled
so request targets are not copied into process logs. The service has no
credential inputs or workflow side effects.

Send `SIGTERM` or `SIGINT` to the application process for a clean exit that closes
the listener. Terminating one instance does not affect another instance's
listener or identity.

## Focused checks

```sh
python3 -m unittest discover
python3 -m unittest discover -s tests -p 'test_*.py'
```

The tests launch real subprocesses with temporary state directories and assigned
ports. They check health readiness within five seconds, exact identities, Git
fallback, concurrent isolation, and listener release for both shutdown signals.

The repository's separately declared ordinary gate is `python3 harness/ci.py`.
Its protected configuration currently contains shell syntax that its argv-based
runner does not expand (`$(git ... )`); report that result separately rather than
changing the judge or treating these focused tests as a successful ordinary gate.
