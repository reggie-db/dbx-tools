import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SshClient } from "../src/react/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("SshClient", () => {
  it("surfaces AppKit error response messages", async () => {
    globalThis.fetch = (async () =>
      Response.json(
        { error: "connect EHOSTUNREACH 192.168.200.10:2222" },
        { status: 500 },
      )) as typeof fetch;
    const client = new SshClient();

    await assert.rejects(
      client.start("machine-1"),
      /connect EHOSTUNREACH 192\.168\.200\.10:2222/,
    );
  });
});
