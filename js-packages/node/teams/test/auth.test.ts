import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";
import { connectorToken, resetTeamsAuth, verifyBotToken } from "../src/auth.ts";

/**
 * Inbound-token verification, exercised against a LOCAL key set.
 *
 * A real Bot Service token can't be minted in a test, so these serve a JWKS from
 * localhost and point the verifier at it with `metadataUrl`. That keeps the code
 * path identical to production - discover metadata, load keys, verify signature,
 * then check issuer and audience - while letting the test control the claims,
 * which is the only way to prove the claim checks actually gate a request rather
 * than the signature alone.
 */
describe("teams inbound token verification", () => {
  let server: Server;
  let metadataUrl: string;
  let privateKey: CryptoKey;

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
    server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      const port = (server.address() as { port: number }).port;
      if (req.url?.includes("openidconfiguration")) {
        res.end(JSON.stringify({ jwks_uri: `http://127.0.0.1:${port}/keys` }));
        return;
      }
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    metadataUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/openidconfiguration`;
  });

  after(() => server.close());

  /** Sign a token with the local test key. */
  const token = (claims: Record<string, unknown>) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  /** Verify `claims` as this bot (`my-app`), against the local key set. */
  const verify = async (claims: Record<string, unknown>) => {
    // The key set is cached per metadata URL; clear it so each case starts cold.
    resetTeamsAuth();
    return verifyBotToken(`Bearer ${await token(claims)}`, { appId: "my-app", metadataUrl });
  };

  it("accepts a token signed for this bot by a trusted issuer", async () => {
    const verified = await verify({
      aud: "my-app",
      iss: "https://api.botframework.com",
      serviceurl: "https://smba.trafficmanager.net/amer/",
    });
    assert.equal(verified.claims.aud, "my-app");
    // The `serviceurl` claim is what the reply destination is pinned to.
    assert.equal(verified.serviceUrl, "https://smba.trafficmanager.net/amer/");
  });

  // The single most important case. A token issued for a DIFFERENT bot is signed
  // by the same Bot Service keys and so passes signature validation; only the
  // audience check stops someone driving this agent with their own bot's token.
  it("rejects a validly signed token issued for another bot", async () => {
    await assert.rejects(
      verify({ aud: "someone-elses-app", iss: "https://api.botframework.com" }),
      /aud/i,
    );
  });

  it("rejects a token from an untrusted issuer", async () => {
    await assert.rejects(
      verify({ aud: "my-app", iss: "https://evil.example.com" }),
      /untrusted token issuer/,
    );
  });

  it("rejects an expired token", async () => {
    resetTeamsAuth();
    const expired = await new SignJWT({ aud: "my-app", iss: "https://api.botframework.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);
    await assert.rejects(
      verifyBotToken(`Bearer ${expired}`, { appId: "my-app", metadataUrl }),
      /exp/i,
    );
  });

  it("accepts the configured tenant's own issuer for a single-tenant bot", async () => {
    resetTeamsAuth();
    const signed = await token({
      aud: "my-app",
      iss: "https://login.microsoftonline.com/tenant-1/v2.0",
    });
    const verified = await verifyBotToken(`Bearer ${signed}`, {
      appId: "my-app",
      appTenantId: "tenant-1",
      metadataUrl,
    });
    assert.equal(verified.claims.iss, "https://login.microsoftonline.com/tenant-1/v2.0");
  });

  it("still rejects a different tenant's issuer", async () => {
    resetTeamsAuth();
    const signed = await token({
      aud: "my-app",
      iss: "https://login.microsoftonline.com/other-tenant/v2.0",
    });
    await assert.rejects(
      verifyBotToken(`Bearer ${signed}`, {
        appId: "my-app",
        appTenantId: "tenant-1",
        metadataUrl,
      }),
      /untrusted token issuer/,
    );
  });

  it("rejects a request with no or malformed authorization header", async () => {
    for (const header of [undefined, "", "Basic abc", "Bearer", "Bearer not.a.jwt"]) {
      await assert.rejects(
        verifyBotToken(header, { appId: "my-app", metadataUrl }),
        (err: Error) => err instanceof Error,
        `expected '${header ?? "undefined"}' to be rejected`,
      );
    }
  });
});

describe("teams connector token cache", () => {
  it("keeps tokens isolated by tenant and app id", async () => {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (_input, init) => {
      requests += 1;
      const body = init?.body as URLSearchParams;
      return new Response(
        JSON.stringify({
          access_token: `${body.get("client_id")}:${requests}`,
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    resetTeamsAuth();
    try {
      const appOne = await Promise.all([
        connectorToken({ appId: "app-one", appPassword: "secret" }),
        connectorToken({ appId: "app-one", appPassword: "secret" }),
      ]);
      assert.deepEqual(appOne, ["app-one:1", "app-one:1"]);
      assert.equal(await connectorToken({ appId: "app-two", appPassword: "secret" }), "app-two:2");
      assert.equal(await connectorToken({ appId: "app-one", appPassword: "secret" }), "app-one:1");
      assert.equal(requests, 2);
    } finally {
      globalThis.fetch = originalFetch;
      resetTeamsAuth();
    }
  });
});
