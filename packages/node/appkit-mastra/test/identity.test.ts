import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ConfigurationError } from "@databricks/appkit";

import { MASTRA_CONFIG_SCHEMA } from "../src/config.ts";
import {
  DEFAULT_IDENTITY_MODE,
  IDENTITY_ENV,
  IDENTITY_MODES,
  resolveIdentityMode,
  useServicePrincipal,
} from "../src/identity.ts";

/** Minimal Express-ish request carrying only the headers the resolver reads. */
function req(headers: Record<string, string>): { header(name: string): string | undefined } {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { header: (name: string) => lower[name.toLowerCase()] };
}

describe("resolveIdentityMode", () => {
  const original = process.env[IDENTITY_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[IDENTITY_ENV];
    else process.env[IDENTITY_ENV] = original;
  });

  it("defaults to OBO (`user`) when nothing is configured", () => {
    delete process.env[IDENTITY_ENV];
    assert.equal(resolveIdentityMode(undefined), "user");
    assert.equal(DEFAULT_IDENTITY_MODE, "user");
  });

  it("honors an explicit config value over the environment", () => {
    process.env[IDENTITY_ENV] = "user";
    assert.equal(resolveIdentityMode("service-principal"), "service-principal");
  });

  it("falls back to the environment when config is unset", () => {
    process.env[IDENTITY_ENV] = "service-principal";
    assert.equal(resolveIdentityMode(undefined), "service-principal");
  });

  it("is case-insensitive and trims", () => {
    delete process.env[IDENTITY_ENV];
    assert.equal(resolveIdentityMode("  Service-Principal "), "service-principal");
  });

  it("throws on an unrecognized value instead of silently defaulting", () => {
    delete process.env[IDENTITY_ENV];
    assert.throws(() => resolveIdentityMode("obo"), ConfigurationError);
  });
});

describe("useServicePrincipal", () => {
  it("never uses the service principal in `user` mode", () => {
    assert.equal(useServicePrincipal("user", req({ "x-forwarded-access-token": "t" })), false);
    assert.equal(useServicePrincipal("user", req({})), false);
  });

  it("always uses the service principal in `service-principal` mode", () => {
    assert.equal(useServicePrincipal("service-principal", req({})), true);
    assert.equal(
      useServicePrincipal("service-principal", req({ "x-forwarded-access-token": "t" })),
      true,
    );
  });

  it("in `auto` mode, falls back only when the request has no OBO token", () => {
    // The tunnel case: the gate proves the caller's email but cannot mint a
    // Databricks credential, so the turn runs as the service principal instead
    // of throwing AppKit's AuthenticationError.
    assert.equal(useServicePrincipal("auto", req({ "x-forwarded-user": "ada" })), true);
    assert.equal(useServicePrincipal("auto", req({ "x-forwarded-access-token": "t" })), false);
  });
});

describe("identity schema surface", () => {
  it("publishes exactly the supported modes on the config schema", () => {
    const genieIdentity = MASTRA_CONFIG_SCHEMA.properties?.genieIdentity as {
      enum?: unknown[];
    };
    // Derived from IDENTITY_MODES, so a new mode cannot reach the option without
    // also reaching the schema an AppKit host validates against.
    assert.deepEqual(genieIdentity.enum, [...IDENTITY_MODES]);
    assert.deepEqual([...IDENTITY_MODES], ["user", "service-principal", "auto"]);
  });
});
