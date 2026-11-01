# Repository onboarding

Repository configuration, factory enrollment, and issue admission are distinct states. A successful local configuration is not proof that the factory is reachable or that a job has started.

## CLI Installation

Install the `animus` command-line interface (and its `factory` and `animus` symlinks) through one of three zero-server channels:

- **POSIX Shell Installer (macOS & Linux)**:
  ```sh
  curl -fsSL https://github.com/iqbal-codes/animus/releases/latest/download/install.sh | sh
  ```
  Enforces fail-closed SHA-256 integrity verification against `checksums.txt` before linking binaries into `$HOME/.animus/bin`.

- **Bun Global Install**:
  ```sh
  bun add -g github:iqbal-codes/animus
  ```
  Installs the bundled standalone JavaScript CLI (`dist/cli.js`) directly with Bun.

- **Homebrew Tap (macOS & Linux)**:
  ```sh
  brew install iqbal-codes/tap/animus
  ```
  Installs the checksum-pinned binary release using the Homebrew formula.

## Configure and enroll a local checkout

Start the factory on the machine that holds the checkout, then run:

```sh
cd /absolute/path/to/product
animus setup
```

Setup targets the current directory. It enforces a fail-closed preflight check requiring an active Git repository checkout or worktree and a valid GitHub `origin` remote (`github.com`). Running setup in a non-Git directory or with a non-GitHub remote fails closed immediately before prompting or writing files.

Once preflight succeeds, `animus setup` deterministically configures the repository and enrolls the checkout through the factory API at `http://127.0.0.1:3000` by default. Registry commands do not create a database inside the managed repository.

The interactive wizard provides:

1. A harness checkbox list. Use Up/Down to navigate, Space to toggle, and Enter to continue. Select at least one harness (`pi`, `claude`, `omp`, `codex`, or `opencode`). Installed status does not establish authentication.
2. An `AGENTS.md` action selector (`--agents-md <keep|overwrite>`). When an instruction file already exists, it defaults to `keep` to preserve existing project instructions; selecting `overwrite` writes a fresh copy from `factory/templates/AGENTS.template.md`.
3. A tier overview. Small, Medium, and Large tiers default model selection to `"default"`, using each harness's native CLI default model with reasoning effort defaulted to `"default"`. Operators can inspect or customize model IDs and reasoning efforts; Pi and OpenCode catalogs come from their local CLI catalog commands, while other providers support manual entry. Catalog presence does not establish account access. Harness effort choices do not establish model-specific support. A model reported as not supporting reasoning receives no effort override.
4. Numeric inputs with visible defaults. Invalid, non-positive, fractional, or unsafe integer values are rejected and reprompted. Enter accepts the displayed default.
5. Editable static-check and unit-test commands. These commands are saved directly to `harness/harness.config.json` and `.factory/tool-guidance.json` without blind synthetic injection. Replace missing or no-op checks with real project checks before expecting execution.

Escape or Ctrl-C cancels an interactive prompt and restores terminal state. Configuration is written only after the configuration prompts finish. Once configuration has been written, an enrollment failure preserves those files and exits unsuccessfully with a registration error.

After scaffolding completes, `animus setup` directs the operator to run `/animus-harness` in their personal coding agent to perform live command verification (`exit 0`), audit codebase topology, and author `AGENTS.md` and domain holdout scenarios.

For configuration without enrollment:

```sh
animus setup --local-only
```

For noninteractive configuration and enrollment, use `--yes` and explicit settings as needed (`--agents-md keep` or `overwrite`). `--yes` is not a verification of model availability or project checks.

```sh
animus setup --yes --provider claude --agents-md keep \
  --static-cmd "bun run check" --unit-cmd "bun test"
```

Inspect generated changes with `git status` and `git diff`. New delivery worktrees start from committed source; uncommitted setup files are not automatically part of the delivery candidate.

## Enroll an existing GitHub repository by cloning

```sh
animus project register --repo OWNER/REPOSITORY
```

The factory verifies the GitHub repository identity and clones it into its own managed storage. No laptop checkout path is sent. Repositories without usable checks and model configuration remain held by monitoring until their setup is completed. Enrollment alone does not manufacture working checks or credentials.

For a checkout already on the factory machine:

```sh
animus project register --path /absolute/path/to/product
```

Local-checkout registration requires a loopback factory URL. A laptop path cannot identify a checkout on a different machine. For a remote factory, register by GitHub repository instead. Local unpushed changes do not appear in a remote clone.

## Factory connection

Use `--factory-url` or `FACTORY_URL` to select the instance. The default is `http://127.0.0.1:3000`. Use `FACTORY_TOKEN` for the operator credential when authentication is required; `--factory-token` is also supported, but environment delivery avoids placing a secret in shell history. Operator credentials are refused over non-loopback plain HTTP. A remote factory should be reached through HTTPS termination.

Factory enrollment failure is not silently converted into local-only setup or a new database. An existing repository at a different checkout requires explicit retargeting; it is not silently moved.

## Canonical GitHub labels

Backend onboarding creates missing labels without overwriting existing labels or relabeling issues:

- `ready-for-agent`
- `needs-info`
- `ready-for-human`
- `needs-triage`
- `wontfix`

The factory machine needs GitHub credentials with repository and label permissions. Label creation can have partial effects. Failed preparation preserves the repository, checkout, and labels already created; retry after fixing the reported problem. A label-preparation failure does not complete new enrollment.

See [issue tracker & triage labels](agents/issue-tracker.md) for admission semantics. Creating these labels does not make unlabeled issues executable.

## Monitoring and execution

The backend owns registered-project monitoring for its lifetime. It enumerates the durable registry, checks each project's checkout and configuration, and uses that project's scheduler interval, capacity, work window, and admission rules. Global/project database brakes and filesystem brakes prevent dispatch. Changes to the repository identity or a late launch brake are checked again before execution.

**Starting the backend enables scheduled execution for eligible registered projects.** Registration is not a separate human approval gate for each future job. Do not label work `ready-for-agent` unless automatic execution is intended under the configured policy. STOP/PAUSE and schedule controls remain the operational brakes. A completed lap is not proof of a merge or deployment.

Inspect the registry and actual monitor state:

```sh
animus project list
animus project monitoring
animus project monitoring --json
```

The corresponding read endpoint is `GET /api/v1/monitoring`. States distinguish idle, running, held, skipped, completed, and error. `setup_incomplete`, checkout mismatch, label failures, capacity, work-window restrictions, and brakes are not presented as successful execution. A project can be enrolled while held from execution.

Monitoring stops taking new work during graceful backend shutdown and waits for in-flight work to finish. A crashed monitor lock is not silently stolen; inspect active processes and local-loop evidence before manually recovering a stale lock.

## Verification boundary

The automated onboarding tests use offline GitHub transports and real temporary checkouts/databases. They verify keyboard behavior, enrollment requests, label preservation, project-scoped dispatch, admission drift, and brakes without writing to live GitHub repositories. They do not prove that credentials on a particular installation can access a chosen model or repository.
