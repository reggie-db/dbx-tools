import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import { createClientToken } from "../src/auth.ts";
import { TokenBroker } from "../src/broker.ts";
import { requestAccessToken } from "../src/client.ts";
import { resolveTokenConfig } from "../src/config.ts";
import type { TokenProvider } from "../src/provider.ts";
import { startTokenServer } from "../src/server.ts";

describe("authenticated token server", () => {
  it("authenticates a signed client JWT and returns a scope-keyed token", async () => {
    const port = await availablePort();
    const secret = "test-signing-secret-at-least-thirty-two-characters";
    const config = resolveTokenConfig({
      port,
      auth: "jwt",
      secret,
      scopes: ["scope:a"],
      allowedScopes: ["scope:a"],
    });
    const provider: TokenProvider = {
      name: "google",
      acquire: async (scopes) => ({
        accessToken: `google:${scopes.join(",")}`,
        tokenType: "Bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: [...scopes],
      }),
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: config.scopes,
      allowedScopes: config.allowedScopes,
      refreshSkewSeconds: config.refreshSkewSeconds,
    });
    const credential = await createClientToken({
      secret,
      client: "container-client",
      providers: ["google"],
      scopes: [],
      ttlSeconds: 60,
    });
    const server = await startTokenServer(broker, config, config.bind);

    try {
      assert.equal(
        await requestAccessToken({
          url: `http://127.0.0.1:${port}`,
          provider: "google",
          scopes: ["scope:a"],
          auth: "jwt",
          credential,
        }),
        "google:scope:a",
      );
      await assert.rejects(
        () =>
          requestAccessToken({
            url: `http://127.0.0.1:${port}`,
            provider: "google",
            scopes: ["scope:a"],
            auth: "jwt",
            credential: "invalid",
          }),
        /Invalid client bearer token/,
      );
    } finally {
      await server.close();
    }
  });

  it("authenticates the shared password", async () => {
    const port = await availablePort();
    const config = resolveTokenConfig({
      port,
      auth: "password",
      secret: "shared-password",
      scopes: ["scope:a"],
      allowedScopes: ["scope:a"],
    });
    const provider: TokenProvider = {
      name: "google",
      acquire: async (scopes) => ({
        accessToken: "plain-http-token",
        tokenType: "Bearer",
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: [...scopes],
      }),
    };
    const broker = new TokenBroker({
      providers: [provider],
      defaultProvider: "google",
      defaultScopes: config.scopes,
      allowedScopes: config.allowedScopes,
      refreshSkewSeconds: config.refreshSkewSeconds,
    });
    const server = await startTokenServer(broker, config, config.bind);

    try {
      assert.equal(
        await requestAccessToken({
          url: `http://127.0.0.1:${port}`,
          provider: "google",
          scopes: ["scope:a"],
          auth: "password",
          credential: "shared-password",
        }),
        "plain-http-token",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects wildcard binds", async () => {
    const config = resolveTokenConfig({
      auth: "jwt",
      secret: "test-signing-secret-at-least-thirty-two-characters",
    });
    const broker = new TokenBroker({
      providers: [],
      defaultProvider: "google",
      defaultScopes: [],
      allowedScopes: [],
      refreshSkewSeconds: 300,
    });

    await assert.rejects(() => startTokenServer(broker, config, ["0.0.0.0"]), /wildcard binds/);
  });
});

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a test port"));
        return;
      }
      server.close((cause) => (cause ? reject(cause) : resolve(address.port)));
    });
  });
}
