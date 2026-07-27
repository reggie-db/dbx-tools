import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activity as activityContract } from "@dbx-tools/shared-teams";
import { isAllowedServiceUrl } from "../src/auth";
import { resolveTeamsConfig } from "../src/config";
import { resolveServiceUrl } from "../src/messaging";

/** An inbound activity as a channel would send it, with a `serviceUrl`. */
const inbound = (serviceUrl?: string): activityContract.Activity =>
  activityContract.activitySchema.parse({
    type: "message",
    text: "status?",
    from: { id: "user-1" },
    conversation: { id: "conv-1" },
    ...(serviceUrl ? { serviceUrl } : {}),
  });

describe("teams reply destination", () => {
  // The security property that matters most here: a Bot Service token is a
  // bearer credential, so the host replies are sent to must come from the
  // TOKEN, not the request body an attacker also controls.
  it("accepts a serviceUrl matching the one the token was issued for", () => {
    const url = "https://smba.trafficmanager.net/amer/";
    assert.equal(resolveServiceUrl(inbound(url), url), url);
  });

  it("ignores trailing-slash and case differences when comparing to the token", () => {
    assert.equal(
      resolveServiceUrl(
        inbound("https://smba.trafficmanager.net/amer"),
        "https://smba.trafficmanager.net/amer/",
      ),
      "https://smba.trafficmanager.net/amer",
    );
  });

  it("refuses a serviceUrl the token was not issued for", () => {
    assert.equal(
      resolveServiceUrl(
        inbound("https://attacker.example.com/"),
        "https://smba.trafficmanager.net/amer/",
      ),
      null,
    );
  });

  it("refuses an activity that names no serviceUrl", () => {
    assert.equal(resolveServiceUrl(inbound(), "https://smba.trafficmanager.net/amer/"), null);
  });

  // With no `serviceurl` claim to pin against, the body value is still confined
  // to Microsoft's own hosts rather than trusted outright.
  it("falls back to allowing only Microsoft hosts when the token names none", () => {
    assert.ok(isAllowedServiceUrl("https://smba.trafficmanager.net/amer/"));
    assert.ok(isAllowedServiceUrl("https://api.botframework.com"));
    assert.equal(isAllowedServiceUrl("https://attacker.example.com/"), false);
  });

  it("refuses a plaintext http serviceUrl", () => {
    assert.equal(isAllowedServiceUrl("http://smba.trafficmanager.net/amer/"), false);
  });

  it("refuses a host that merely embeds a Microsoft domain", () => {
    assert.equal(isAllowedServiceUrl("https://botframework.com.attacker.example/"), false);
  });

  it("refuses an unparseable serviceUrl", () => {
    assert.equal(isAllowedServiceUrl("not-a-url"), false);
  });
});

describe("teams bot credentials", () => {
  /**
   * Run `fn` with `env` applied, restoring the previous environment after.
   *
   * An `undefined` value DELETES the variable rather than assigning it:
   * `process.env.X = undefined` stores the string `"undefined"`, which the
   * resolver would then read as a configured value. The developer's own
   * environment may already export these names, so each case states the full
   * set it depends on and this helper clears the rest.
   */
  const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
    const keys = [
      "TEAMS_APP_ID",
      "TEAMS_APP_PASSWORD",
      "TEAMS_APP_TENANT_ID",
      "MICROSOFT_APP_ID",
      "MICROSOFT_APP_PASSWORD",
      "MICROSOFT_APP_TENANT_ID",
    ];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    const apply = (values: Map<string, string | undefined>) => {
      for (const [key, value] of values) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    // Start from a clean slate so an ambient variable can't satisfy a case that
    // is asserting the variable is absent.
    apply(new Map(keys.map((key) => [key, undefined])));
    apply(new Map(Object.entries(env)));
    try {
      fn();
    } finally {
      apply(previous);
    }
  };

  it("reads the bot registration from the environment", () => {
    withEnv(
      { TEAMS_APP_ID: "app-1", TEAMS_APP_PASSWORD: "secret", TEAMS_APP_TENANT_ID: "tenant-1" },
      () => {
        const config = resolveTeamsConfig();
        assert.equal(config.appId, "app-1");
        assert.equal(config.appPassword, "secret");
        assert.equal(config.appTenantId, "tenant-1");
      },
    );
  });

  // An existing Bot Framework deployment already exports these names, so they
  // are accepted as aliases and must not require a rename to adopt this plugin.
  it("accepts the MICROSOFT_APP_* spellings the Bot Framework SDK uses", () => {
    withEnv(
      {
        TEAMS_APP_ID: undefined,
        TEAMS_APP_PASSWORD: undefined,
        MICROSOFT_APP_ID: "app-2",
        MICROSOFT_APP_PASSWORD: "secret-2",
      },
      () => {
        const config = resolveTeamsConfig();
        assert.equal(config.appId, "app-2");
        assert.equal(config.appPassword, "secret-2");
      },
    );
  });

  it("prefers the TEAMS_* spelling over the alias", () => {
    withEnv({ TEAMS_APP_ID: "wins", MICROSOFT_APP_ID: "loses" }, () => {
      assert.equal(resolveTeamsConfig().appId, "wins");
    });
  });

  it("leaves the bot fields absent when nothing is configured", () => {
    withEnv(
      {
        TEAMS_APP_ID: undefined,
        TEAMS_APP_PASSWORD: undefined,
        TEAMS_APP_TENANT_ID: undefined,
        MICROSOFT_APP_ID: undefined,
        MICROSOFT_APP_PASSWORD: undefined,
        MICROSOFT_APP_TENANT_ID: undefined,
      },
      () => {
        const config = resolveTeamsConfig();
        // Absent, not `undefined`-valued: the plugin branches on presence to
        // decide whether the messaging endpoint may serve at all.
        assert.equal("appId" in config, false);
        assert.equal("appPassword" in config, false);
      },
    );
  });
});

describe("teams unauthenticated bypass", () => {
  /** Resolve config with `env` applied, then restore the environment. */
  const resolveWith = (env: Record<string, string | undefined>) => {
    const keys = ["NODE_ENV", "TEAMS_ALLOW_UNAUTHENTICATED"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) process.env[key] = value;
    }
    try {
      return resolveTeamsConfig();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it("stays off by default", () => {
    assert.equal(resolveWith({ NODE_ENV: "development" }).allowUnauthenticated, false);
  });

  it("turns on when requested in a development build", () => {
    assert.equal(
      resolveWith({ NODE_ENV: "development", TEAMS_ALLOW_UNAUTHENTICATED: "true" })
        .allowUnauthenticated,
      true,
    );
  });

  // The guard that matters: a stray variable in a production environment must
  // not be able to expose an unauthenticated agent endpoint.
  it("refuses to enable outside a development build", () => {
    for (const nodeEnv of ["production", "test", undefined]) {
      assert.equal(
        resolveWith({ NODE_ENV: nodeEnv, TEAMS_ALLOW_UNAUTHENTICATED: "true" })
          .allowUnauthenticated,
        false,
        `expected NODE_ENV=${nodeEnv ?? "unset"} to keep the bypass off`,
      );
    }
  });

  it("ignores an explicit plugin option outside development too", () => {
    const keys = ["NODE_ENV"];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.NODE_ENV = "production";
    try {
      assert.equal(resolveTeamsConfig({ allowUnauthenticated: true }).allowUnauthenticated, false);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
