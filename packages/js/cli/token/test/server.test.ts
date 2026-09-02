import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createClientToken } from "../src/auth.ts";
import { TokenBroker } from "../src/broker.ts";
import { requestAccessToken } from "../src/client.ts";
import { resolveTokenConfig } from "../src/config.ts";
import type { TokenProvider } from "../src/provider.ts";
import { startTokenServer } from "../src/server.ts";
import { ensureBrokerTls, ensureClientTls } from "../src/tls.ts";
import { memorySecretStore } from "./support/memory-secrets.ts";

describe("mTLS token server", () => {
  let directory: string;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "dbx-token-server-"));
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("requires a matching signed client and returns a scope-keyed token", async () => {
    const secret = "test-signing-secret-at-least-thirty-two-characters";
    const port = await availablePort();
    const config = resolveTokenConfig({
      port,
      auth: "jwt",
      signingSecret: secret,
      tls: "mtls",
      stateDir: directory,
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
    const secrets = memorySecretStore();
    const brokerTls = await ensureBrokerTls(directory, config.bind, secrets);
    const clientTls = await ensureClientTls(directory, "container-client", secrets);
    const clientToken = await createClientToken({
      secret,
      client: "container-client",
      providers: ["google"],
      scopes: ["scope:a"],
      ttlSeconds: 60,
    });
    const server = await startTokenServer(broker, config, config.bind, brokerTls);

    try {
      assert.equal(
        await requestAccessToken({
          url: `https://127.0.0.1:${port}`,
          provider: "google",
          scopes: ["scope:a"],
          auth: "jwt",
          clientToken,
          tls: clientTls,
        }),
        "google:scope:a",
      );
      await assert.rejects(
        () =>
          requestAccessToken({
            url: `https://127.0.0.1:${port}`,
            provider: "google",
            scopes: ["scope:a"],
            auth: "jwt",
            clientToken: "invalid",
            tls: clientTls,
          }),
        /Invalid client bearer token/,
      );
    } finally {
      await server.close();
    }
  });

  it("uses plaintext HTTP with no TLS material when auth is none", async () => {
    const port = await availablePort();
    const config = resolveTokenConfig({
      port,
      auth: "none",
      tls: "mtls",
      stateDir: directory,
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
      assert.equal(config.tls, "none");
      assert.equal(
        await requestAccessToken({
          url: `http://127.0.0.1:${port}`,
          provider: "google",
          scopes: ["scope:a"],
          auth: "none",
        }),
        "plain-http-token",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects plaintext credentials on non-loopback binds", async () => {
    const config = resolveTokenConfig({
      auth: "jwt",
      tls: "none",
      signingSecret: "test-signing-secret-at-least-thirty-two-characters",
    });
    const broker = new TokenBroker({
      providers: [],
      defaultProvider: "google",
      defaultScopes: [],
      allowedScopes: [],
      refreshSkewSeconds: 300,
    });

    await assert.rejects(
      () => startTokenServer(broker, config, ["192.168.1.10"]),
      /Plain HTTP.*loopback/,
    );
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
