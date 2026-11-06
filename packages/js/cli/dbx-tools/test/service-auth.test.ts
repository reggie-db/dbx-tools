import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { resolveServiceAuthEntrypoint } from "../src/_service-auth-entrypoint.ts";
import { databricksServiceAuthCommand, runDatabricksServiceAuth } from "../src/service-auth.ts";

describe("Databricks service authentication", () => {
  it("builds an auth preflight for auto and required modes", () => {
    const automatic = databricksServiceAuthCommand("auto", "PROFILE");
    assert.match(automatic?.entrypoint ?? "", /dbx-service-auth\.ts$/);
    assert.deepEqual(automatic?.arguments, ["--wait-for-auth", "auto", "--profile", "PROFILE"]);
    assert.deepEqual(databricksServiceAuthCommand("true", ["ONE", "TWO"])?.arguments, [
      "--wait-for-auth",
      "true",
      "--profile",
      "ONE",
      "--profile",
      "TWO",
    ]);
    assert.equal(databricksServiceAuthCommand("false", "PROFILE"), undefined);
  });

  it("preflights every configured profile in order", async () => {
    const created: Array<string | undefined> = [];
    const waited: unknown[] = [];
    await runDatabricksServiceAuth(
      { waitForAuth: "true", profile: ["ONE", "TWO"] },
      {
        resolveProfile: () => null,
        createWorkspaceClient: async (options) => {
          created.push(options.profile);
          return { profile: options.profile } as never;
        },
        waitForWorkspaceAuth: async (client) => {
          waited.push(client);
          return {} as never;
        },
      },
    );

    assert.deepEqual(created, ["ONE", "TWO"]);
    assert.deepEqual(waited, [{ profile: "ONE" }, { profile: "TWO" }]);
  });

  it("selects the packaged JavaScript bin from compiled modules", () => {
    assert.equal(
      resolveServiceAuthEntrypoint(pathToFileURL("/opt/dbx-tools/lib/src/service-auth.js").href),
      "/opt/dbx-tools/lib/bin/dbx-service-auth.js",
    );
    assert.equal(
      resolveServiceAuthEntrypoint(pathToFileURL("/opt/dbx-tools/src/service-auth.ts").href),
      "/opt/dbx-tools/bin/dbx-service-auth.ts",
    );
  });

  it("skips auto mode when no configured profile resolves", async () => {
    let clientCreated = false;
    const waited = await runDatabricksServiceAuth(
      { waitForAuth: "auto" },
      {
        resolveProfile: () => null,
        createWorkspaceClient: async () => {
          clientCreated = true;
          return {} as never;
        },
        waitForWorkspaceAuth: async () => ({}) as never,
      },
    );

    assert.equal(waited, false);
    assert.equal(clientCreated, false);
  });

  it("waits for current-user readiness with the resolved auto profile", async () => {
    const client = { client: true } as never;
    let selectedProfile: string | undefined;
    let waitedClient: unknown;
    const waited = await runDatabricksServiceAuth(
      { waitForAuth: "auto" },
      {
        resolveProfile: () => ({
          name: "RESOLVED",
          host: "https://example.com",
          target: "workspace",
          authType: "databricks-cli",
          principal: "user",
        }),
        createWorkspaceClient: async (options) => {
          selectedProfile = options.profile;
          return client;
        },
        waitForWorkspaceAuth: async (value) => {
          waitedClient = value;
          return {} as never;
        },
      },
    );

    assert.equal(waited, true);
    assert.equal(selectedProfile, "RESOLVED");
    assert.equal(waitedClient, client);
  });

  it("waits unconditionally when explicitly enabled", async () => {
    let resolved = false;
    let waited = false;
    assert.equal(
      await runDatabricksServiceAuth(
        { waitForAuth: "true", profile: "EXPLICIT" },
        {
          resolveProfile: () => {
            resolved = true;
            return null;
          },
          createWorkspaceClient: async (options) => {
            assert.equal(options.profile, "EXPLICIT");
            return {} as never;
          },
          waitForWorkspaceAuth: async () => {
            waited = true;
            return {} as never;
          },
        },
      ),
      true,
    );
    assert.equal(resolved, false);
    assert.equal(waited, true);
  });
});
