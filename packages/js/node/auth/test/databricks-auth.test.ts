import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createPersistentAuth } from "../src/databricks-auth.ts";
import { DatabricksClient } from "../src/http-client.ts";
import { DatabricksAuthOptions, Storage } from "../src/types.ts";

describe("Databricks provider construction", () => {
  it("returns authorization and profile workspace headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dbx-tools-auth-headers-"));
    const configFile = join(directory, "config");
    try {
      await writeFile(
        configFile,
        `[DEFAULT]\nhost = https://example.cloud.databricks.com\nworkspace_id = workspace-id\nauth_type = pat\ntoken = profile-token\n`,
      );
      const auth = await createPersistentAuth(
        DatabricksAuthOptions.create({ configFile, profile: "DEFAULT" }),
        Storage.Memory,
        { environment: {} },
      );

      assert.equal(auth.workspaceId(), "workspace-id");
      assert.deepEqual(await auth.headers(false), {
        authorization: "Bearer profile-token",
        "x-databricks-workspace-id": "workspace-id",
      });
      assert.deepEqual(
        await auth.requestHeadersForUrl(
          "https://example.cloud.databricks.com/api/2.0/clusters/list",
          false,
        ),
        {
          authorization: "Bearer profile-token",
          "x-databricks-workspace-id": "workspace-id",
        },
      );
      assert.deepEqual(await auth.requestHeadersForUrl("https://example.com", false), {});

      let outboundHeaders: Headers | undefined;
      const client = await DatabricksClient.create(
        DatabricksAuthOptions.create({ configFile, profile: "DEFAULT", cacheDir: directory }),
        {
          environment: {},
          fetch: async (_input, init) => {
            outboundHeaders = new Headers(init?.headers);
            return new Response("{}", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
        },
      );
      await client.request("/api/2.0/clusters/list", { login: false });
      assert.equal(outboundHeaders?.get("authorization"), "Bearer profile-token");
      assert.equal(outboundHeaders?.get("x-databricks-workspace-id"), "workspace-id");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers a compatible CLI for automatic U2M with any storage", async () => {
    const auth = await createPersistentAuth(
      DatabricksAuthOptions.create({
        host: "https://example.cloud.databricks.com",
        profile: "TEST",
      }),
      Storage.Memory,
      {
        environment: {},
        resolveCli: () => Promise.resolve("databricks"),
        fetch: async () => {
          throw new Error("native OAuth discovery should not run");
        },
      },
    );
    assert.equal(auth.status().profile, "TEST");
    assert.equal(auth.status().storage, Storage.Memory);
  });

  it("uses native OAuth when the profile explicitly selects oauth-u2m", async () => {
    let resolvedCli = false;
    await assert.rejects(
      createPersistentAuth(
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
          fetch: async () => {
            throw new Error("native OAuth discovery selected");
          },
        },
      ),
      /native OAuth discovery selected/,
    );
    assert.equal(resolvedCli, false);
  });

  it("does not invoke the CLI automatically inside a Databricks App", async () => {
    let resolvedCli = false;
    await assert.rejects(
      createPersistentAuth(
        DatabricksAuthOptions.create({
          host: "https://example.cloud.databricks.com",
          profile: "TEST",
        }),
        Storage.Memory,
        {
          environment: { DBX_TOOLS_DATABRICKS_APP_ENV: "true" },
          resolveCli: () => {
            resolvedCli = true;
            return Promise.resolve("databricks");
          },
          fetch: async () => {
            throw new Error("native OAuth discovery selected");
          },
        },
      ),
      /native OAuth discovery selected/,
    );
    assert.equal(resolvedCli, false);
  });

  it("fails closed when databricks-cli is explicit and no CLI can be resolved", async () => {
    await assert.rejects(
      createPersistentAuth(
        DatabricksAuthOptions.create({
          host: "https://example.cloud.databricks.com",
          profile: "TEST",
          authType: "databricks-cli",
        }),
        Storage.Memory,
        {
          environment: {},
          resolveCli: () => Promise.resolve(undefined),
        },
      ),
      /Databricks CLI is unavailable/,
    );
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
