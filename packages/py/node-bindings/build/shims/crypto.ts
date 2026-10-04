import { pythonHost } from "./host.ts";

class PythonHash {
  private readonly content: number[] = [];

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

  digest(encoding: "hex"): string {
    if (encoding !== "hex") throw new Error(`Unsupported digest encoding: ${encoding}`);
    return pythonHost().crypto.sha256(this.content);
  }
}

export function createHash(algorithm: string): PythonHash {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return new PythonHash();
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

export default { createHash, randomBytes, randomUUID };
