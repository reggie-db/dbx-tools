import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";

import { AuthType, databricksAuthClientInfoSchema, TargetKind } from "@dbx-tools/shared-auth";
import * as publicAuth from "../index.ts";
import { createAuthClient } from "../src/client.ts";
import type { DatabricksAuthOptions } from "../src/config.ts";

const APP_ENV = { DBX_TOOLS_DATABRICKS_APP_ENV: "true" };

describe("Databricks provider construction", () => {
  it("keeps implementation helpers out of the package root", () => {
    for (const name of [
      "configProfileExists",
      "createPersistentAuth",
      "createPersistentAuthWithStorage",
      "listDatabricksProfiles",
      "parseDatabricksConfig",
      "resolveConfigFile",
      "resolveDatabricksProfile",
    ]) {
      assert.equal(name in publicAuth, false, name);
    }
  });

  it("exposes token and resolved configuration through one client", async () => {
    const environment = {
      DATABRICKS_AUTH_TYPE: process.env.DATABRICKS_AUTH_TYPE,
      DATABRICKS_CONFIG_FILE: process.env.DATABRICKS_CONFIG_FILE,
      DATABRICKS_CONFIG_PROFILE: process.env.DATABRICKS_CONFIG_PROFILE,
      DATABRICKS_HOST: process.env.DATABRICKS_HOST,
      DATABRICKS_TOKEN: process.env.DATABRICKS_TOKEN,
      DATABRICKS_WORKSPACE_ID: process.env.DATABRICKS_WORKSPACE_ID,
    };
    process.env.DATABRICKS_AUTH_TYPE = "pat";
    process.env.DATABRICKS_CONFIG_FILE = "/tmp/dbx-tools-auth-ambient-test-missing";
    delete process.env.DATABRICKS_CONFIG_PROFILE;
    process.env.DATABRICKS_HOST = "https://example.cloud.databricks.com";
    process.env.DATABRICKS_TOKEN = "ambient-token";
    delete process.env.DATABRICKS_WORKSPACE_ID;
    try {
      const auth = await createAuthClient();
      assert.equal((await auth.token({ login: false })).accessToken, "ambient-token");
      assert.deepEqual(await auth.headers({ login: false }), {
        authorization: "Bearer ambient-token",
      });
      const info = databricksAuthClientInfoSchema.parse(auth);
      assert.deepEqual(info, {
        profile: undefined,
        host: "https://example.cloud.databricks.com",
        accountId: undefined,
        workspaceId: undefined,
        target: TargetKind.Workspace,
        authType: AuthType.PersonalAccessToken,
        principal: "ambient",
      });
    } finally {
      for (const [name, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("returns authorization and workspace headers for App OBO", async () => {
    const options: DatabricksAuthOptions = {
      host: "https://example.cloud.databricks.com",
      workspaceId: "workspace-id",
      requestHeaders: { Authorization: "Bearer request-token" },
    };
    const auth = await createAuthClient(options, { environment: APP_ENV });

    assert.deepEqual(await auth.headers({ login: false }), {
      authorization: "Bearer request-token",
      "x-databricks-workspace-id": "workspace-id",
    });
  });

  it("constructs automatic U2M without resolving the CLI", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      {
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      },
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve("databricks");
        },
      },
    );
    assert.equal(auth.profile, "TEST");
    assert.equal(resolvedCli, false);
  });

  it("defers explicit CLI resolution until token acquisition", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      {
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
        authType: AuthType.DatabricksCli,
      },
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve(undefined);
        },
      },
    );
    assert.equal(resolvedCli, false);
    await assert.rejects(auth.token({ login: false }), /Databricks CLI is unavailable/);
    assert.equal(resolvedCli, true);
  });

  it("keeps CLI fallback lazy and non-installing inside a Databricks App", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      {
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
        authType: AuthType.DatabricksCli,
      },
      {
        environment: APP_ENV,
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve(undefined);
        },
      },
    );
    assert.equal(resolvedCli, false);
    await assert.rejects(auth.token({ login: false }), /Databricks CLI is unavailable/);
    assert.equal(resolvedCli, true);
  });

  it("fails closed at U2M token acquisition when no compatible CLI can be resolved", async () => {
    const auth = await createAuthClient(
      {
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      },
      { environment: {}, resolveCli: () => Promise.resolve(undefined) },
    );
    await assert.rejects(auth.token({ login: false }), /Databricks CLI is unavailable/);
  });

  it("uses configured PAT credentials without resolving the CLI", async () => {
    let resolvedCli = false;
    const auth = await createAuthClient(
      {
        host: "https://example.cloud.databricks.com",
        profile: "PAT",
        authType: AuthType.PersonalAccessToken,
        accessToken: "profile-token",
      },
      {
        environment: {},
        resolveCli: () => {
          resolvedCli = true;
          return Promise.resolve(undefined);
        },
      },
    );
    assert.deepEqual(await auth.headers({ login: false }), {
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
        {
          profile: "SERVICE",
          host: `http://127.0.0.1:${address.port}`,
          accountId: "account-id",
          target: "account",
          authType: AuthType.OAuthM2M,
          clientId: "client-id",
          clientSecret: "client-secret",
        },
        { environment: {} },
      );
      const token = await auth.token({ login: false });
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
        {
          host: `http://127.0.0.1:${address.port}`,
          accountId: "account-id",
          target: "account",
        },
        {
          environment: {
            DATABRICKS_APP_PORT: "8000",
            DATABRICKS_CONFIG_FILE: "/tmp/dbx-tools-auth-app-test-missing",
            DATABRICKS_CONFIG_PROFILE: "DEFAULT",
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
      assert.equal((await auth.token({ login: false })).accessToken, "app-token");
      assert.equal(auth.profile, undefined);
      assert.equal(resolvedCli, false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
