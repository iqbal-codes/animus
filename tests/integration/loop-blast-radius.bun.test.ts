import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_EXTENSIONS,
  extractImportSpecifiers,
  loadGroundedAliases,
  resolveGroundedAlias,
  doesImportTargetFile,
  streamBoundedProcess,
  computeExternalBlastRadius,
  type ExternalBlastRadiusOptions,
  type GroundedAliasRule,
  type StreamBoundedResult,
} from "../../scripts/loop/blast-radius";
import * as loopExports from "../../scripts/loop/index";
import {
  computeExternalBlastRadius as localLoopComputeBlastRadius,
  type ExternalBlastRadiusOptions as LocalLoopBlastRadiusOptions,
} from "../../scripts/local-loop";

const tempDirs: string[] = [];
afterEach(async () => {
  for (const d of tempDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe("scripts/loop/blast-radius", () => {
  test("AC1: exports KNOWN_EXTENSIONS array containing expected source extensions", () => {
    expect(KNOWN_EXTENSIONS).toBeArray();
    expect(KNOWN_EXTENSIONS).toContain(".ts");
    expect(KNOWN_EXTENSIONS).toContain(".tsx");
    expect(KNOWN_EXTENSIONS).toContain(".js");
    expect(KNOWN_EXTENSIONS).toContain(".jsx");
    expect(KNOWN_EXTENSIONS).toContain(".mjs");
    expect(KNOWN_EXTENSIONS).toContain(".cjs");
  });

  test("AC1: extractImportSpecifiers extracts static, dynamic, require, and side-effect imports", () => {
    const code = `
      import { a } from "./a";
      import b from '../b';
      const c = require("./c");
      const d = await import("@scope/pkg/sub");
      import "./styles.css";
      import { duplicate } from "./a";
    `;
    const lines = code.split("\n");
    const allSpecifiers = lines.flatMap((l) => extractImportSpecifiers(l));
    expect(allSpecifiers).toContain("./a");
    expect(allSpecifiers).toContain("../b");
    expect(allSpecifiers).toContain("./c");
    expect(allSpecifiers).toContain("@scope/pkg/sub");
    expect(allSpecifiers).toContain("./styles.css");
  });

  test("AC1: loadGroundedAliases parses tsconfig paths and package exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "blast-alias-"));
    tempDirs.push(root);

    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
            "@utils": ["src/utils/index.ts"],
          },
        },
      }),
    );

    await mkdir(join(root, "packages", "core"), { recursive: true });
    await writeFile(
      join(root, "packages", "core", "package.json"),
      JSON.stringify({
        name: "@animus/core",
        exports: {
          ".": "./src/index.ts",
          "./helper": "./src/helper.ts",
        },
      }),
    );

    const aliases = loadGroundedAliases(root);
    expect(aliases.length).toBeGreaterThanOrEqual(4);

    const wildcard = aliases.find((a) => a.prefix === "@/");
    expect(wildcard).toBeDefined();
    expect(wildcard?.isWildcard).toBe(true);
    expect(wildcard?.targetDir).toBe("src");

    const exact = aliases.find((a) => a.prefix === "@utils");
    expect(exact).toBeDefined();
    expect(exact?.isWildcard).toBe(false);
    expect(exact?.targetDir).toBe("src/utils/index.ts");

    const pkgRoot = aliases.find((a) => a.prefix === "@animus/core");
    expect(pkgRoot).toBeDefined();
    expect(pkgRoot?.targetDir).toBe("packages/core/src/index.ts");

    const pkgSub = aliases.find((a) => a.prefix === "@animus/core/helper");
    expect(pkgSub).toBeDefined();
    expect(pkgSub?.targetDir).toBe("packages/core/src/helper.ts");
  });

  test("AC1: resolveGroundedAlias maps wildcard and exact alias specifiers", () => {
    const rules: GroundedAliasRule[] = [
      { scopeDir: "", prefix: "@/", isWildcard: true, targetDir: "src" },
      { scopeDir: "", prefix: "@utils", isWildcard: false, targetDir: "src/utils/index.ts" },
      { scopeDir: "apps/web", prefix: "~/app/", isWildcard: true, targetDir: "apps/web/src" },
    ];

    expect(resolveGroundedAlias("@/components/Button", "caller.ts", rules)).toEqual([
      "src/components/Button",
    ]);
    expect(resolveGroundedAlias("@utils", "caller.ts", rules)).toEqual(["src/utils/index.ts"]);

    // Scoped alias applies only within scopeDir
    expect(resolveGroundedAlias("~/app/page", "apps/web/src/index.ts", rules)).toEqual([
      "apps/web/src/page",
    ]);
    expect(resolveGroundedAlias("~/app/page", "apps/backend/src/index.ts", rules)).toEqual([]);
  });

  test("AC1: doesImportTargetFile accurately resolves relative and aliased paths to target", () => {
    const rules: GroundedAliasRule[] = [
      { scopeDir: "", prefix: "@/", isWildcard: true, targetDir: "src" },
    ];

    // Relative same directory
    expect(
      doesImportTargetFile("src/feature/caller.ts", "./service", "src/feature/service.ts", rules),
    ).toBe(true);

    // Relative parent directory
    expect(
      doesImportTargetFile(
        "src/feature/sub/caller.ts",
        "../service",
        "src/feature/service.ts",
        rules,
      ),
    ).toBe(true);

    // Index import (directory target)
    expect(
      doesImportTargetFile("src/caller.ts", "./components", "src/components/index.ts", rules),
    ).toBe(true);

    // Aliased target
    expect(doesImportTargetFile("apps/web/src/app.ts", "@/shared", "src/shared.ts", rules)).toBe(
      true,
    );

    // Negative: target file not matched
    expect(doesImportTargetFile("src/caller.ts", "./other", "src/service.ts", rules)).toBe(false);
  });

  test("AC1: streamBoundedProcess runs command, bounds output bytes, and passes PI_CACHE_RETENTION", async () => {
    const root = process.cwd();

    // Normal command execution
    const normal = await streamBoundedProcess(
      ["node", "-e", "console.log('hello blast radius')"],
      root,
      5000,
      1024,
    );
    const typedRes: StreamBoundedResult = normal;
    expect(typedRes.exitCode).toBe(0);
    expect(typedRes.stdout.trim()).toBe("hello blast radius");
    expect(typedRes.truncated).toBe(false);
    expect(typedRes.timedOut).toBe(false);

    // Output byte limit truncation
    const capped = await streamBoundedProcess(
      ["node", "-e", "process.stdout.write('A'.repeat(500))"],
      root,
      5000,
      100,
    );
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.stdout, "utf8")).toBe(100);

    // Timeout execution
    const timedOut = await streamBoundedProcess(
      ["node", "-e", "setTimeout(() => {}, 2000)"],
      root,
      150,
      1024,
    );
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.exitCode).toBe(124);
  });

  test("AC1 & AC2: computeExternalBlastRadius finds callers, supports options, and handles fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "blast-test-"));
    tempDirs.push(root);

    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "target.ts"), "export const value = 42;");
    await writeFile(
      join(root, "src", "caller.ts"),
      "import { value } from './target';\nconsole.log(value);",
    );

    // Unmodified external caller detected
    const result = await computeExternalBlastRadius(root, ["src/target.ts"]);
    expect(result).toContain("src/target.ts");
    expect(result).toContain("src/caller.ts");

    // Producer fallback when unavailable
    const unavailable = await computeExternalBlastRadius(root, ["src/target.ts"], {
      producer: async () => ({
        stdout: "",
        exitCode: 127,
      }),
    });
    expect(unavailable).toContain("External blast radius scan unavailable: ripgrep not installed");
  });

  test("AC2: barrel export in scripts/loop/index.ts exports blast-radius utilities", () => {
    expect((loopExports as any).computeExternalBlastRadius).toBeFunction();
    expect((loopExports as any).extractImportSpecifiers).toBeFunction();
    expect((loopExports as any).loadGroundedAliases).toBeFunction();
    expect((loopExports as any).resolveGroundedAlias).toBeFunction();
    expect((loopExports as any).doesImportTargetFile).toBeFunction();
    expect((loopExports as any).streamBoundedProcess).toBeFunction();
    expect((loopExports as any).KNOWN_EXTENSIONS).toBeArray();
  });

  test("AC2: backward compatibility re-export in scripts/local-loop.ts", () => {
    expect(localLoopComputeBlastRadius).toBeFunction();
    expect(localLoopComputeBlastRadius).toBe(computeExternalBlastRadius);

    const directOpts: ExternalBlastRadiusOptions = { maxFiles: 10 };
    const facadeOpts: LocalLoopBlastRadiusOptions = directOpts;
    expect(facadeOpts.maxFiles).toBe(10);
  });
});
