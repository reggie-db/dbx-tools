import { pythonHost } from "./host.ts";

class PythonHash {
  private readonly content: number[] = [];

  constructor(private readonly algorithm: string) {}

  update(value: string | ArrayBuffer | ArrayBufferView): this {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.content.push(...bytes);
    return this;
  }

  digest(encoding?: "hex" | "base64"): string | Uint8Array {
    const digest = pythonHost().crypto.digest(this.algorithm, this.content, encoding);
    if (typeof digest === "string") return digest;
    const bytes = Uint8Array.from(digest) as Uint8Array & {
      readBigInt64BE(offset: number): bigint;
    };
    bytes.readBigInt64BE = (offset) => {
      let value = 0n;
      for (const byte of bytes.slice(offset, offset + 8)) {
        value = (value << 8n) | BigInt(byte);
      }
      return BigInt.asIntN(64, value);
    };
    return bytes;
  }
}

export function createHash(algorithm: string): PythonHash {
  const normalized = algorithm.toLowerCase();
  if (!getHashes().includes(normalized)) {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return new PythonHash(normalized);
}

export function getHashes(): string[] {
  return pythonHost().crypto.hashes();
}

export function randomBytes(length: number): Uint8Array {
  return Uint8Array.from(pythonHost().crypto.randomBytes(length));
}

export function randomUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default { createHash, getHashes, randomBytes, randomUUID };
