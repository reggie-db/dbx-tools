import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { looksLikeEmail, matchesAllowlist } from "../src/allowlist.ts";
import { CodeStore, resetSigningKey, signSession, verifySession } from "../src/otp.ts";
import { RateLimiter } from "../src/rate-limit.ts";

describe("allowlist", () => {
  it("matches domain shortcut, glob, and /regex/; empty = nobody", () => {
    assert.equal(matchesAllowlist("a@databricks.com", ["databricks.com"]), true);
    assert.equal(matchesAllowlist("a@databricks.com", ["@databricks.com"]), true);
    assert.equal(matchesAllowlist("bot@ci.databricks.com", ["*.databricks.com"]), true);
    assert.equal(matchesAllowlist("Ada@Databricks.com", ["/@databricks\\.com$/"]), true);
    assert.equal(matchesAllowlist("x@evil.com", ["databricks.com"]), false);
    assert.equal(matchesAllowlist("a@databricks.com", []), false);
  });

  it("validates address shape", () => {
    assert.equal(looksLikeEmail("a@b.com"), true);
    assert.equal(looksLikeEmail("nope"), false);
  });
});

describe("rate limiter", () => {
  it("allows up to max then blocks with retryAfter; resets after window", () => {
    const rl = new RateLimiter(2, 1000);
    assert.equal(rl.hit("k", 0).allowed, true);
    assert.equal(rl.hit("k", 0).allowed, true);
    assert.equal(rl.hit("k", 0).allowed, false);
    assert.equal(rl.hit("k", 1000).allowed, true);
  });
});

describe("code store (cache-backed)", () => {
  before(async () => {
    // CodeStore uses CacheManager.getInstanceSync(); init it (memory) for tests.
    await CacheManager.getInstance();
  });

  it("verifies a correct code once, then it is spent", async () => {
    const store = new CodeStore(60, 5);
    const code = await store.issue("a@b.com");
    assert.equal(await store.verify("a@b.com", code), "ok");
    assert.equal(await store.verify("a@b.com", code), "expired"); // consumed -> miss
  });

  it("rejects a wrong code and burns after max attempts", async () => {
    const store = new CodeStore(60, 3);
    await store.issue("b@b.com");
    assert.equal(await store.verify("b@b.com", "111111"), "invalid");
    assert.equal(await store.verify("b@b.com", "222222"), "invalid");
    assert.equal(await store.verify("b@b.com", "333333"), "too-many-attempts");
    assert.equal(await store.verify("b@b.com", "444444"), "expired"); // burned
  });

  it("issues a 6-digit code", async () => {
    const store = new CodeStore(60, 5);
    assert.match(await store.issue("c@b.com"), /^\d{6}$/);
  });
});

describe("session jwt", () => {
  it("round-trips a signed session", async () => {
    process.env.AUTH_JWT_SECRET = "test-secret";
    resetSigningKey();
    const token = await signSession("a@b.com", 3600);
    assert.equal(await verifySession(token), "a@b.com");
    delete process.env.AUTH_JWT_SECRET;
    resetSigningKey();
  });

  it("rejects an empty / bad token", async () => {
    assert.equal(await verifySession(undefined), undefined);
    assert.equal(await verifySession("not.a.jwt"), undefined);
  });
});
