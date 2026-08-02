import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { async as asyncModule, brand } from "@dbx-tools/shared-core";
import { looksLikeEmail, matchesAllowlist } from "../src/allowlist.ts";
import { expiresIn } from "../src/app.ts";
import {
  ALLOW_ENV,
  BRAND_NAME_ENV,
  CODE_TTL_ENV,
  SESSION_CUTOFF_ENV,
  SUBJECT_ENV,
} from "../src/env.ts";
import { CodeStore, signSession, verifySession } from "../src/otp.ts";
import { resolveAuthGateConfig } from "../src/plugin.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import { KEY_TTL_SECONDS, resetSigningKey, resolveSessionCutoff } from "../src/signing-key.ts";

describe("allowlist", () => {
  it("matches domain shortcut, glob, and /regex/; empty = nobody", () => {
    assert.equal(matchesAllowlist("a@example.com", ["example.com"]), true);
    assert.equal(matchesAllowlist("a@example.com", ["@example.com"]), true);
    assert.equal(matchesAllowlist("bot@ci.example.com", ["*.example.com"]), true);
    assert.equal(matchesAllowlist("Ada@Example.com", ["/@example\\.com$/"]), true);
    assert.equal(matchesAllowlist("x@evil.com", ["example.com"]), false);
    assert.equal(matchesAllowlist("a@example.com", []), false);
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

/**
 * The signing key decides whether an already-issued COOKIE still verifies, so the
 * property under test is survival across a RESTART. `resetSigningKey()` is that
 * restart: it drops the per-process memo while the cache (which in a real
 * deployment is Lakebase-backed) keeps the key.
 */
describe("cache-backed signing key", () => {
  before(async () => {
    await CacheManager.getInstance();
    delete process.env.TUNNEL_AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    delete process.env.TUNNEL_AUTH_SESSION_CUTOFF;
    resetSigningKey();
  });

  it("keeps a session valid across a restart, with no configured secret", async () => {
    const token = await signSession("persist@b.com", 3600);
    assert.equal(await verifySession(token), "persist@b.com");

    // The restart: nothing memoized, key re-read from the cache.
    resetSigningKey();
    assert.equal(
      await verifySession(token),
      "persist@b.com",
      "a cookie must outlive the process that signed it",
    );
  });

  it("stores the key for 30 days, matching the default session lifetime", () => {
    assert.equal(KEY_TTL_SECONDS, 30 * 24 * 60 * 60);
    // A key that expired before the cookies it signed would log everyone out for
    // no reason, so these two are deliberately equal.
    assert.equal(resolveAuthGateConfig({}).sessionTtlSeconds, KEY_TTL_SECONDS);
  });

  it("re-reads after writing, so racing instances converge on one key", async () => {
    // Two "instances" resolving from the same cache must agree: the second boot
    // adopts the STORED key rather than the one it generated itself.
    const first = await signSession("race@b.com", 3600);
    resetSigningKey();
    const second = await signSession("race@b.com", 3600);
    assert.equal(await verifySession(first), "race@b.com");
    assert.equal(await verifySession(second), "race@b.com");
  });

  it("an explicit secret wins over the cached key", async () => {
    process.env.TUNNEL_AUTH_JWT_SECRET = "operator-held-secret";
    resetSigningKey();
    const token = await signSession("env@b.com", 3600);
    assert.equal(await verifySession(token), "env@b.com");

    // Dropping the secret falls back to the cached key, which did NOT sign this
    // token - so it must no longer verify.
    delete process.env.TUNNEL_AUTH_JWT_SECRET;
    resetSigningKey();
    assert.equal(await verifySession(token), undefined);
  });
});

describe("session force-clear cutoff", () => {
  before(async () => {
    await CacheManager.getInstance();
    delete process.env.TUNNEL_AUTH_SESSION_CUTOFF;
    resetSigningKey();
  });

  it("accepts a date, an ISO instant, epoch seconds/millis, and a relative duration", () => {
    assert.equal(resolveSessionCutoff("2026-08-02"), Date.parse("2026-08-02"));
    assert.equal(
      resolveSessionCutoff("2026-08-02T12:00:00.000Z"),
      Date.parse("2026-08-02T12:00:00.000Z"),
    );
    // `date +%s` output. Seconds must not be read as a YEAR, which is what
    // `Date.parse` would do with a bare number.
    assert.equal(resolveSessionCutoff("1785697899"), 1785697899000);
    assert.equal(resolveSessionCutoff("1785697899000"), 1785697899000);
    assert.equal(resolveSessionCutoff(new Date(1785697899000)), 1785697899000);
    // The spelling an operator actually reaches for: sign out anyone whose
    // session predates a window, without computing a timestamp.
    const week = resolveSessionCutoff("-7d");
    assert.ok(Math.abs(week - (Date.now() - 604_800_000)) < 5_000, "-7d is now minus a week");
    assert.equal(
      Math.round(resolveSessionCutoff("2 weeks ago") / 1000),
      Math.round((Date.now() - 1_209_600_000) / 1000),
    );
  });

  it("treats unset / unparseable as no cutoff rather than throwing", () => {
    // This is the switch that logs a fleet back in; a typo must not stop boot.
    assert.equal(resolveSessionCutoff(undefined), 0);
    assert.equal(resolveSessionCutoff(""), 0);
    assert.equal(resolveSessionCutoff("not-a-date"), 0);
  });

  it("refuses a session issued before the cutoff, and accepts one issued after", async () => {
    // Signed a couple of seconds "ago" so the cutoff below can land strictly
    // after it - `iat` is second-granular, so a same-second token is kept.
    const token = await signSession("cutoff@b.com", 3600);
    assert.equal(await verifySession(token), "cutoff@b.com");

    await asyncModule.sleep(1100);
    process.env.TUNNEL_AUTH_SESSION_CUTOFF = String(Date.now());
    resetSigningKey();
    assert.equal(await verifySession(token), undefined, "a pre-cutoff cookie is dead");

    // A session minted under the new cutoff still works - the switch clears the
    // outstanding sessions, it does not lock the app.
    const fresh = await signSession("cutoff@b.com", 3600);
    assert.equal(await verifySession(fresh), "cutoff@b.com");

    delete process.env.TUNNEL_AUTH_SESSION_CUTOFF;
    resetSigningKey();
  });

  it("clamps a FUTURE cutoff to now, so a mistyped year can't lock everyone out", async () => {
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const resolved = resolveSessionCutoff(future);
    assert.ok(resolved < future.getTime(), "not taken at face value");
    assert.ok(Math.abs(resolved - Date.now()) < 5_000, "held at now");

    // The real hazard: with an unclamped future cutoff a FRESH sign-in would also
    // be refused, leaving no way back in.
    process.env.TUNNEL_AUTH_SESSION_CUTOFF = future.toISOString();
    resetSigningKey();
    const fresh = await signSession("future@b.com", 3600);
    assert.equal(await verifySession(fresh), "future@b.com");
    delete process.env.TUNNEL_AUTH_SESSION_CUTOFF;
    resetSigningKey();
  });

  it("scopes the cached key by cutoff, so moving it orphans the previous key", async () => {
    const before = await signSession("orphan@b.com", 3600);
    process.env.TUNNEL_AUTH_SESSION_CUTOFF = "2026-08-02";
    resetSigningKey();
    // A different cache key entirely, so this is a different signing key - the
    // old cookie cannot verify even ignoring the `iat` check.
    assert.equal(await verifySession(before), undefined);
    delete process.env.TUNNEL_AUTH_SESSION_CUTOFF;
    resetSigningKey();
  });
});

describe("public domain for AutoFill", () => {
  it("resolves the public domain so the code email can bind to this host", () => {
    assert.equal(
      resolveAuthGateConfig({ publicDomain: "demo.apps.dbx.tools" }).publicDomain,
      "demo.apps.dbx.tools",
    );
  });

  it("reads it from the tunnel's own env var, including the deprecated spelling", () => {
    const original = process.env.TUNNEL_PUBLIC_DOMAIN;
    process.env.TUNNEL_PUBLIC_DOMAIN = "gate.example.com";
    try {
      assert.equal(resolveAuthGateConfig({}).publicDomain, "gate.example.com");
    } finally {
      if (original === undefined) delete process.env.TUNNEL_PUBLIC_DOMAIN;
      else process.env.TUNNEL_PUBLIC_DOMAIN = original;
    }
  });

  it("stays absent when no domain is configured, so no unmatched trailer is sent", () => {
    assert.equal(resolveAuthGateConfig({}).publicDomain, undefined);
  });
});

describe("gate config", () => {
  // The name a recipient reads in the code email must come from the shared brand
  // context, not a hardcoded product string, so a themed app's sign-in mail
  // matches the app. Pinned because the old default was the literal "This app".
  it("defaults brandName to the brand context name", () => {
    const resolved = resolveAuthGateConfig({});
    assert.equal(resolved.brandName, brand.defaultBrandContext.name);
    assert.notEqual(resolved.brandName, "This app");
  });

  it("lets an explicit brandName override the brand context", () => {
    assert.equal(resolveAuthGateConfig({ brandName: "Acme Ops" }).brandName, "Acme Ops");
  });

  // The subject/message wording is a COMPATIBILITY contract, not a style choice:
  // iOS, Gmail, Outlook, and Android detect a one-time code from the conventional
  // "verification code" phrasing and offer to autofill it. Pinned so a later
  // copy edit toward something branded ("Your dbx tools passcode") has to be
  // deliberate.
  it("uses the conventional verification-code wording", () => {
    const resolved = resolveAuthGateConfig({});
    assert.equal(resolved.subject, "Your verification code");
    assert.equal(resolved.message, "Your verification code is:");
  });
});

describe("code expiry copy", () => {
  it("states whole minutes as minutes", () => {
    assert.equal(expiresIn(600), "10 minutes");
    assert.equal(expiresIn(60), "1 minute");
  });

  // Never round UP: telling a recipient "1 minute" for a 90-second code would be
  // wrong in the direction that matters, so a non-whole minute stays in seconds.
  it("keeps a partial minute in seconds rather than rounding", () => {
    assert.equal(expiresIn(90), "90 seconds");
    assert.equal(expiresIn(45), "45 seconds");
    assert.equal(expiresIn(1), "1 second");
  });
});

describe("env var names", () => {
  /** Set a var for one assertion, restoring whatever was there. */
  function withEnv(name: string, value: string, body: () => void): void {
    const original = process.env[name];
    process.env[name] = value;
    try {
      body();
    } finally {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  }

  it("reads the current TUNNEL_-prefixed names", () => {
    withEnv("TUNNEL_AUTH_SUBJECT", "Current name", () => {
      assert.equal(resolveAuthGateConfig({}).subject, "Current name");
    });
    withEnv("TUNNEL_AUTH_ALLOW", "example.com", () => {
      assert.deepEqual(resolveAuthGateConfig({}).allow, ["example.com"]);
    });
    withEnv("TUNNEL_AUTH_CODE_TTL", "120", () => {
      assert.equal(resolveAuthGateConfig({}).codeTtlSeconds, 120);
    });
  });

  it("still honours the deprecated unprefixed names, so a deployment keeps working", () => {
    withEnv("AUTH_SUBJECT", "Legacy name", () => {
      assert.equal(resolveAuthGateConfig({}).subject, "Legacy name");
    });
    withEnv("EMAIL_AUTH_ALLOW", "legacy.example", () => {
      assert.deepEqual(resolveAuthGateConfig({}).allow, ["legacy.example"]);
    });
    // Shipped under the "epoch" spelling before the cutoff rename.
    withEnv("TUNNEL_AUTH_SESSION_EPOCH", "1785697899", () => {
      assert.equal(resolveSessionCutoff(), 1785697899000);
    });
  });

  it("prefers the current name when both are set", () => {
    withEnv("AUTH_BRAND_NAME", "Legacy", () => {
      withEnv("TUNNEL_AUTH_BRAND_NAME", "Current", () => {
        assert.equal(resolveAuthGateConfig({}).brandName, "Current");
      });
    });
  });

  it("lists the current name first in every alias list", () => {
    // `env.*` is earliest-wins, so ordering IS the deprecation policy.
    for (const keys of [ALLOW_ENV, SUBJECT_ENV, BRAND_NAME_ENV, CODE_TTL_ENV, SESSION_CUTOFF_ENV]) {
      assert.ok(Array.isArray(keys));
      assert.match(keys[0]!, /^TUNNEL_/);
    }
  });
});
