import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TokenBroker } from "../src/broker.ts";
import type { AccessToken, TokenProvider } from "../src/provider.ts";

describe("TokenBroker", () => {
  it("coalesces concurrent refreshes for one provider and scope set", async () => {
    let acquisitions = 0;
    const provider: TokenProvider = {
      name: "google",
      acquire: async (scopes): Promise<AccessToken> => {
        acquisitions++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          accessToken: `token-${acquisitions}`,
          tokenType: "Bearer",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: [...scopes],
        };
      },
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: ["scope:a"],
      allowedScopes: ["scope:a", "scope:b"],
      refreshSkewSeconds: 300,
    });

    const tokens = await Promise.all(
      Array.from({ length: 12 }, () => broker.accessToken({ scopes: ["scope:a"] })),
    );

    assert.equal(acquisitions, 1);
    assert.deepEqual(new Set(tokens.map((token) => token.accessToken)), new Set(["token-1"]));
    broker.close();
  });

  it("caches canonical scope sets separately and rejects escalation", async () => {
    const calls: string[][] = [];
    const provider: TokenProvider = {
      name: "google",
      acquire: async (scopes) => {
        calls.push([...scopes]);
        return {
          accessToken: scopes.join("|"),
          tokenType: "Bearer",
          expiresAt: Date.now() + 60 * 60 * 1000,
          scopes: [...scopes],
        };
      },
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: ["scope:a"],
      allowedScopes: ["scope:a", "scope:b"],
      refreshSkewSeconds: 300,
    });

    await broker.accessToken({ scopes: ["scope:b", "scope:a"] });
    await broker.accessToken({ scopes: ["scope:a", "scope:b"] });
    await broker.accessToken();

    assert.deepEqual(calls, [["scope:a", "scope:b"], ["scope:a"]]);
    await assert.rejects(() => broker.accessToken({ scopes: ["scope:admin"] }), /not allowed/);
    broker.close();
  });

  it("allows every scope when no broker allow-list is configured", async () => {
    const provider: TokenProvider = {
      name: "google",
      acquire: async (scopes) => ({
        accessToken: scopes.join("|"),
        tokenType: "Bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: [...scopes],
      }),
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: [],
      allowedScopes: [],
      refreshSkewSeconds: 300,
    });

    assert.equal(
      (await broker.accessToken({ scopes: ["scope:admin"] })).accessToken,
      "scope:admin",
    );
    broker.close();
  });

  it("keeps the previous token when proactive refresh fails", async () => {
    let callback: (() => void) | undefined;
    let acquisitions = 0;
    let now = 0;
    const provider: TokenProvider = {
      name: "google",
      acquire: async () => {
        acquisitions++;
        if (acquisitions > 1) throw new Error("refresh failed");
        return {
          accessToken: "first",
          tokenType: "Bearer",
          expiresAt: 10_000,
          scopes: [],
        };
      },
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: [],
      allowedScopes: [],
      refreshSkewSeconds: 1,
      now: () => now,
      schedule: (scheduled) => {
        callback = scheduled;
        return { unref: () => undefined } as ReturnType<typeof setTimeout>;
      },
    });

    assert.equal((await broker.accessToken()).accessToken, "first");
    assert.ok(callback);
    now = 9_000;
    callback();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(acquisitions, 2);
    broker.close();
  });
});
