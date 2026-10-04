import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import * as publicAuth from "../index.ts";
import { createAuthClient } from "../src/databricks-auth.ts";
import { DatabricksClient } from "../src/http-client.ts";
import { AuthKind, DatabricksAuthOptions, Storage, TargetKind } from "../src/types.ts";

const APP_ENV = { DBX_TOOLS_DATABRICKS_APP_ENV: "true" };

describe("Databricks provider construction", () => {
  it("keeps implementation helpers out of the package root", () => {
    for (const name of [
      "configProfileExists",
      "createPersistentAuth",
      "createPersistentAuthWithStorage",
      "listDatabricksProfiles",
      "parseDatabricksConfig",
      "profile",
      "resolveConfigFile",
      "resolveDatabricksProfile",
    ]) {
      assert.equal(name in publicAuth, false, name);
    }
  });

  it("exposes authentication and profile operations through one client", async () => {
    const environment = {
      DATABRICKS_AUTH_TYPE: process.env.DATABRICKS_AUTH_TYPE,
      DATABRICKS_CONFIG_FILE: process.env.DATABRICKS_CONFIG_FILE,
      DATABRICKS_HOST: process.env.DATABRICKS_HOST,
      DATABRICKS_TOKEN: process.env.DATABRICKS_TOKEN,
      DATABRICKS_WORKSPACE_ID: process.env.DATABRICKS_WORKSPACE_ID,
    };
    process.env.DATABRICKS_AUTH_TYPE = "pat";
    process.env.DATABRICKS_CONFIG_FILE = "/tmp/dbx-tools-auth-ambient-test-missing";
    process.env.DATABRICKS_HOST = "https://example.cloud.databricks.com";
    process.env.DATABRICKS_TOKEN = "ambient-token";
    delete process.env.DATABRICKS_WORKSPACE_ID;
    try {
      const auth = await createAuthClient();
      assert.equal((await auth.token(false)).accessToken, "ambient-token");
      assert.deepEqual(await auth.authenticate(false), {
        authorization: "Bearer ambient-token",
      });
      assert.deepEqual(auth.profile(), {
        name: "DEFAULT",
        host: "https://example.cloud.databricks.com",
        target: TargetKind.Workspace,
        authKind: AuthKind.PersonalAccessToken,
      });
      assert.deepEqual(auth.profile("DEFAULT"), auth.profile());
      assert.deepEqual(auth.listProfiles(true), []);
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("returns authorization and workspace headers for App OBO", async () => {
    const options = DatabricksAuthOptions.create({
      host: "https://example.cloud.databricks.com",
      workspaceId: "workspace-id",
      requestHeaders: { Authorization: "Bearer request-token" },
    });
    const auth = await createAuthClient(options, Storage.Memory, { environment: APP_ENV });

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

  it("constructs automatic U2M without resolving the CLI", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      }),
      Storage.Auto,
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve("databricks");
        },
      },
    );
    assert.equal(auth.status().profile, "TEST");
    assert.equal(auth.status().storage, Storage.Memory);
    assert.equal(resolvedCli, false);
  });

  it("defers explicit oauth-u2m CLI resolution until token acquisition", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
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
          return Promise.resolve(undefined);
        },
      },
    );
    assert.equal(resolvedCli, false);
    await assert.rejects(auth.token(false), /Databricks CLI is unavailable/);
    assert.equal(resolvedCli, true);
  });

  it("keeps CLI fallback lazy and non-installing inside a Databricks App", async () => {
    let resolution: { install: boolean } | undefined;
    const auth = await createAuthClient(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
        authType: "oauth-u2m",
      }),
      Storage.Memory,
      {
        environment: APP_ENV,
        resolveCli: (options) => {
          resolution = options;
          return Promise.resolve(undefined);
        },
      },
    );
    assert.equal(resolution, undefined);
    await assert.rejects(auth.token(false), /Databricks CLI is unavailable/);
    assert.deepEqual(resolution, { install: false });
  });

  it("allows explicit CLI installation inside a Databricks App", async () => {
    let resolution: { install: boolean } | undefined;
    const auth = await createAuthClient(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
        authType: "oauth-u2m",
        installCliInApp: true,
      }),
      Storage.Memory,
      {
        environment: APP_ENV,
        resolveCli: (options) => {
          resolution = options;
          return Promise.resolve(undefined);
        },
      },
    );
    await assert.rejects(auth.token(false), /Databricks CLI is unavailable/);
    assert.deepEqual(resolution, { install: true });
  });

  it("fails closed at U2M token acquisition when no compatible CLI can be resolved", async () => {
    const auth = await createAuthClient(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      }),
      Storage.Memory,
      { environment: {}, resolveCli: () => Promise.resolve(undefined) },
    );
    await assert.rejects(auth.token(false), /Databricks CLI is unavailable/);
  });

  it("uses configured PAT credentials without resolving the CLI", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "PAT",
        authType: "pat",
        accessToken: "profile-token",
      }),
      Storage.Memory,
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve(undefined);
        },
      },
    );
    assert.deepEqual(await auth.authenticate(false), {
      authorization: "Bearer profile-token",
    });
    assert.equal(resolvedCli, false);
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
      const auth = await createAuthClient(
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
      const auth = await createAuthClient(
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
