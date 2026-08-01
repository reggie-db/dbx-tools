import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeEmail, matchesAllowlist } from "../src/auth/allowlist.ts";
import { CodeStore, resetSigningKey, signSession, verifySession } from "../src/auth/otp.ts";
import { RateLimiter } from "../src/auth/rate-limit.ts";

describe("auth allowlist", () => {
  it("matches a domain shortcut with or without @", () => {
    assert.equal(matchesAllowlist("a@databricks.com", ["databricks.com"]), true);
    assert.equal(matchesAllowlist("a@databricks.com", ["@databricks.com"]), true);
    assert.equal(matchesAllowlist("a@other.com", ["databricks.com"]), false);
  });

  it("matches a glob against the whole address", () => {
    assert.equal(matchesAllowlist("bot@ci.databricks.com", ["*.databricks.com"]), true);
    assert.equal(matchesAllowlist("me@databricks.com", ["*@databricks.com"]), true);
    assert.equal(matchesAllowlist("me@evil.com", ["*@databricks.com"]), false);
  });

  it("matches a /regex/ (case-insensitive)", () => {
    assert.equal(matchesAllowlist("Ada@Databricks.com", ["/@databricks\\.com$/"]), true);
    assert.equal(matchesAllowlist("ada@nope.com", ["/@databricks\\.com$/"]), false);
  });

  it("fails closed on an empty or missing list", () => {
    assert.equal(matchesAllowlist("a@databricks.com", []), false);
    assert.equal(matchesAllowlist("a@databricks.com", undefined), false);
  });

  it("ignores an invalid regex rather than throwing", () => {
    assert.equal(matchesAllowlist("a@databricks.com", ["/([/"]), false);
  });

  it("validates address shape", () => {
    assert.equal(looksLikeEmail("a@b.com"), true);
    assert.equal(looksLikeEmail("nope"), false);
    assert.equal(looksLikeEmail("a@b"), false);
  });
});

describe("rate limiter", () => {
  it("allows up to max per window then blocks with retryAfter", () => {
    const rl = new RateLimiter(2, 1000);
    const t = 0;
    assert.equal(rl.hit("k", t).allowed, true);
    assert.equal(rl.hit("k", t).allowed, true);
    const blocked = rl.hit("k", t);
    assert.equal(blocked.allowed, false);
    assert.equal(typeof blocked.retryAfter, "number");
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1000);
    assert.equal(rl.hit("k", 0).allowed, true);
    assert.equal(rl.hit("k", 500).allowed, false);
    assert.equal(rl.hit("k", 1000).allowed, true);
  });

  it("max <= 0 disables limiting", () => {
    const rl = new RateLimiter(0, 1000);
    for (let i = 0; i < 100; i++) assert.equal(rl.hit("k", 0).allowed, true);
  });

  it("reset() forgets a key", () => {
    const rl = new RateLimiter(1, 1000);
    rl.hit("k", 0);
    rl.reset("k");
    assert.equal(rl.hit("k", 0).allowed, true);
  });
});

describe("code store", () => {
  it("verifies a correct code once, then it is spent", () => {
    const store = new CodeStore(60_000, 5);
    const code = store.issue("a@b.com", 0);
    assert.equal(store.verify("a@b.com", code, 0), "ok");
    // single-use: a second verify of the same code fails
    assert.equal(store.verify("a@b.com", code, 0), "invalid");
  });

  it("rejects a wrong code", () => {
    const store = new CodeStore(60_000, 5);
    store.issue("a@b.com", 0);
    assert.equal(store.verify("a@b.com", "000000", 0), "invalid");
  });

  it("expires a code past its TTL", () => {
    const store = new CodeStore(1000, 5);
    const code = store.issue("a@b.com", 0);
    assert.equal(store.verify("a@b.com", code, 2000), "expired");
  });

  it("burns the code after too many attempts", () => {
    const store = new CodeStore(60_000, 3);
    store.issue("a@b.com", 0);
    assert.equal(store.verify("a@b.com", "111111", 0), "invalid");
    assert.equal(store.verify("a@b.com", "222222", 0), "invalid");
    assert.equal(store.verify("a@b.com", "333333", 0), "too-many-attempts");
    // burned: even the right code no longer works (it was cleared)
    assert.equal(store.verify("a@b.com", "444444", 0), "invalid");
  });

  it("issues a 6-digit numeric code", () => {
    const store = new CodeStore(60_000, 5);
    const code = store.issue("a@b.com", 0);
    assert.match(code, /^\d{6}$/);
  });
});

describe("session jwt", () => {
  it("round-trips a signed session for the email", async () => {
    resetSigningKey();
    process.env.AUTH_JWT_SECRET = "test-secret-please-ignore";
    resetSigningKey();
    const token = await signSession("a@b.com", 3600);
    assert.equal(await verifySession(token), "a@b.com");
    delete process.env.AUTH_JWT_SECRET;
    resetSigningKey();
  });

  it("rejects a tampered / empty token", async () => {
    assert.equal(await verifySession(undefined), undefined);
    assert.equal(await verifySession("not.a.jwt"), undefined);
  });
});
