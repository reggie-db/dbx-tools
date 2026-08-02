import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { brand } from "@dbx-tools/shared-core";
import { looksLikeEmail, matchesAllowlist } from "../src/allowlist.ts";
import { expiresIn } from "../src/app.ts";
import { ALLOW_ENV, BRAND_NAME_ENV, CODE_TTL_ENV, SUBJECT_ENV } from "../src/env.ts";
import { CodeStore, resetSigningKey, signSession, verifySession } from "../src/otp.ts";
import { resolveAuthGateConfig } from "../src/plugin.ts";
import { RateLimiter } from "../src/rate-limit.ts";

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
    for (const keys of [ALLOW_ENV, SUBJECT_ENV, BRAND_NAME_ENV, CODE_TTL_ENV]) {
      assert.ok(Array.isArray(keys));
      assert.match(keys[0]!, /^TUNNEL_/);
    }
  });
});
