import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  invalidateConfigFile,
  listDatabricksProfiles,
  parseDatabricksConfig,
  resolveDatabricksProfile,
} from "../src/profile.ts";
import { AuthKind, DatabricksAuthOptions, TargetKind } from "../src/types.ts";

async function withConfig(source: string, action: (path: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "dbx-tools-auth-profile-"));
  const path = join(directory, "config");
  try {
    await writeFile(path, source);
    await action(path);
  } finally {
    invalidateConfigFile(path);
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Databricks profile resolution", () => {
  it("parses profiles through standard INI rules", () => {
    const config = parseDatabricksConfig(
      `[DEFAULT]\nhost=https://example.cloud.databricks.com\ntoken = value=with=equals\n`,
    );
    assert.equal(config.get("DEFAULT")?.get("host"), "https://example.cloud.databricks.com");
    assert.equal(config.get("DEFAULT")?.get("token"), "value=with=equals");
  });

  it("prefers one matching CLI profile over an implicit M2M default", async () => {
    await withConfig(
      `[__settings__]\ndefault_profile = service\n\n[service]\nhost = https://example.cloud.databricks.com\nclient_id = service-id\nclient_secret = secret\n\n[user]\nhost = https://example.cloud.databricks.com\nauth_type = databricks-cli\n`,
      (configFile) => {
        const profile = resolveDatabricksProfile(DatabricksAuthOptions.create({ configFile }), {});
        assert.equal(profile.name, "user");
        assert.equal(profile.authKind, AuthKind.UserToMachine);
      },
    );
  });

  it("never remaps an explicit profile", async () => {
    await withConfig(
      `[service]\nhost = https://example.cloud.databricks.com\nclient_id = service-id\nclient_secret = secret\n\n[user]\nhost = https://example.cloud.databricks.com\nauth_type = databricks-cli\n`,
      (configFile) => {
        const profile = resolveDatabricksProfile(
          DatabricksAuthOptions.create({ configFile, profile: "service" }),
          {},
        );
        assert.equal(profile.name, "service");
        assert.equal(profile.authKind, AuthKind.MachineToMachine);
      },
    );
  });

  it("changes the PAT cache identity when the configured token changes", () => {
    const left = resolveDatabricksProfile(
      DatabricksAuthOptions.create({
        profile: "PAT",
        host: "https://example.cloud.databricks.com",
        authType: "pat",
        accessToken: "left",
      }),
      {},
    );
    const right = resolveDatabricksProfile(
      DatabricksAuthOptions.create({
        profile: "PAT",
        host: "https://example.cloud.databricks.com",
        authType: "pat",
        accessToken: "right",
      }),
      {},
    );
    assert.notEqual(left.cacheKey, right.cacheKey);
    assert.equal(left.cacheKey.includes("left"), false);
    assert.equal(right.cacheKey.includes("right"), false);
  });

  it("lists secret-free profiles and honors default_profile", async () => {
    await withConfig(
      `[__settings__]\ndefault_profile = account\n\n[account]\nhost = https://accounts.cloud.databricks.com\naccount_id = account-id\nclient_id = client-id\nclient_secret = do-not-return\n`,
      (configFile) => {
        const profiles = listDatabricksProfiles(configFile, true, {});
        assert.deepEqual(profiles, [
          {
            name: "account",
            host: "https://accounts.cloud.databricks.com",
            accountId: "account-id",
            target: TargetKind.Account,
            authKind: AuthKind.MachineToMachine,
          },
        ]);
        assert.equal(JSON.stringify(profiles).includes("do-not-return"), false);
        assert.equal(
          resolveDatabricksProfile(DatabricksAuthOptions.create({ configFile }), {}).name,
          "account",
        );
      },
    );
  });

  it("prefers App OBO over App SP when a request token exists", () => {
    const profile = resolveDatabricksProfile(
      DatabricksAuthOptions.create({
        requestHeaders: { Authorization: "Bearer request-token" },
      }),
      {
        DBX_TOOLS_DATABRICKS_APP_ENV: "true",
        DATABRICKS_HOST: "https://example.cloud.databricks.com",
        DATABRICKS_CLIENT_ID: "app-id",
        DATABRICKS_CLIENT_SECRET: "app-secret",
      },
    );
    assert.equal(profile.authKind, AuthKind.AppOnBehalfOf);
    assert.equal(profile.accessToken, "request-token");
  });
});
