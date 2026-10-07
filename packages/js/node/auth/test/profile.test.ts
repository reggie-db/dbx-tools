import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AuthType, databricksProfileListSchema, TargetKind } from "@dbx-tools/shared-auth";

import {
  invalidateConfigFile,
  listDatabricksProfiles,
  parseDatabricksConfig,
  resolveDatabricksProfile,
} from "../src/_profile-config.ts";

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

  it("preserves dots in Databricks profile names", () => {
    const name = "oauth.cloud.databricks.com-workspace";
    const config = parseDatabricksConfig(`[${name}]\nhost=https://example.cloud.databricks.com\n`);

    assert.equal(config.get(name)?.get("host"), "https://example.cloud.databricks.com");
    assert.equal(config.has("oauth"), false);
  });

  it("prefers one matching CLI profile over an implicit M2M default", async () => {
    await withConfig(
      `[__settings__]\ndefault_profile = service\n\n[service]\nhost = https://example.cloud.databricks.com\nclient_id = service-id\nclient_secret = secret\n\n[user]\nhost = https://example.cloud.databricks.com\nauth_type = databricks-cli\n`,
      (configFile) => {
        const profile = resolveDatabricksProfile({ configFile }, {});
        assert.equal(profile.name, "user");
        assert.equal(profile.authType, AuthType.DatabricksCli);
      },
    );
  });

  it("never remaps an explicit profile", async () => {
    await withConfig(
      `[service]\nhost = https://example.cloud.databricks.com\nclient_id = service-id\nclient_secret = secret\n\n[user]\nhost = https://example.cloud.databricks.com\nauth_type = databricks-cli\n`,
      (configFile) => {
        const profile = resolveDatabricksProfile({ configFile, profile: "service" }, {});
        assert.equal(profile.name, "service");
        assert.equal(profile.authType, AuthType.OAuthM2M);
      },
    );
  });

  it("isolates an explicit profile from ambient Databricks credentials", async () => {
    await withConfig(
      `[selected]\nhost = https://selected.cloud.databricks.com\nworkspace_id = selected-workspace\nauth_type = pat\ntoken = selected-token\n`,
      (configFile) => {
        const profile = resolveDatabricksProfile(
          { configFile },
          {
            DATABRICKS_CONFIG_PROFILE: "selected",
            DATABRICKS_HOST: "https://ambient.cloud.databricks.com",
            DATABRICKS_WORKSPACE_ID: "ambient-workspace",
            DATABRICKS_AUTH_TYPE: "pat",
            DATABRICKS_TOKEN: "ambient-token",
          },
        );
        assert.equal(profile.host, "https://selected.cloud.databricks.com");
        assert.equal(profile.workspaceId, "selected-workspace");
        assert.equal(profile.accessToken, "selected-token");
        assert.equal(profile.authType, AuthType.PersonalAccessToken);
      },
    );
  });

  it("changes the PAT cache identity when the configured token changes", () => {
    const left = resolveDatabricksProfile(
      {
        profile: "PAT",
        host: "https://example.cloud.databricks.com",
        authType: AuthType.PersonalAccessToken,
        accessToken: "left",
      },
      {},
    );
    const right = resolveDatabricksProfile(
      {
        profile: "PAT",
        host: "https://example.cloud.databricks.com",
        authType: AuthType.PersonalAccessToken,
        accessToken: "right",
      },
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
            authType: AuthType.OAuthM2M,
            principal: "client-id",
          },
        ]);
        assert.deepEqual(databricksProfileListSchema.parse(profiles), profiles);
        assert.equal(JSON.stringify(profiles).includes("do-not-return"), false);
        assert.equal(resolveDatabricksProfile({ configFile }, {}).name, "account");
      },
    );
  });

  it("prefers App OBO over App SP when a request token exists", () => {
    const profile = resolveDatabricksProfile(
      {
        requestHeaders: { Authorization: "Bearer request-token" },
      },
      {
        DBX_TOOLS_DATABRICKS_APP_ENV: "true",
        DATABRICKS_HOST: "https://example.cloud.databricks.com",
        DATABRICKS_CLIENT_ID: "app-id",
        DATABRICKS_CLIENT_SECRET: "app-secret",
      },
    );
    assert.equal(profile.authType, AuthType.AppOnBehalfOf);
    assert.equal(profile.accessToken, "request-token");
  });
});
