import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { CacheManager } from "@databricks/appkit";
import { brand } from "@dbx-tools/shared-core";

import { looksLikeEmail, matchesAllowlist } from "../src/allowlist.ts";
import {
  codeEmailHtmlBody,
  codeEmailPreview,
  codeEmailSubject,
  codeEmailTextBody,
  expiresIn,
} from "../src/code-email.ts";
import { resolveAuthGateConfig } from "../src/plugin.ts";
import { KEY_TTL_SECONDS, resetSigningKey, signingKey } from "../src/signing-key.ts";

describe("allowlist", () => {
  it("matches domain shortcut, glob, and regex patterns", () => {
    assert.equal(matchesAllowlist("a@example.com", ["example.com"]), true);
    assert.equal(matchesAllowlist("a@example.com", ["@example.com"]), true);
    assert.equal(matchesAllowlist("bot@ci.example.com", ["*.example.com"]), true);
    assert.equal(matchesAllowlist("Ada@Example.com", ["/@example\\.com$/"]), true);
    assert.equal(matchesAllowlist("x@evil.com", ["example.com"]), false);
    assert.equal(matchesAllowlist("a@example.com", []), false);
    assert.equal(looksLikeEmail("a@b.com"), true);
    assert.equal(looksLikeEmail("nope"), false);
  });
});

describe("cache-backed Better Auth secret", () => {
  before(async () => {
    await CacheManager.getInstance();
    delete process.env.TUNNEL_AUTH_JWT_SECRET;
    delete process.env.AUTH_JWT_SECRET;
    resetSigningKey();
  });

  it("survives a process restart through AppKit cache", async () => {
    const first = (await signingKey()).key;
    resetSigningKey();
    const second = (await signingKey()).key;
    assert.deepEqual(first, second);
    assert.equal(KEY_TTL_SECONDS, 30 * 24 * 60 * 60);
  });
});

describe("gate config and email copy", () => {
  it("uses shared brand and conventional OTP wording", () => {
    const resolved = resolveAuthGateConfig({});
    assert.equal(resolved.brandName, brand.defaultBrandContext.name);
    assert.equal(resolved.subject, "Your verification code");
    assert.equal(resolved.message, "Your verification code is:");
    assert.equal(resolved.sessionTtlSeconds, KEY_TTL_SECONDS);
    assert.equal(resolved.logoutRedirectPath, "/");
  });

  it("accepts only same-origin logout redirect paths", () => {
    assert.equal(
      resolveAuthGateConfig({ logoutRedirectPath: "/signed-out" }).logoutRedirectPath,
      "/signed-out",
    );
    assert.equal(
      resolveAuthGateConfig({ logoutRedirectPath: "https://example.com" }).logoutRedirectPath,
      "/",
    );
    assert.equal(
      resolveAuthGateConfig({ logoutRedirectPath: "//example.com" }).logoutRedirectPath,
      "/",
    );
  });

  it("keeps code copy recognizable and expiry accurate", () => {
    assert.equal(expiresIn(600), "10 minutes");
    assert.equal(expiresIn(90), "90 seconds");
    assert.match(codeEmailSubject("123456", "Your verification code"), /123456/);
    assert.match(codeEmailPreview("123456", "Acme"), /123456/);
    const copy = { message: "Code:", codeTtlSeconds: 600 };
    assert.match(codeEmailTextBody("123456", copy), /10 minutes/);
    assert.match(codeEmailHtmlBody("123456", copy), /123456/);
  });
});
