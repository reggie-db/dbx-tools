import { pythonHost } from "./host.ts";

class PythonHash {
  private value = "";

  update(value: string): this {
    this.value += String(value);
    return this;
  }

  digest(encoding: "hex"): string {
    if (encoding !== "hex") throw new Error(`Unsupported digest encoding: ${encoding}`);
    return pythonHost().crypto.sha256(this.value);
  }
}

export function createHash(algorithm: string): PythonHash {
  if (algorithm.toLowerCase() !== "sha256") {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }
  return new PythonHash();
}

export default { createHash };
