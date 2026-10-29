<img src="assets/icon.svg" width="64" height="64" alt="">

# labq-software-factory

Autonomous software factory with unified launcher, local-first React web console,
durable persistence, and private engine-host coordination on Bun/Vite+.

- Start operations: `bun apps/launcher/src/main.ts --port 3000`; see [runtime contract](docs/runtime.md).
- New health journey: [exact toolchain, independent starts and verification](docs/monorepo-health.md).
  Use Bun **1.4.2**, Node **26.8.1**, `bun install --frozen-lockfile`, then
  `bun run toolchain`. Vite+ **1.4.0** is project-local and Node-backed.
- The web console provides the unified operator dashboard, multi-repo project registry,
  and spec coordination interface on `127.0.0.1:3000`.

Created in [T3 Code](https://t3.codes).
