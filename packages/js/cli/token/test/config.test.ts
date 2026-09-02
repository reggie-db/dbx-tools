import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { canonicalScopes, resolveTokenConfig } from "../src/config.ts";

const ENV_KEYS = [
  "DBX_TOOLS_TOKEN_BROKER_PORT",
  "TOKEN_BROKER_PORT",
  "DBX_TOOLS_TOKEN_BROKER_AUTH",
  "TOKEN_BROKER_AUTH",
  "TOKEN_BROKER_BIND_DOCKER",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("token broker config", () => {
  it("uses unauthenticated HTTP loopback defaults and canonical Google scopes", () => {
    const defaults = resolveTokenConfig();
    const resolved = resolveTokenConfig({
      scopes: ["scope:b", "scope:a", "scope:b"],
    });

    assert.deepEqual(defaults.scopes, []);
    assert.deepEqual(defaults.allowedScopes, []);
    assert.deepEqual(resolved.bind, ["127.0.0.1"]);
    assert.equal(resolved.port, 4010);
    assert.equal(resolved.tls, "none");
    assert.equal(resolved.auth, "none");
    assert.deepEqual(resolved.scopes, ["scope:a", "scope:b"]);
    assert.deepEqual(resolved.allowedScopes, ["scope:a", "scope:b"]);
  });

  it("resolves scoped env before capability env and CLI before both", () => {
    process.env.TOKEN_BROKER_PORT = "4100";
    process.env.DBX_TOOLS_TOKEN_BROKER_PORT = "4200";
    process.env.DBX_TOOLS_TOKEN_BROKER_AUTH = "jwt";

    assert.equal(resolveTokenConfig().port, 4200);
    assert.equal(resolveTokenConfig().auth, "jwt");
    assert.equal(resolveTokenConfig({ port: 4300, auth: "password" }).port, 4300);
    assert.equal(resolveTokenConfig({ port: 4300, auth: "password" }).auth, "password");
  });

  it("normalizes container-engine and scope values", () => {
    assert.equal(resolveTokenConfig({ bindDocker: true }).bindDocker, "auto");
    assert.equal(resolveTokenConfig({ bindDocker: "podman" }).bindDocker, "podman");
    process.env.TOKEN_BROKER_BIND_DOCKER = "true";
    assert.equal(resolveTokenConfig().bindDocker, "auto");
    assert.deepEqual(canonicalScopes([" b ", "a", "", "a"]), ["a", "b"]);
  });

  it("enables mTLS by default for authenticated modes and disables it for no auth", () => {
    assert.equal(resolveTokenConfig({ auth: "jwt" }).tls, "mtls");
    assert.equal(resolveTokenConfig({ auth: "password" }).tls, "mtls");
    assert.equal(resolveTokenConfig({ auth: "none", tls: "mtls" }).tls, "none");
    assert.equal(resolveTokenConfig({ auth: "none", password: "ignored" }).password, undefined);
  });

  it("rejects unsupported auth, TLS, provider, and engine values", () => {
    assert.throws(() => resolveTokenConfig({ auth: "cookie" }), /broker auth/);
    assert.throws(() => resolveTokenConfig({ tls: "optional" }), /broker TLS/);
    assert.throws(() => resolveTokenConfig({ provider: "unknown" }), /token provider/);
    assert.throws(
      () => resolveTokenConfig({ bindDocker: "containerd" as "docker" }),
      /container engine/,
    );
  });
});
