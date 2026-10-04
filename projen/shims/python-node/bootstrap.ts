import { Buffer } from "node:buffer";

import { installPythonGlobals, pythonHost } from "./host.ts";

installPythonGlobals();

(globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;

const globals = globalThis as typeof globalThis & {
  TextDecoder?: typeof TextDecoder;
  TextEncoder?: typeof TextEncoder;
  fetch?: typeof fetch;
};
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
  const response = await pythonHost().http.fetch(
    String(input),
    init.method,
    init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
    typeof init.body === "string" ? init.body : undefined,
  );
  return new Response(Uint8Array.from(response.body), {
    status: response.status,
    headers: response.headers,
  });
}) as typeof fetch;
