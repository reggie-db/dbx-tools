import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AuthorizationError, authorizeClient, createClientToken } from "../src/auth.ts";

describe("client authorization", () => {
  it("authenticates a password without exposing it in the result", async () => {
    const password = "correct horse battery staple";
    const authorization = `Basic ${Buffer.from(`client:${password}`).toString("base64")}`;

    assert.deepEqual(
      await authorizeClient({
        mode: "password",
        authorization,
        password,
        certificateName: "container-client",
      }),
      { client: "container-client", providers: ["google"] },
    );
    await assert.rejects(
      () => authorizeClient({ mode: "password", authorization, password: "wrong" }),
      AuthorizationError,
    );
  });

  it("signs constrained JWTs and binds them to the mTLS client name", async () => {
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
        signingSecret: secret,
        certificateName: "container-client",
      }),
      { client: "container-client", providers: ["google"], scopes: ["scope:a"] },
    );
    await assert.rejects(
      () =>
        authorizeClient({
          mode: "jwt",
          authorization: `Bearer ${token}`,
          signingSecret: secret,
          certificateName: "different-client",
        }),
      /does not match/,
    );
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
        signingSecret: secret,
      }),
      { client: "default-scope-client", providers: ["google"], scopes: [] },
    );
  });
});
