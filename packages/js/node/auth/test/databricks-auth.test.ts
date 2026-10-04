import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { createPersistentAuth } from "../src/databricks-auth.ts";
import { DatabricksClient } from "../src/http-client.ts";
import { DatabricksAuthOptions, Storage } from "../src/types.ts";

const APP_ENV = { DBX_TOOLS_DATABRICKS_APP_ENV: "true" };

describe("Databricks provider construction", () => {
  it("returns authorization and workspace headers for App OBO", async () => {
    const options = DatabricksAuthOptions.create({
      host: "https://example.cloud.databricks.com",
      workspaceId: "workspace-id",
      requestHeaders: { Authorization: "Bearer request-token" },
    });
    const auth = await createPersistentAuth(options, Storage.Memory, { environment: APP_ENV });

    assert.deepEqual(await auth.authenticate(false), {
      authorization: "Bearer request-token",
      "x-databricks-workspace-id": "workspace-id",
    });
    assert.deepEqual(
      await auth.requestHeadersForUrl(
        "https://example.cloud.databricks.com/api/2.0/clusters/list",
        false,
      ),
      {
        authorization: "Bearer request-token",
        "x-databricks-workspace-id": "workspace-id",
      },
    );
    assert.deepEqual(await auth.requestHeadersForUrl("https://example.com", false), {});

    let outboundHeaders: Headers | undefined;
    const client = await DatabricksClient.create(options, {
      environment: APP_ENV,
      fetch: async (_input, init) => {
        outboundHeaders = new Headers(init?.headers);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.request("/api/2.0/clusters/list", { login: false });
    assert.equal(outboundHeaders?.get("authorization"), "Bearer request-token");
    assert.equal(outboundHeaders?.get("x-databricks-workspace-id"), "workspace-id");
  });

  it("uses the CLI for automatic U2M with any storage", async () => {
    const auth = await createPersistentAuth(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      }),
      Storage.Memory,
      { environment: {}, resolveCli: () => Promise.resolve("databricks") },
    );
    assert.equal(auth.status().profile, "TEST");
    assert.equal(auth.status().storage, Storage.Memory);
  });

  it("treats oauth-u2m as CLI authentication", async () => {
    let resolvedCli = false;
    await createPersistentAuth(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
        authType: "oauth-u2m",
      }),
      Storage.Memory,
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve("databricks");
        },
      },
    );
    assert.equal(resolvedCli, true);
  });

  it("does not invoke the CLI inside a Databricks App", async () => {
    let resolvedCli = false;
    await assert.rejects(
      createPersistentAuth(
        DatabricksAuthOptions.create({
          host: "https://example.cloud.databricks.com",
          profile: "TEST",
        }),
        Storage.Memory,
        {
          environment: APP_ENV,
          resolveCli: () => {
            resolvedCli = true;
            return Promise.resolve("databricks");
          },
        },
      ),
      /Databricks Apps use app_obo request headers or app_sp environment credentials/,
    );
    assert.equal(resolvedCli, false);
  });

  it("fails closed when no compatible CLI can be resolved", async () => {
    await assert.rejects(
      createPersistentAuth(
        DatabricksAuthOptions.create({
          host: "https://example.cloud.databricks.com",
          profile: "TEST",
        }),
        Storage.Memory,
        { environment: {}, resolveCli: () => Promise.resolve(undefined) },
      ),
      /Databricks CLI is unavailable/,
    );
  });

  it("uses client credentials when the CLI cannot expose an M2M token", async () => {
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

  it("uses App environment service-principal credentials without the CLI", async () => {
    let resolvedCli = false;
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          access_token: "app-token",
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
          host: `http://127.0.0.1:${address.port}`,
          accountId: "account-id",
          target: "account",
        }),
        Storage.Memory,
        {
          environment: {
            ...APP_ENV,
            DATABRICKS_HOST: `http://127.0.0.1:${address.port}`,
            DATABRICKS_CLIENT_ID: "app-id",
            DATABRICKS_CLIENT_SECRET: "app-secret",
          },
          resolveCli: () => {
            resolvedCli = true;
            return Promise.resolve("databricks");
          },
        },
      );
      assert.equal((await auth.token(false)).accessToken, "app-token");
      assert.equal(resolvedCli, false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
