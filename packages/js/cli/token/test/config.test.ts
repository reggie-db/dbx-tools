import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { canonicalScopes, resolveTokenConfig, TOKEN_PROVIDERS } from "../src/config.ts";

const ENV_KEYS = [
  "DBX_TOOLS_TOKEN_BROKER_PROVIDERS",
  "TOKEN_BROKER_PROVIDERS",
  "DBX_TOOLS_TOKEN_BROKER_SCOPES",
  "TOKEN_BROKER_SCOPES",
  "DBX_TOOLS_TOKEN_BROKER_ALLOWED_SCOPES",
  "TOKEN_BROKER_ALLOWED_SCOPES",
  "DBX_TOOLS_TOKEN_BROKER_BINDS",
  "TOKEN_BROKER_BINDS",
  "DBX_TOOLS_TOKEN_BROKER_ALLOWED_HOSTS",
  "TOKEN_BROKER_ALLOWED_HOSTS",
  "DBX_TOOLS_TOKEN_BROKER_PORT",
  "TOKEN_BROKER_PORT",
  "DBX_TOOLS_TOKEN_BROKER_AUTH",
  "TOKEN_BROKER_AUTH",
  "DBX_TOOLS_TOKEN_BROKER_SECRET",
  "TOKEN_BROKER_SECRET",
  "DBX_TOOLS_TOKEN_BROKER_CLIENT_JWT_TTL_SECONDS",
  "TOKEN_BROKER_CLIENT_JWT_TTL_SECONDS",
  "TOKEN_BROKER_BIND_DOCKER",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("token broker config", () => {
  it("uses JWT defaults and canonical Google scopes", () => {
    const defaults = resolveTokenConfig();
    const clientDefaults = resolveTokenConfig();
    const resolved = resolveTokenConfig({
      scopes: ["scope:b", "scope:a", "scope:b"],
    });

    assert.deepEqual(defaults.scopes, []);
    assert.deepEqual(defaults.allowedScopes, []);
    assert.deepEqual(defaults.providers, [...TOKEN_PROVIDERS]);
    assert.deepEqual(resolved.bind, ["127.0.0.1"]);
    assert.equal(resolved.bindDocker, "auto");
    assert.equal(resolved.port, 5556);
    assert.equal(resolved.auth, "jwt");
    assert.equal(clientDefaults.stateDir, defaults.stateDir);
    assert.equal(clientDefaults.serviceName, defaults.serviceName);
    assert.equal(clientDefaults.client, "local-cli");
    assert.equal(
      resolveTokenConfig({ gcloudPath: "/opt/homebrew/bin/gcloud" }).gcloudPath,
      "/opt/homebrew/bin/gcloud",
    );
    assert.deepEqual(resolved.scopes, ["scope:a", "scope:b"]);
    assert.deepEqual(resolved.allowedScopes, []);
  });

  it("resolves scoped env before capability env and CLI before both", () => {
    process.env.TOKEN_BROKER_PORT = "4100";
    process.env.DBX_TOOLS_TOKEN_BROKER_PORT = "4200";
    process.env.DBX_TOOLS_TOKEN_BROKER_AUTH = "jwt";
    process.env.DBX_TOOLS_TOKEN_BROKER_CLIENT_JWT_TTL_SECONDS = "120";
    process.env.DBX_TOOLS_TOKEN_BROKER_PROVIDERS = "google";
    process.env.DBX_TOOLS_TOKEN_BROKER_SCOPES = "scope:b,scope:a";
    process.env.DBX_TOOLS_TOKEN_BROKER_ALLOWED_SCOPES = "scope:a,scope:b";
    process.env.DBX_TOOLS_TOKEN_BROKER_BINDS = "127.0.0.1,::1";
    process.env.DBX_TOOLS_TOKEN_BROKER_ALLOWED_HOSTS = "broker.internal,broker.local";

    const resolved = resolveTokenConfig();
    assert.equal(resolved.port, 4200);
    assert.equal(resolved.auth, "jwt");
    assert.equal(resolved.clientTokenTtlSeconds, 120);
    assert.deepEqual(resolved.providers, ["google"]);
    assert.deepEqual(resolved.scopes, ["scope:a", "scope:b"]);
    assert.deepEqual(resolved.allowedScopes, ["scope:a", "scope:b"]);
    assert.deepEqual(resolved.bind, ["127.0.0.1", "::1"]);
    assert.ok(resolved.allowedHosts.includes("broker.internal"));
    assert.equal(resolveTokenConfig({ port: 4300, auth: "password" }).port, 4300);
    assert.equal(resolveTokenConfig({ port: 4300, auth: "password" }).auth, "password");
  });

  it("normalizes container-engine and scope values", () => {
    assert.equal(resolveTokenConfig({ bindDocker: true }).bindDocker, "auto");
    assert.equal(resolveTokenConfig({ bindDocker: "podman" }).bindDocker, "podman");
    assert.equal(resolveTokenConfig({ bindDocker: false }).bindDocker, undefined);
    process.env.TOKEN_BROKER_BIND_DOCKER = "true";
    assert.equal(resolveTokenConfig().bindDocker, "auto");
    assert.deepEqual(canonicalScopes([" b ", "a", "", "a"]), ["a", "b"]);
  });

  it("supports password and JWT auth modes with one secret", () => {
    const password = resolveTokenConfig({ auth: "password", secret: "shared" });

    assert.equal(resolveTokenConfig({ auth: "jwt" }).auth, "jwt");
    assert.equal(password.auth, "password");
    assert.equal(password.secret, "shared");
  });

  it("rejects unsupported auth, provider, and engine values", () => {
    assert.throws(() => resolveTokenConfig({ auth: "cookie" }), /broker auth/);
    assert.throws(() => resolveTokenConfig({ providers: ["unknown"] }), /token provider/);
    assert.throws(
      () => resolveTokenConfig({ bindDocker: "containerd" as "docker" }),
      /container engine/,
    );
  });
});
