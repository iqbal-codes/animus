# Issue 56: source-mode discovery with CLI provider registration

## Result

A **narrowed, non-executing offline probe** resolved one `archon-implement` as **bundled**, with zero discovery errors, after registering the same provider categories and platform policies as the pinned CLI. It emitted one warning: an included `archon-deploy` drops `mutates_checkout`. This is not a clean validation of Factory's full source-mode launch, deployed provider configuration, or an exact-child dispatch contract. The prior pack exposure (`git show 8924ce3:docs/research/issue-56-factory-pack-exposure.md`) and exact-child dispatch (`git show ead1f51:docs/research/issue-56-exact-child-dispatch.md`) findings still apply; issue 56 remains held.

## Host and configuration evidence

- Factory commit `5fa30a37748d0acde86a6fc6c0fc3ba49d5e8105`, `apps/engine-host/src/native.ts:246-311`, reads `factory/pack.json`, constructs `~/.cache/factory/archon/<integration_revision_required>/packages/cli/src/cli.ts`, passes that cache root as `--workflow-source`, `repoRoot` as both subprocess cwd and `--cwd`, and dispatches **`archon-loop`**, not `archon-implement`. It inherits `process.env`; `.factory/settings.json` can override `bun`, but is absent in this checkout. Diagnostics' local-directory search is not the launch source selection.
- The pack pins `5c4f5e484262185926b37b070457fabb9bfedae0`; the examined cache's `git rev-parse HEAD` matched. HEAD identity alone does not prove all working-tree or dependency bytes are pristine. No deployment or live host configuration was inspected.
- The target checkout's `.archon/config.yaml` selects `pi`, sets its model and all three tiers, defines `@reasoning`, and sets worktree base `main`. The pinned source root has a **different** `.archon/config.yaml`: worktree base `dev` and `@mini` alias. Pinned `packages/cli/src/commands/workflow.ts:1203-1213,1800-1851` distinguishes source discovery configuration from target execution configuration; executing runs capture source and discover against captured roots with target cwd, whereas the uncaptured `loadWorkflows` path loads discovery configuration at the discovery root. `packages/core/src/config/config-loader.ts` documents defaults → global → repo → environment. The probe separately loaded copied source and target config but did **not** emulate capture, execution, or real inherited environment.
- `packages/cli/src/cli.ts:131-160` loads platform policies and registers built-in, community, then installed provider plugins. The probe called those same registration functions with an empty, fresh `ARCHON_HOME`: registered IDs `claude`, `codex`, `opencode`, `pi`, `copilot`; installed provider plugins: 0. It did not reproduce the CLI's process-error handlers. It cannot establish deployed plugins, credentials, model availability, installed packs, global config, or any environment overrides.

## Probe and output

A copy-on-write isolated copy of the cache and dependencies was made under `/tmp/issue56-probe.PzbwRd/source`; a separate target held only the checkout's `.archon/config.yaml`. A narrow source root held the pinned source config plus only `.archon/workflows/sdlc/implement/`. No Factory holdout or product files were copied. Bundled workflow discovery still loads pinned package defaults, so the returned workflow was `bundled`, not evidence that the narrowed project copy won precedence. This is deliberately **not** discovery over the actual entire source tree or a frozen capture: full-source fidelity and duplicate/override behavior remain untested. Source package bundled resources were not narrowed; they reside in the isolated Archon copy, not the Factory target. An OS sandbox additionally denied reads under the original checkout's `.factory/holdout`.

Executed from the isolated target with `env -i`, fresh `HOME` and `ARCHON_HOME`, and macOS `sandbox-exec`: policy `(allow default)`, `(deny network*)`, `(deny process-exec (regex #".*/gh$"))`, and `(deny file-read* (subpath "<factory checkout>/.factory/holdout"))`. A PATH-first `gh` stub was also present. Under the final policy both the stub and `/opt/homebrew/bin/gh` failed with exit 126 (`Operation not permitted`); `nc -G 2 -z 1.1.1.1 443` exited 1, consistent with but not independently proving network denial. The sandbox policy is the network control. This is not a general filesystem isolation boundary; only the explicitly denied holdout path and sanitized copied target protect Factory content. No workflows, evaluators, nodes, or tracker operations ran.

The final discovery process exited 0; stderr was empty. Its complete returned `errors` array was `[]`; 20 workflows were returned, one exact name `archon-implement`, source `bundled`, declared model `large`, input `work` default `""`. `resolveWorkflowName('archon-implement', workflows)` returned that same object. The workflow's parsed `mutates_checkout` was absent. All warning/error log records from this run consisted of:

```text
include.workflow_level_fields_dropped: include=deploy target=archon-deploy droppedFields=["mutates_checkout"]
safetyNote: mutates_checkout affect isolation/concurrency safety and belong to the RUN — set them on the TOP-LEVEL workflow if the block relies on them
```

This warning concerns `archon-deploy` composition; it is not evidence that `archon-implement` itself dropped that field. Informational logs reported 20 app defaults and zero discovery errors. The first run also logged `default_config_created` in the temporary home. Source config loaded as assistant `claude`, `@mini` set, default workflows/commands enabled; copied target loaded assistant `pi`, configured tiers and `@reasoning`, default workflows/commands enabled. Fresh-home defaults are **test configuration**, not observed deployment configuration.

### Failed setup attempts and controls

The initial script at the copied source root failed before registration: `Cannot find module '@archon/workflows/workflow-discovery'`; moving it into `packages/cli` supplied the CLI package's module context. The next attempt registered five providers but failed before config loading with `Platform policies are not configured; call setPlatformPolicies() before loading config or running cleanup`; adding the CLI-equivalent policy initialization fixed it. An initial sandbox rule denying the literal `/opt/homebrew/bin/gh` did **not** block its symlink-resolved binary: `gh --version` succeeded. That preliminary discovery was rerun after changing to the regex rule and confirming exit 126. No `gh` operation beyond version was attempted. These are probe setup failures, not workflow validation errors.

## Reproduction

Use a fresh temporary directory `T`, copy the pinned cache (including installed dependencies) to `$T/source`, and copy only the target `.archon/config.yaml` to `$T/target/.archon/config.yaml`. Copy source `.archon/config.yaml` and `.archon/workflows/sdlc/implement/` into corresponding paths under `$T/narrow`; do not copy the Factory tree or holdouts. Create an empty `$T/home`, PATH stub for `gh`, and the sandbox policy above with the absolute original holdout path. Place the following in `$T/source/packages/cli/probe-issue56.ts`:

```ts
import { registerBuiltinProviders, registerCommunityProviders, registerProvider } from '@archon/providers/in-process';
import { providerRegistry, getRegisteredProviders } from '@archon/providers';
import { loadProviderPlugins } from '@archon/core/providers/load-provider-plugins';
import { getPluginsPath } from '@archon/paths';
import { loadConfig } from '@archon/core/config/config-loader';
import { discoverWorkflowsWithConfig } from '@archon/workflows/workflow-discovery';
import { resolveWorkflowName } from '@archon/workflows/router';
import { setPlatformPolicies } from '@archon/core/platforms/registry';
import { defaultPlatformPolicies } from '@archon/adapters/platform-policies';
import { loadPlatformPolicies } from '@archon/core/platforms/chat-plugins';
setPlatformPolicies(await loadPlatformPolicies(getPluginsPath(), defaultPlatformPolicies));
registerBuiltinProviders(); registerCommunityProviders();
const plugins = await loadProviderPlugins(getPluginsPath());
for (const p of plugins) registerProvider(p);
console.log('providers', getRegisteredProviders().map(p => p.id), 'plugins', plugins.length);
for (const dir of [process.env.PROBE_SOURCE!, process.env.PROBE_TARGET!]) {
  const cfg = await loadConfig(dir);
  console.log('config', dir, JSON.stringify({assistant: cfg.assistant, tiers: cfg.tiers, aliases: cfg.aliases, defaults: cfg.defaults, commands: cfg.commands}));
}
const result = await discoverWorkflowsWithConfig(process.env.PROBE_SOURCE!, loadConfig, providerRegistry);
console.log('result', JSON.stringify(result));
const chosen = resolveWorkflowName('archon-implement', result.workflows.map(x => x.workflow));
console.log('resolved', JSON.stringify(result.workflows.find(x => x.workflow === chosen) ?? null));
```

From `$T/target`, run `env -i HOME="$T/home" ARCHON_HOME="$T/home/.archon" PATH="$T/bin:/usr/bin:/bin" PROBE_SOURCE="$T/narrow" PROBE_TARGET="$T/target" sandbox-exec -f "$T/sandbox.sb" /absolute/path/to/bun "$T/source/packages/cli/probe-issue56.ts"`, capturing stdout and stderr. Verify both the sandbox's actual `gh` denial and network restriction on the host first. Record all returned errors and logs; the whole result is large. This directly calls discovery and resolution, not CLI `workflow run` or `--dry-run`.

## Remaining evidence

Full capture/discovery using the actual deployment's source, target, environment, installed plugins and global configuration is unverified. A safe equivalent must first constrain or fence every protected path and prove source capture cannot read holdouts, then preserve the full relevant roots and record all errors, warnings, duplicates and selected source identity. Even success does not establish admission, ownership, a pre-node checkout barrier, credential fencing, result verification, or the single final PR; those require independent design and authorization.
