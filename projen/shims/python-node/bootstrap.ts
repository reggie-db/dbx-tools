import { Buffer } from "node:buffer";

import { PythonHeaders } from "./headers.ts";
import { installPythonGlobals, pythonHost } from "./host.ts";

installPythonGlobals();

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;

const globals = globalThis as typeof globalThis & {
  AbortController?: typeof AbortController;
  Headers?: typeof Headers;
  Request?: typeof Request;
  Response?: typeof Response;
  structuredClone?: typeof structuredClone;
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
  fetch?: typeof fetch;
};
globals.AbortController ??= class AbortController {
  readonly signal: AbortSignal;
  readonly #listeners = new Set<() => void>();

  constructor() {
    this.signal = {
      aborted: false,
      addEventListener: (name: string, listener: EventListenerOrEventListenerObject) => {
        if (name === "abort") {
          this.#listeners.add(
            typeof listener === "function"
              ? () => listener(new Event("abort"))
              : () => listener.handleEvent(new Event("abort")),
          );
        }
      },
      removeEventListener: () => {},
    } as AbortSignal;
  }

  abort(): void {
    if (this.signal.aborted) return;
    Object.defineProperty(this.signal, "aborted", { value: true });
    for (const listener of this.#listeners) listener();
    this.#listeners.clear();
  }
} as typeof AbortController;

globals.Headers ??= PythonHeaders as unknown as typeof Headers;

class PythonResponse {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly status: number;
  readonly #body: Uint8Array;

  constructor(body: Uint8Array, init: ResponseInit = {}) {
    this.#body = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#body.slice().buffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.#body);
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

globals.Response ??= PythonResponse as unknown as typeof Response;
globals.structuredClone ??= ((value: unknown) => cloneStructured(value)) as typeof structuredClone;
globals.TextEncoder ??= class TextEncoder {
  encode(value: string): Uint8Array {
    const encoded = unescape(encodeURIComponent(String(value)));
    return Uint8Array.from(encoded, (character) => character.charCodeAt(0));
  }
} as typeof TextEncoder;
globals.TextDecoder ??= class TextDecoder {
  decode(value?: ArrayBuffer | ArrayBufferView): string {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : value
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new Uint8Array();
    const encoded = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return decodeURIComponent(escape(encoded));
  }
} as typeof TextDecoder;
globals.fetch ??= (async (input: string | URL | Request, init: RequestInit = {}) => {
  const request = typeof input === "object" && "url" in input ? input : undefined;
  const headers = init.headers ?? request?.headers;
  const response = await pythonHost().http.fetch(
    request?.url ?? String(input),
    init.method ?? request?.method,
    headers ? Object.fromEntries(new Headers(headers).entries()) : undefined,
    typeof init.body === "string" ? init.body : undefined,
  );
  return new Response(Uint8Array.from(response.body), {
    status: response.status,
    headers: response.headers,
  });
}) as typeof fetch;

function cloneStructured(value: unknown, seen = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneStructured(item, seen));
    return clone;
  }
  if (Object.getPrototypeOf(value) === Object.prototype) {
    const clone: Record<string, unknown> = {};
    seen.set(value, clone);
    for (const [key, item] of Object.entries(value)) clone[key] = cloneStructured(item, seen);
    return clone;
  }
  throw new TypeError(`PythonMonkey structuredClone does not support ${value.constructor.name}`);
}
