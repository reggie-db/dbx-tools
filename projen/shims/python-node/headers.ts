export class PythonHeaders implements Iterable<[string, string]> {
  readonly #values = new Map<string, string[]>();

  constructor(init?: HeadersInit) {
    if (!init) return;
    if (Symbol.iterator in Object(init)) {
      for (const [name, value] of init as Iterable<[string, string]>) this.append(name, value);
      return;
    }
    for (const [name, value] of Object.entries(init)) this.set(name, String(value));
  }

  append(name: string, value: string): void {
    const key = normalizeName(name);
    const values = this.#values.get(key) ?? [];
    values.push(String(value));
    this.#values.set(key, values);
  }

  delete(name: string): void {
    this.#values.delete(normalizeName(name));
  }

  entries(): IterableIterator<[string, string]> {
    return this.#iterateEntries();
  }

  forEach(
    callback: (value: string, key: string, parent: PythonHeaders) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }

  get(name: string): string | null {
    const values = this.#values.get(normalizeName(name));
    return values ? values.join(", ") : null;
  }

  getSetCookie(): string[] {
    return [...(this.#values.get("set-cookie") ?? [])];
  }

  has(name: string): boolean {
    return this.#values.has(normalizeName(name));
  }

  keys(): IterableIterator<string> {
    return this.#values.keys();
  }

  set(name: string, value: string): void {
    this.#values.set(normalizeName(name), [String(value)]);
  }

  values(): IterableIterator<string> {
    return this.#iterateValues();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }

  *#iterateEntries(): IterableIterator<[string, string]> {
    for (const [name, values] of this.#values) yield [name, values.join(", ")];
  }

  *#iterateValues(): IterableIterator<string> {
    for (const [, value] of this) yield value;
  }
}

function normalizeName(name: string): string {
  return String(name).toLowerCase();
}
