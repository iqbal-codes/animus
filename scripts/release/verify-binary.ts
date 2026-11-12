import type { ReleaseArch, ReleaseTarget } from "./targets";

export type NativeBinaryFormat = "macho" | "elf";

export interface DetectedNativeBinary {
  format: NativeBinaryFormat;
  /** Every architecture slice found in the header, in file order. */
  archs: Array<ReleaseArch | "unknown">;
  /** True for a Mach-O universal ("fat") container with more than one slice. */
  universal: boolean;
}

const CPU_TYPE_X86_64 = 0x01000007;
const CPU_TYPE_ARM64 = 0x0100000c;

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

function machoArch(cputype: number): ReleaseArch | "unknown" {
  if (cputype === CPU_TYPE_X86_64) return "x64";
  if (cputype === CPU_TYPE_ARM64) return "arm64";
  return "unknown";
}

function elfArch(machine: number): ReleaseArch | "unknown" {
  if (machine === EM_X86_64) return "x64";
  if (machine === EM_AARCH64) return "arm64";
  return "unknown";
}

function isElfMagic(bytes: Buffer): boolean {
  return bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
}

/**
 * Reads only the container header, so callers can inspect a binary from a
 * tarball member without extracting the whole file. Returns null for anything
 * that is not a Mach-O or ELF executable.
 */
export function detectNativeBinary(bytes: Buffer): DetectedNativeBinary | null {
  if (bytes.length < 8) return null;

  if (isElfMagic(bytes)) {
    if (bytes.length < 20) return null;
    // EI_DATA: 1 = little endian, 2 = big endian.
    const little = bytes[5] !== 2;
    const machine = little ? bytes.readUInt16LE(18) : bytes.readUInt16BE(18);
    return { format: "elf", archs: [elfArch(machine)], universal: false };
  }

  // Thin Mach-O: 64-bit little-endian (0xfeedfacf) or 32-bit (0xfeedface).
  const isMacho64 =
    bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe;
  const isMacho32 =
    bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe;
  if (isMacho64 || isMacho32) {
    return { format: "macho", archs: [machoArch(bytes.readUInt32LE(4))], universal: false };
  }

  // Universal Mach-O: fat header, big-endian fields.
  if (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) {
    const sliceCount = bytes.length >= 8 ? bytes.readUInt32BE(4) : 0;
    const archs: Array<ReleaseArch | "unknown"> = [];
    for (let i = 0; i < Math.min(sliceCount, 16); i += 1) {
      const offset = 8 + i * 20;
      if (offset + 4 > bytes.length) break;
      archs.push(machoArch(bytes.readUInt32BE(offset)));
    }
    return { format: "macho", archs, universal: archs.length > 1 };
  }

  return null;
}

/**
 * Fails closed when a binary cannot run on its advertised target. The returned
 * value is the parsed header, so callers can report what actually shipped.
 */
export function assertNativeBinaryForTarget(
  bytes: Buffer,
  target: ReleaseTarget,
  label: string,
): DetectedNativeBinary {
  const detected = detectNativeBinary(bytes);
  if (!detected) {
    throw new Error(
      `${label} is not a Mach-O or ELF executable; refusing to ship a non-native binary for ${target.platform}-${target.arch}`,
    );
  }

  const expectedFormat: NativeBinaryFormat = target.platform === "darwin" ? "macho" : "elf";
  if (detected.format !== expectedFormat) {
    throw new Error(
      `${label} is ${detected.format.toUpperCase()}, but ${target.platform}-${target.arch} requires ${expectedFormat.toUpperCase()}`,
    );
  }

  if (!detected.archs.includes(target.arch)) {
    const actual = detected.archs.join(", ") || "unknown";
    throw new Error(
      `${label} was built for ${actual}, but ${target.platform}-${target.arch} requires ${target.arch}`,
    );
  }

  return detected;
}
