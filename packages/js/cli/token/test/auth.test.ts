import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeProtectedHeader } from "jose";

import {
  AuthorizationError,
  authorizeClient,
  clientCredentialMode,
  createClientToken,
} from "../src/auth.ts";

describe("client authorization", () => {
  it("authenticates a password without exposing it in the result", async () => {
    const password = "correct horse battery staple";
    const authorization = `Basic ${Buffer.from(`client:${password}`).toString("base64")}`;

    assert.deepEqual(
      await authorizeClient({
        mode: "password",
        authorization,
        secret: password,
      }),
      { client: "password", providers: ["google"] },
    );
    await assert.rejects(
      () => authorizeClient({ mode: "password", authorization, secret: "wrong" }),
      AuthorizationError,
    );
  });

  it("signs and verifies constrained JWTs", async () => {
    const secret = "test-signing-secret-at-least-thirty-two-characters";
    const token = await createClientToken({
      secret,
      client: "container-client",
      providers: ["google"],
      scopes: ["scope:a"],
      ttlSeconds: 60,
    });

    assert.deepEqual(
      await authorizeClient({
        mode: "jwt",
        authorization: `Bearer ${token}`,
        secret,
      }),
      { client: "container-client", providers: ["google"], scopes: ["scope:a"] },
    );
    assert.equal(decodeProtectedHeader(token).name, "container-client");
    assert.equal(clientCredentialMode(token), "jwt");
    assert.equal(clientCredentialMode("shared.password.with.dots"), "password");
    assert.equal(clientCredentialMode("not-a-token"), "password");
  });

  it("represents an empty JWT scope claim as no explicit scope permission", async () => {
    const secret = "test-signing-secret-at-least-thirty-two-characters";
    const token = await createClientToken({
      secret,
      client: "default-scope-client",
      providers: ["google"],
      scopes: [],
      ttlSeconds: 60,
    });

    assert.deepEqual(
      await authorizeClient({
        mode: "jwt",
        authorization: `Bearer ${token}`,
        secret,
      }),
      { client: "default-scope-client", providers: ["google"], scopes: [] },
    );
  });
});
