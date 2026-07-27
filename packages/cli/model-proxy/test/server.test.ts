import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import type { DatabricksBackend } from "../src/backend";
import { DEFAULT_RETRY, resolveRetryConfig } from "../src/defaults";
import { backoffDelayMs, createProxyServer, parseRetryAfterMs } from "../src/server";

/** Listen on an ephemeral port and resolve the bound port. */
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(typeof address === "object" && address);
  return address.port;
}

describe("createProxyServer timeouts", () => {
  it("disables every inbound timeout that could cut a stream short", () => {
    const server = createProxyServer({} as DatabricksBackend);
    // Node's defaults (300s request, 60s headers) are sized for ordinary web
    // traffic and would kill a long model turn mid-stream.
    assert.equal(server.requestTimeout, 0);
    assert.equal(server.headersTimeout, 0);
    assert.equal(server.timeout, 0);
    server.close();
  });

  it("differs from a stock node server, so the override is doing the work", () => {
    const stock = createServer();
    assert.notEqual(stock.requestTimeout, 0);
    assert.notEqual(stock.headersTimeout, 0);
    stock.close();
  });
});

describe("upstream dispatcher", () => {
  /**
   * Serve one chunk, stall past the supplied body timeout, then finish. Proves
   * `bodyTimeout` measures the gap BETWEEN chunks - the failure mode that made
   * long-thinking turns look like dropped streams.
   */
  async function readThroughStall(bodyTimeout: number): Promise<string> {
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.write("data: second\n\n");
        res.end();
      }, 1_000);
    });
    const port = await listen(upstream);
    try {
      const { Agent } = await import("undici");
      const init: RequestInit = { method: "GET" };
      Reflect.set(init, "dispatcher", new Agent({ bodyTimeout, headersTimeout: 0 }));
      const response = await fetch(`http://127.0.0.1:${port}/`, init);
      let body = "";
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        body += Buffer.from(chunk).toString();
      }
      return body;
    } finally {
      upstream.close();
    }
  }

  it("aborts a stalled stream when bodyTimeout is set", async () => {
    await assert.rejects(() => readThroughStall(100));
  });

  it("survives the same stall with bodyTimeout disabled, as the proxy configures it", async () => {
    assert.equal(await readThroughStall(0), "data: first\n\ndata: second\n\n");
  });
});

describe("parseRetryAfterMs", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);

  it("reads an integer count of seconds", () => {
    assert.equal(parseRetryAfterMs("2", now), 2000);
    assert.equal(parseRetryAfterMs("  30 ", now), 30_000);
  });

  it("reads an HTTP date as ms-until, clamped at zero", () => {
    const future = new Date(now + 5000).toUTCString();
    assert.equal(parseRetryAfterMs(future, now), 5000);
    const past = new Date(now - 5000).toUTCString();
    assert.equal(parseRetryAfterMs(past, now), 0);
  });

  it("returns undefined for a missing or unparseable header", () => {
    assert.equal(parseRetryAfterMs(null, now), undefined);
    assert.equal(parseRetryAfterMs("soon", now), undefined);
  });
});

describe("backoffDelayMs", () => {
  const retry = { enabled: true, maxRetries: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

  it("grows exponentially from the base with jitter=0", () => {
    assert.equal(backoffDelayMs(0, retry, undefined, 0), 500);
    assert.equal(backoffDelayMs(1, retry, undefined, 0), 1000);
    assert.equal(backoffDelayMs(2, retry, undefined, 0), 2000);
  });

  it("caps the exponential at maxDelayMs", () => {
    assert.equal(backoffDelayMs(20, retry, undefined, 0), retry.maxDelayMs);
  });

  it("adds up to +50% jitter", () => {
    assert.equal(backoffDelayMs(0, retry, undefined, 1), 750);
  });

  it("lets a Retry-After win outright, still capped", () => {
    assert.equal(backoffDelayMs(0, retry, 3000, 1), 3000);
    assert.equal(backoffDelayMs(0, retry, 99_000, 0), retry.maxDelayMs);
  });
});

describe("resolveRetryConfig", () => {
  /** Run `fn` with `env` applied to `process.env`, restoring after. */
  function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
    const saved = new Map<string, string | undefined>();
    for (const key of Object.keys(env)) {
      saved.set(key, process.env[key]);
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    try {
      fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it("defaults to on with the built-in policy", () => {
    withEnv(
      {
        PROXY_RETRY_ON_429: undefined,
        PROXY_RETRY_MAX: undefined,
        PROXY_RETRY_BASE_MS: undefined,
        PROXY_RETRY_MAX_MS: undefined,
      },
      () => assert.deepEqual(resolveRetryConfig(), DEFAULT_RETRY),
    );
  });

  it("honors a loose PROXY_RETRY_ON_429 to switch it off", () => {
    withEnv({ PROXY_RETRY_ON_429: "no" }, () => assert.equal(resolveRetryConfig().enabled, false));
    withEnv({ PROXY_RETRY_ON_429: "off" }, () => assert.equal(resolveRetryConfig().enabled, false));
  });

  it("reads numeric tunables from env", () => {
    withEnv(
      { PROXY_RETRY_MAX: "9", PROXY_RETRY_BASE_MS: "250", PROXY_RETRY_MAX_MS: "60000" },
      () => {
        const config = resolveRetryConfig();
        assert.equal(config.maxRetries, 9);
        assert.equal(config.baseDelayMs, 250);
        assert.equal(config.maxDelayMs, 60_000);
      },
    );
  });

  it("lets an explicit override beat env (the CLI --no-retry-429 path)", () => {
    withEnv({ PROXY_RETRY_ON_429: "true" }, () =>
      assert.equal(resolveRetryConfig({ enabled: false }).enabled, false),
    );
  });
});
