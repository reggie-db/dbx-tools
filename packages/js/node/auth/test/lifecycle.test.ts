import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TokenLifecycle } from "../src/lifecycle.ts";
import { MemoryCredentialStore, MemoryLockAdapter } from "../src/storage.ts";
import { AuthOptions, type Token, type TokenProvider } from "../src/types.ts";

function token(accessToken: string): Token {
  return {
    accessToken,
    tokenType: "Bearer",
    expiry: new Date(Date.now() + 60_000).toISOString(),
    scopes: [],
  };
}

describe("authentication lifecycle", () => {
  it("falls back to provider login when silent acquisition fails", async () => {
    let logins = 0;
    const provider: TokenProvider = {
      authenticate: async () => {
        throw new Error("missing CLI credential");
      },
      login: async () => {
        logins += 1;
        return token("login");
      },
      refresh: async () => token("refresh"),
      canAuthenticateSilently: () => true,
    };
    const client = new TokenLifecycle(
      "profile",
      provider,
      new MemoryCredentialStore(),
      AuthOptions.create({ refreshBufferMs: 0 }),
    );

    assert.equal((await client.tokenOrLogin()).accessToken, "login");
    assert.equal(logins, 1);
  });

  it("checks again after locking so concurrent misses authenticate once", async () => {
    let acquisitions = 0;
    const provider: TokenProvider = {
      async authenticate() {
        acquisitions += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return token("shared");
      },
      login: async () => token("login"),
      refresh: async () => token("refresh"),
      canAuthenticateSilently: () => true,
    };
    const client = new TokenLifecycle(
      "profile",
      provider,
      new MemoryCredentialStore(),
      AuthOptions.create({ refreshBufferMs: 0 }),
    );

    const [left, right] = await Promise.all([client.token(), client.token()]);
    assert.equal(left.accessToken, "shared");
    assert.equal(right.accessToken, "shared");
    assert.equal(acquisitions, 1);
  });

  it("reuses a replacement written while a rejected token waited for the lock", async () => {
    const store = new MemoryCredentialStore();
    await store.save("profile", token("stale"));
    let refreshes = 0;
    const provider: TokenProvider = {
      authenticate: async () => token("authenticated"),
      login: async () => token("login"),
      async refresh() {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return token("replacement");
      },
      canAuthenticateSilently: () => true,
    };
    const client = new TokenLifecycle(
      "profile",
      provider,
      store,
      AuthOptions.create({ refreshBufferMs: 0 }),
    );

    const [left, right] = await Promise.all([
      client.refreshRejectedToken("stale"),
      client.refreshRejectedToken("stale"),
    ]);
    assert.equal(left.accessToken, "replacement");
    assert.equal(right.accessToken, "replacement");
    assert.equal(refreshes, 1);
  });

  it("does not poison the in-memory queue when a waiter times out", async () => {
    const locks = new MemoryLockAdapter();
    const first = await locks.acquire("profile", 100);
    await assert.rejects(locks.acquire("profile", 10), /timed out/i);
    await locks.release(first);
    const next = await locks.acquire("profile", 100);
    await locks.release(next);
  });

  it("does not let a later caller bypass the active holder", async () => {
    const locks = new MemoryLockAdapter();
    const held = await locks.acquire("profile");

    // A second caller must stay queued while the holder is still active - never
    // granted concurrently. Race its acquisition against a short settle timer.
    let granted = false;
    const next = locks.acquire("profile").then((lease) => {
      granted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(granted, false, "second caller acquired while the holder was active");

    await locks.release(held);
    await locks.release(await next);
  });

  it("keeps a timed-out waiter from unlocking an active holder", async () => {
    const locks = new MemoryLockAdapter();
    // The exact reproduced sequence: A holds, B times out, C must NOT acquire
    // while A is still held.
    const a = await locks.acquire("profile");
    await assert.rejects(locks.acquire("profile", 10), /timed out/i);

    let cGranted = false;
    const c = locks.acquire("profile").then((lease) => {
      cGranted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(cGranted, false, "C bypassed the lock after B timed out");

    await locks.release(a);
    await locks.release(await c);
  });

  it("waits indefinitely by default and resolves only on release", async () => {
    const locks = new MemoryLockAdapter();
    const held = await locks.acquire("profile");

    let resolved = false;
    const waiter = locks.acquire("profile").then((lease) => {
      resolved = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false, "indefinite waiter resolved before release");

    await locks.release(held);
    assert.ok(await waiter);
  });

  it("ignores a stale release from a lease that no longer owns the key", async () => {
    const locks = new MemoryLockAdapter();
    const first = await locks.acquire("profile");
    await locks.release(first);
    const second = await locks.acquire("profile");
    // Releasing the superseded lease must not revoke the current holder.
    await locks.release(first);

    let granted = false;
    const next = locks.acquire("profile").then((lease) => {
      granted = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(granted, false, "stale release revoked the active holder");

    await locks.release(second);
    await locks.release(await next);
  });
});
