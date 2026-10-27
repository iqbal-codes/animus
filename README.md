<img src="assets/icon.svg" width="64" height="64" alt="">

# labq-software-factory

Autonomous software factory with an existing Python operator application and a
Bun/Vite+ migration health journey.

- Existing operations: `python3 app.py --port 8080`; see [runtime contract](docs/runtime.md).
- New health journey: [exact toolchain, independent starts and verification](docs/monorepo-health.md).
  Use Bun **1.4.2**, Node **26.8.1**, `bun install --frozen-lockfile`, then
  `bun run toolchain`. Vite+ **1.4.0** is project-local and Node-backed.
- The new health page is not the operator dashboard replacement. Python remains
  the sole operational owner until later parity migration tickets.

Created in [T3 Code](https://t3.codes).
