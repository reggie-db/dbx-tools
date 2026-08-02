import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ConfigurationError } from "@databricks/appkit";
import { token } from "@dbx-tools/shared-core";
import {
  ACCESS_TOKEN_HEADER,
  DEFAULT_IDENTITY_MODE,
  IDENTITY_MODES,
  requestAccessToken,
  requestUserEmail,
  requestUserId,
  resolveIdentityMode,
  useServicePrincipal,
} from "../src/identity.ts";

const ENV_KEY = "DBX_TOOLS_TEST_IDENTITY";

/** Minimal Express-ish request carrying only the headers this module reads. */
function req(headers: Record<string, string> = {}): { header(name: string): string | undefined } {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] };
}

describe("identity headers", () => {
  it("re-exports the shared token constants rather than re-spelling them", () => {
    assert.equal(ACCESS_TOKEN_HEADER, token.ACCESS_TOKEN_HEADER);
    assert.equal(ACCESS_TOKEN_HEADER, "x-forwarded-access-token");
  });

  it("reads the forwarded token, user id, and email case-insensitively", () => {
    const request = req({
      "X-Forwarded-Access-Token": "tok",
      "X-Forwarded-User": "u-1",
      "X-Forwarded-Email": "ada@example.com",
    });
    assert.equal(requestAccessToken(request), "tok");
    assert.equal(requestUserId(request), "u-1");
    assert.equal(requestUserEmail(request), "ada@example.com");
  });

  it("treats a blank header as absent, not as an unusable value", () => {
    // Some proxies emit an empty header for an unset upstream value; that must
    // read as "no token" so `auto` falls back instead of failing at the first
    // Databricks call.
    const request = req({ "x-forwarded-access-token": "   ", "x-forwarded-user": "" });
    assert.equal(requestAccessToken(request), undefined);
    assert.equal(requestUserId(request), undefined);
  });

  it("tolerates a missing request", () => {
    assert.equal(requestAccessToken(undefined), undefined);
    assert.equal(requestUserId(undefined), undefined);
    assert.equal(requestUserEmail(undefined), undefined);
  });
});

describe("resolveIdentityMode", () => {
  afterEach(() => delete process.env[ENV_KEY]);

  it("defaults to OBO (`user`) so adopting the option never widens data access", () => {
    assert.equal(resolveIdentityMode(undefined, ENV_KEY), "user");
    assert.equal(DEFAULT_IDENTITY_MODE, "user");
  });

  it("prefers explicit config over the environment", () => {
    process.env[ENV_KEY] = "auto";
    assert.equal(resolveIdentityMode("service-principal", ENV_KEY), "service-principal");
  });

  it("falls back to the environment, trimming and lower-casing", () => {
    process.env[ENV_KEY] = "  Auto ";
    assert.equal(resolveIdentityMode(undefined, ENV_KEY), "auto");
  });

  it("accepts the first non-empty variable when several names are given", () => {
    process.env[ENV_KEY] = "auto";
    assert.equal(resolveIdentityMode(undefined, ["MISSING_KEY", ENV_KEY]), "auto");
  });

  it("throws on an unrecognized value instead of silently defaulting", () => {
    assert.throws(() => resolveIdentityMode("obo", ENV_KEY), ConfigurationError);
    assert.throws(() => resolveIdentityMode("sp", ENV_KEY), ConfigurationError);
  });

  it("names the field and env var in the error, so the fix is obvious", () => {
    assert.throws(
      () => resolveIdentityMode("nope", ENV_KEY, "genieIdentity"),
      (error: ConfigurationError) => {
        assert.match(error.message, /genieIdentity/);
        assert.match(error.message, new RegExp(ENV_KEY));
        assert.match(error.message, /user \| service-principal \| auto/);
        return true;
      },
    );
  });

  it("publishes every mode in documentation order", () => {
    assert.deepEqual([...IDENTITY_MODES], ["user", "service-principal", "auto"]);
  });
});

describe("useServicePrincipal", () => {
  it("never falls back in `user` mode, even with no token", () => {
    // `user` asserts every caller is OBO-capable, so a missing token must surface
    // as AppKit's AuthenticationError rather than quietly sharing data access.
    assert.equal(useServicePrincipal("user", req({ "x-forwarded-access-token": "t" })), false);
    assert.equal(useServicePrincipal("user", req()), false);
    assert.equal(useServicePrincipal("user", undefined), false);
  });

  it("always uses the service principal in `service-principal` mode", () => {
    assert.equal(useServicePrincipal("service-principal", req()), true);
    assert.equal(
      useServicePrincipal("service-principal", req({ "x-forwarded-access-token": "t" })),
      true,
    );
  });

  it("in `auto` mode, uses OBO only when the request carries a usable token", () => {
    assert.equal(useServicePrincipal("auto", req({ "x-forwarded-access-token": "t" })), false);
    assert.equal(useServicePrincipal("auto", req({ "x-forwarded-access-token": " " })), true);
    // A gated tunnel request: identity is known, but no Databricks credential.
    assert.equal(useServicePrincipal("auto", req({ "x-forwarded-user": "ada" })), true);
    assert.equal(useServicePrincipal("auto", req()), true);
    assert.equal(useServicePrincipal("auto", undefined), true);
  });
});
