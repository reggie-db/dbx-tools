/**
 * Flag -> environment -> default resolution for `dbx tunnel`.
 *
 * The point of these cases is that the CLI must not own a default, an env name, or
 * a coercion rule: every value is handed to `@dbx-tools/tunnel`'s own
 * `resolveAuthGateConfig`/`resolvePortrConfig`, which the in-process plugin path
 * also calls. So what is asserted here is the PRECEDENCE and the pass-through, not
 * the values themselves - a divergence between the two paths is the regression this
 * package could most easily introduce.
 *
 * `DBX_TOOLS_CONFIG_BUNDLE=false` on every case keeps `databricks bundle validate`
 * out of it: the repo has a real `databricks.yml`, and a test that reads it would
 * pass or fail based on the developer's workspace.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { resolveTunnelOptions } from "../src/options.ts";

const KEYS = [
  "DBX_TOOLS_CONFIG_BUNDLE",
  "DBX_TOOLS_CONFIG_DOTENV",
  "DATABRICKS_APP_PORT",
  "PORTR_TOKEN",
  "PORTR_SERVER",
  "FRP_SERVER",
  "FRP_SERVER_PORT",
  "FRP_PROTOCOL",
  "FRP_TOKEN",
  "FRP_PROXY_NAME",
  "TUNNEL_TOKEN",
  "DBX_TOOLS_TUNNEL_TRANSPORT",
  "DBX_TOOLS_TUNNEL_FRP_PUBLIC_DOMAIN",
  "DBX_TOOLS_TUNNEL_APP_PORT",
  "DBX_TOOLS_TUNNEL_PUBLIC_DOMAIN",
  "DBX_TOOLS_TUNNEL_AUTH_ALLOW",
  "DBX_TOOLS_TUNNEL_AUTH_SUBJECT",
  "DBX_TOOLS_TUNNEL_AUTH_SESSION_TTL",
  "DBX_TOOLS_TUNNEL_INSECURE",
  "DBX_TOOLS_TUNNEL_FORWARD_HEADERS",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  // Read nothing off the developer's disk: no bundle, no `.env`.
  process.env.DBX_TOOLS_CONFIG_BUNDLE = "false";
  process.env.DBX_TOOLS_CONFIG_DOTENV = "false";
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveTunnelOptions", () => {
  it("defaults the public port to the Databricks Apps port contract", () => {
    assert.equal(resolveTunnelOptions({}).publicPort, 8000);
    process.env.DATABRICKS_APP_PORT = "9001";
    assert.equal(resolveTunnelOptions({}).publicPort, 9001);
    // A flag beats the platform variable, which is what makes a second tunnel on
    // one machine possible.
    assert.equal(resolveTunnelOptions({ port: "9002" }).publicPort, 9002);
  });

  it("leaves appPort unset unless asked, so a free port is chosen at run time", () => {
    assert.equal(resolveTunnelOptions({}).appPort, undefined);
    process.env.DBX_TOOLS_TUNNEL_APP_PORT = "4100";
    assert.equal(resolveTunnelOptions({}).appPort, 4100);
    assert.equal(resolveTunnelOptions({ appPort: "4200" }).appPort, 4200);
  });

  it("passes gate flags through unresolved, so the plugin applies its own defaults", () => {
    const resolved = resolveTunnelOptions({ sessionTtl: "120", codeTtl: "30" });
    // Coerced to a number for the plugin's `config` shape, not resolved here.
    assert.equal(resolved.gateConfig.sessionTtlSeconds, 120);
    assert.equal(resolved.gateConfig.codeTtlSeconds, 30);
    assert.equal(resolved.gate.sessionTtlSeconds, 120);
    // A value the CLI was not given is absent from gateConfig entirely, which is
    // what lets the plugin - the one owner of the default - fill it in.
    assert.equal(resolved.gateConfig.subject, undefined);
    assert.equal(resolved.gate.subject, "Your verification code");
  });

  it("resolves gate settings from the environment when no flag is given", () => {
    process.env.DBX_TOOLS_TUNNEL_AUTH_SUBJECT = "Env subject";
    process.env.DBX_TOOLS_TUNNEL_AUTH_SESSION_TTL = "60";
    const fromEnv = resolveTunnelOptions({});
    assert.equal(fromEnv.gate.subject, "Env subject");
    assert.equal(fromEnv.gate.sessionTtlSeconds, 60);
    // Flag wins over the environment.
    assert.equal(resolveTunnelOptions({ subject: "Flag subject" }).gate.subject, "Flag subject");
  });

  it("unions the allow-list across the flag and the environment", () => {
    process.env.DBX_TOOLS_TUNNEL_AUTH_ALLOW = "ops@example.com";
    const resolved = resolveTunnelOptions({ allow: ["databricks.com"] });
    // Deliberately a union, not an override: a deployment-wide allow-list and a
    // per-invocation `--allow` should both grant access.
    assert.deepEqual(resolved.gate.allow.toSorted(), ["databricks.com", "ops@example.com"]);
  });

  it("resolves insecure and forward-headers through the same layering", () => {
    assert.equal(resolveTunnelOptions({}).gate.insecure, false);
    process.env.DBX_TOOLS_TUNNEL_INSECURE = "true";
    assert.equal(resolveTunnelOptions({}).gate.insecure, true);
    assert.equal(resolveTunnelOptions({ insecure: true }).gate.insecure, true);

    process.env.DBX_TOOLS_TUNNEL_FORWARD_HEADERS = "x-env-header";
    const headers = resolveTunnelOptions({ forwardHeaders: ["x-flag-header"] }).gate.forwardHeaders;
    assert.deepEqual([...headers].toSorted(), ["x-env-header", "x-flag-header"]);
  });

  it("yields no portr config without a token, and derives the subdomain from the domain", () => {
    // The most common silent failure: no token means no public URL, and `status`
    // exists so that shows up as `portr: undefined` instead of a hang.
    assert.equal(resolveTunnelOptions({ publicDomain: "demo.apps.example.com" }).portr, undefined);

    process.env.PORTR_TOKEN = "portr_test_token";
    const resolved = resolveTunnelOptions({ publicDomain: "demo.apps.example.com", port: "8123" });
    assert.deepEqual(resolved.portr, {
      subdomain: "demo",
      server: "apps.example.com",
      token: "portr_test_token",
      port: 8123,
    });
    // portr forwards to the port the WRAPPER listens on, not the wrapped app's.
    assert.equal(resolved.portr?.port, resolved.publicPort);

    // An explicit subdomain overrides the one derived from the domain.
    assert.equal(
      resolveTunnelOptions({ publicDomain: "demo.apps.example.com", subdomain: "other" }).portr
        ?.subdomain,
      "other",
    );
  });

  it("yields no portr config from a bare domain with no server to split off", () => {
    process.env.PORTR_TOKEN = "portr_test_token";
    assert.equal(resolveTunnelOptions({ publicDomain: "localhost" }).portr, undefined);
  });

  it("defaults to portr and resolves an FRP WSS tunnel without requiring a token", () => {
    assert.equal(resolveTunnelOptions({}).transport, "portr");
    const resolved = resolveTunnelOptions({
      transport: "frp",
      frpPublicDomain: "https://demo.example.com/path",
      port: "8123",
    });
    assert.equal(resolved.transport, "frp");
    assert.deepEqual(resolved.frp, {
      publicDomain: "demo.example.com",
      server: "demo.example.com",
      serverPort: 443,
      protocol: "wss",
      proxyName: "demo",
      path: "/demo",
      stripPrefix: true,
      port: 8123,
      targetPort: 8123,
    });
  });

  it("resolves separate FRP and Portr domains for combined mode", () => {
    process.env.PORTR_TOKEN = "portr_test_token";
    const resolved = resolveTunnelOptions({
      transport: "both",
      publicDomain: "demo.apps.example.com",
      frpPublicDomain: "demo.frp.example.com",
      frpServer: "control.example.com",
      frpServerPort: "7443",
      frpProtocol: "wss",
      frpToken: "frp_test_token",
      frpProxyName: "demo-frp",
    });
    assert.equal(resolved.portr?.subdomain, "demo");
    assert.deepEqual(resolved.frp, {
      publicDomain: "demo.frp.example.com",
      server: "control.example.com",
      serverPort: 7443,
      protocol: "wss",
      token: "frp_test_token",
      proxyName: "demo-frp",
      path: "/demo-frp",
      stripPrefix: true,
      port: 8000,
      targetPort: 8000,
    });
    assert.deepEqual(resolved.gate.publicDomains, [
      "demo.apps.example.com",
      "demo.frp.example.com",
    ]);
  });

  it("rejects an unknown tunnel transport", () => {
    assert.throws(
      () => resolveTunnelOptions({ transport: "unknown" as "portr" }),
      /invalid tunnel transport/,
    );
  });

  it("passes the --bind interface list through, defaulting to empty (0.0.0.0)", () => {
    // Empty means the proxy applies its own 0.0.0.0 default; a list binds the
    // gate to exactly those interface IPs (loopback then reaches the upstream
    // ungated).
    assert.deepEqual(resolveTunnelOptions({}).bindHosts, []);
    assert.deepEqual(resolveTunnelOptions({ bind: ["10.147.0.5", "192.168.1.20"] }).bindHosts, [
      "10.147.0.5",
      "192.168.1.20",
    ]);
  });
});
