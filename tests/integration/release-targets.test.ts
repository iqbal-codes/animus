import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RELEASE_TARGETS } from "../../scripts/release/targets";
import {
  assertNativeBinaryForTarget,
  detectNativeBinary,
} from "../../scripts/release/verify-binary";
import {
  packageAllCliDistributionTarballs,
  packageCliDistributionTarball,
  verifyDistributionTarball,
} from "../../scripts/release/package";

const ELF_MACHINE = { x64: 62, arm64: 183 } as const;
const MACHO_CPU = { x64: 0x01000007, arm64: 0x0100000c } as const;

function elfBinary(arch: "x64" | "arm64", marker: string): Buffer {
  const bytes = Buffer.alloc(4096);
  bytes.write("\x7fELF", 0, "binary");
  bytes[4] = 2; // ELFCLASS64
  bytes[5] = 1; // little endian
  bytes[6] = 1; // EV_CURRENT
  bytes.writeUInt16LE(ELF_MACHINE[arch], 18);
  bytes.write(marker, 64, "utf8");
  return bytes;
}

function machoBinary(arch: "x64" | "arm64", marker: string): Buffer {
  const bytes = Buffer.alloc(4096);
  bytes.writeUInt32LE(0xfeedfacf, 0); // MH_MAGIC_64, little endian
  bytes.writeUInt32LE(MACHO_CPU[arch], 4);
  bytes.write(marker, 32, "utf8");
  return bytes;
}

function releaseFixtureBinary(target: { platform: string; arch: "x64" | "arm64" }): Buffer {
  const marker = `${target.platform}-${target.arch}-release`;
  return target.platform === "darwin"
    ? machoBinary(target.arch, marker)
    : elfBinary(target.arch, marker);
}

function tarballMember(tarballPath: string, member: string): Buffer {
  return execFileSync("tar", ["-xOf", tarballPath, member], { maxBuffer: 1 << 20 });
}

describe("Per-target release binaries", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "animus-release-targets-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeReleaseBinaries(repoRoot: string): void {
    for (const target of RELEASE_TARGETS) {
      const dir = join(repoRoot, "dist", "release", `${target.platform}-${target.arch}`);
      mkdirSync(dir, { recursive: true });
      const bytes = releaseFixtureBinary(target);
      writeFileSync(join(dir, "animus"), bytes, { mode: 0o755 });
      writeFileSync(join(dir, "factory"), bytes, { mode: 0o755 });
    }
  }

  describe("native binary detection", () => {
    test("identifies ELF and Mach-O containers with their CPU architecture", () => {
      expect(detectNativeBinary(elfBinary("x64", "a"))).toEqual({
        format: "elf",
        archs: ["x64"],
        universal: false,
      });
      expect(detectNativeBinary(elfBinary("arm64", "a"))).toEqual({
        format: "elf",
        archs: ["arm64"],
        universal: false,
      });
      expect(detectNativeBinary(machoBinary("arm64", "a"))).toEqual({
        format: "macho",
        archs: ["arm64"],
        universal: false,
      });
      expect(detectNativeBinary(machoBinary("x64", "a"))).toEqual({
        format: "macho",
        archs: ["x64"],
        universal: false,
      });
    });

    test("rejects data that is not an executable rather than guessing", () => {
      expect(detectNativeBinary(Buffer.from("#!/bin/sh\necho animus v0.2.0\n"))).toBeNull();
      expect(detectNativeBinary(Buffer.from([0x7f, 0x45]))).toBeNull();
      expect(detectNativeBinary(Buffer.alloc(0))).toBeNull();
    });

    test("fails closed on a format that does not match the target platform", () => {
      expect(() =>
        assertNativeBinaryForTarget(
          elfBinary("arm64", "x"),
          { platform: "darwin", arch: "arm64" },
          "tarball:animus",
        ),
      ).toThrow(/ELF.*darwin-arm64.*MACHO/);
      expect(() =>
        assertNativeBinaryForTarget(
          machoBinary("arm64", "x"),
          { platform: "linux", arch: "arm64" },
          "tarball:animus",
        ),
      ).toThrow(/MACHO.*linux-arm64.*ELF/);
    });

    test("fails closed on an architecture that does not match the target", () => {
      expect(() =>
        assertNativeBinaryForTarget(
          elfBinary("x64", "x"),
          { platform: "linux", arch: "arm64" },
          "tarball:animus",
        ),
      ).toThrow(/built for x64.*requires arm64/);
      expect(() =>
        assertNativeBinaryForTarget(
          machoBinary("x64", "x"),
          { platform: "darwin", arch: "arm64" },
          "tarball:animus",
        ),
      ).toThrow(/built for x64.*requires arm64/);
    });
  });

  describe("packaging", () => {
    test("every tarball contains the binary compiled for its own target", async () => {
      const repoRoot = join(tempDir, "repo");
      const outDir = join(tempDir, "releases");
      mkdirSync(repoRoot, { recursive: true });
      writeReleaseBinaries(repoRoot);

      const { tarballs } = await packageAllCliDistributionTarballs({
        version: "0.2.0",
        repoRoot,
        outDir,
      });

      expect(tarballs).toHaveLength(4);

      for (const tarball of tarballs) {
        const expected = releaseFixtureBinary(tarball);
        const member = tarballMember(tarball.tarballPath, "animus");

        expect(member.subarray(0, 4)).toEqual(expected.subarray(0, 4));
        expect(member.includes(`${tarball.platform}-${tarball.arch}-release`)).toBe(true);
        expect(tarball.binary).toEqual({
          format: tarball.platform === "darwin" ? "macho" : "elf",
          archs: [tarball.arch],
          universal: false,
        });
      }
    });

    test("a darwin tarball never ships ELF bytes and a linux tarball never ships Mach-O bytes", async () => {
      const repoRoot = join(tempDir, "repo");
      const outDir = join(tempDir, "releases");
      mkdirSync(repoRoot, { recursive: true });
      writeReleaseBinaries(repoRoot);

      const { tarballs } = await packageAllCliDistributionTarballs({
        version: "0.2.0",
        repoRoot,
        outDir,
      });

      for (const tarball of tarballs) {
        const member = tarballMember(tarball.tarballPath, "animus");
        const detected = detectNativeBinary(member);
        expect(detected?.format).toBe(tarball.platform === "darwin" ? "macho" : "elf");
        expect(detected?.format === "elf").toBe(tarball.platform === "linux");
      }
    });

    test("refuses to package when a target binary is missing instead of writing a stub", async () => {
      const repoRoot = join(tempDir, "repo");
      const outDir = join(tempDir, "releases");
      mkdirSync(repoRoot, { recursive: true });
      writeReleaseBinaries(repoRoot);
      rmSync(join(repoRoot, "dist", "release", "linux-arm64"), { recursive: true, force: true });

      await expect(
        packageAllCliDistributionTarballs({ version: "0.2.0", repoRoot, outDir }),
      ).rejects.toThrow(/Missing linux-arm64 animus binary.*build:cli:release/s);

      const tarballPath = join(outDir, "animus-v0.2.0-linux-arm64.tar.gz");
      expect(existsSync(tarballPath)).toBe(false);
    });

    test("refuses to package a binary built for the wrong architecture", async () => {
      const repoRoot = join(tempDir, "repo");
      mkdirSync(repoRoot, { recursive: true });
      writeReleaseBinaries(repoRoot);
      writeFileSync(
        join(repoRoot, "dist", "release", "linux-arm64", "animus"),
        elfBinary("x64", "wrong-arch"),
        { mode: 0o755 },
      );

      await expect(
        packageCliDistributionTarball({
          version: "0.2.0",
          platform: "linux",
          arch: "arm64",
          repoRoot,
          outDir: join(tempDir, "releases"),
        }),
      ).rejects.toThrow(/built for x64.*requires arm64/);
    });

    test("verifies members back out of an archive and rejects non-native content", async () => {
      const repoRoot = join(tempDir, "repo");
      const outDir = join(tempDir, "releases");
      mkdirSync(repoRoot, { recursive: true });
      writeReleaseBinaries(repoRoot);

      const tarball = await packageCliDistributionTarball({
        version: "0.2.0",
        platform: "linux",
        arch: "x64",
        repoRoot,
        outDir,
      });

      expect(() =>
        verifyDistributionTarball(tarball.tarballPath, { platform: "darwin", arch: "x64" }),
      ).toThrow(/ELF.*darwin-x64/);
    });

    test("keeps the build:cli:release entrypoint wired to the per-target builder", () => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts["build:cli:release"]).toBe(
        "bun scripts/release/build-cli.ts --release-targets",
      );
    });
  });
});
