import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { resolveAutoConfigurePolicy } from "../src/_auto-configure.ts";
import { autoConfigure } from "../src/appkit.ts";

describe("automatic database configuration policy", () => {
  it("writes auth's resolved default profile when the environment is missing it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-appkit-profile-"));
    const configFile = join(directory, "databrickscfg");
    const previous = {
      app: process.env.DBX_TOOLS_DATABRICKS_APP_ENV,
      configFile: process.env.DATABRICKS_CONFIG_FILE,
      profile: process.env.DATABRICKS_CONFIG_PROFILE,
    };
    writeFileSync(
      configFile,
      "[__settings__]\ndefault_profile = USER\n[USER]\nhost = https://workspace.example\nauth_type = databricks-cli\n",
    );
    try {
      process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "false";
      process.env.DATABRICKS_CONFIG_FILE = configFile;
      delete process.env.DATABRICKS_CONFIG_PROFILE;

      await autoConfigure({ autoConfigure: false });

      assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, "USER");
    } finally {
      restore("DBX_TOOLS_DATABRICKS_APP_ENV", previous.app);
      restore("DATABRICKS_CONFIG_FILE", previous.configFile);
      restore("DATABRICKS_CONFIG_PROFILE", previous.profile);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes an unusable DEFAULT profile from complete machine credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dbx-tools-appkit-profile-"));
    const configFile = join(directory, "databrickscfg");
    const previous = {
      app: process.env.DBX_TOOLS_DATABRICKS_APP_ENV,
      configFile: process.env.DATABRICKS_CONFIG_FILE,
      profile: process.env.DATABRICKS_CONFIG_PROFILE,
      host: process.env.DATABRICKS_HOST,
      clientId: process.env.DATABRICKS_CLIENT_ID,
      clientSecret: process.env.DATABRICKS_CLIENT_SECRET,
    };
    writeFileSync(configFile, "[DEFAULT]\nauth_type=pat\ntoken=unused\n");
    try {
      process.env.DBX_TOOLS_DATABRICKS_APP_ENV = "false";
      process.env.DATABRICKS_CONFIG_FILE = configFile;
      process.env.DATABRICKS_HOST = "https://workspace.example.com";
      process.env.DATABRICKS_CLIENT_ID = "app-id";
      process.env.DATABRICKS_CLIENT_SECRET = "app-secret";
      process.env.DATABRICKS_CONFIG_PROFILE = "DEFAULT";

      await autoConfigure({ autoConfigure: false });

      assert.equal(process.env.DATABRICKS_CONFIG_PROFILE, undefined);
    } finally {
      restore("DBX_TOOLS_DATABRICKS_APP_ENV", previous.app);
      restore("DATABRICKS_CONFIG_FILE", previous.configFile);
      restore("DATABRICKS_CONFIG_PROFILE", previous.profile);
      restore("DATABRICKS_HOST", previous.host);
      restore("DATABRICKS_CLIENT_ID", previous.clientId);
      restore("DATABRICKS_CLIENT_SECRET", previous.clientSecret);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("skips an unconfigured app with no native database demand", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["server"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: false,
      databasePluginPresent: false,
      shouldResolve: false,
      provision: false,
      skippedReason: "no database plugin",
    });
  });

  it("preserves implicit Lakebase provisioning", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["lakebase"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: true,
      databasePluginPresent: false,
      shouldResolve: true,
      provision: true,
    });
  });

  it("resolves database-only environment without broadening cache grants", () => {
    assert.deepEqual(resolveAutoConfigurePolicy(["database"], undefined), {
      mode: "provision",
      explicit: false,
      lakebasePluginPresent: false,
      databasePluginPresent: true,
      shouldResolve: true,
      provision: false,
    });
  });

  it("provisions once when lakebase and database are both present", () => {
    assert.equal(resolveAutoConfigurePolicy(["database", "lakebase"], undefined).provision, true);
  });

  it("honors every explicit mode independently of plugin demand", () => {
    assert.deepEqual(resolveAutoConfigurePolicy([], "env"), {
      mode: "env",
      explicit: true,
      lakebasePluginPresent: false,
      databasePluginPresent: false,
      shouldResolve: true,
      provision: false,
    });
    assert.equal(resolveAutoConfigurePolicy(["database"], "provision").provision, true);
    assert.deepEqual(resolveAutoConfigurePolicy(["lakebase", "database"], false), {
      mode: false,
      explicit: true,
      lakebasePluginPresent: true,
      databasePluginPresent: true,
      shouldResolve: false,
      provision: false,
      skippedReason: "disabled",
    });
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
