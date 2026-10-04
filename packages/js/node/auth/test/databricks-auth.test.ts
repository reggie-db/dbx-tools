import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { createPersistentAuth } from "../src/databricks-auth.ts";
import { DatabricksAuthOptions, Storage } from "../src/types.ts";

describe("Databricks provider construction", () => {
  it("prefers the installed CLI in automatic storage mode", async () => {
    const auth = await createPersistentAuth(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      }),
      Storage.Auto,
      {
        environment: {},
        cliAvailable: () => true,
        fetch: async () => {
          throw new Error("native OAuth discovery should not run");
        },
      },
    );
    assert.equal(auth.status().profile, "TEST");
    assert.equal(auth.status().storage, Storage.File);
  });

  it("uses oauth4webapi for Databricks M2M client credentials", async () => {
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url ?? "");
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.match(request.headers.authorization ?? "", /^Basic /);
      assert.match(body, /grant_type=client_credentials/);
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          access_token: "m2m-token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "all-apis",
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture did not bind");
    try {
      const auth = await createPersistentAuth(
        DatabricksAuthOptions.create({
          profile: "SERVICE",
          host: `http://127.0.0.1:${address.port}`,
          accountId: "account-id",
          target: "account",
          authType: "oauth-m2m",
          clientId: "client-id",
          clientSecret: "client-secret",
        }),
        Storage.Memory,
        { environment: {} },
      );
      const token = await auth.token(false);
      assert.equal(token.accessToken, "m2m-token");
      assert.deepEqual(token.scopes, ["all-apis"]);
      assert.deepEqual(requests, ["/oidc/accounts/account-id/v1/token"]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
