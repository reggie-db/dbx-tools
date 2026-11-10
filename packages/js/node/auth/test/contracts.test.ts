import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publicToken } from "../src/_lifecycle.ts";
import { TokenSchema } from "../src/_types.ts";
import { AccessTokenSchema } from "../src/client.ts";
import {
  AUTH_DEFAULTS,
  AuthOptionsSchema,
  DatabricksAuthOptionsSchema,
  type AuthOptions,
  type DatabricksAuthOptions,
} from "../src/config.ts";

describe("authentication contracts", () => {
  it("derives input options from schemas without requiring defaulted timing fields", () => {
    const auth: AuthOptions = { refreshBufferMs: 0 };
    const options: DatabricksAuthOptions = { auth, profile: "PROFILE" };
    assert.deepEqual(DatabricksAuthOptionsSchema.parse(options), {
      profile: "PROFILE",
      auth: { ...AUTH_DEFAULTS, refreshBufferMs: 0 },
    });
    assert.deepEqual(AuthOptionsSchema.parse({}), AUTH_DEFAULTS);
  });

  it("projects the stored token contract without exposing the refresh token", () => {
    const stored = TokenSchema.parse({
      accessToken: "access",
      tokenType: "Bearer",
      refreshToken: "private-refresh",
      expiry: "2099-01-01T00:00:00Z",
      scopes: ["all-apis"],
    });
    const published = AccessTokenSchema.parse(stored);
    assert.deepEqual(published, publicToken(stored));
    assert.equal("refreshToken" in published, false);
    published.scopes.push("additional");
    assert.deepEqual(stored.scopes, ["all-apis"]);
  });

  it("rejects invalid token fields while allowing providers without an expiry", () => {
    assert.deepEqual(
      AccessTokenSchema.parse({ accessToken: "opaque", tokenType: "Bearer", scopes: [] }),
      { accessToken: "opaque", tokenType: "Bearer", scopes: [] },
    );
    assert.equal(
      AccessTokenSchema.safeParse({ accessToken: "access", tokenType: "Bearer", scopes: [1] })
        .success,
      false,
    );
  });
});
