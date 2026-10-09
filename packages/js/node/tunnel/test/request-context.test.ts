import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, it } from "node:test";

import {
  requestTunnelTraceTags,
  TUNNEL_SUBDOMAIN_TRACE_TAG,
  TUNNEL_TRACE_TAG,
} from "../src/request-context.ts";

const ENV_KEYS = [
  "FRP_PROXY_NAME",
  "PORTR_SERVER",
  "PORTR_TOKEN",
  "TUNNEL_FRP_PUBLIC_DOMAIN",
  "TUNNEL_PUBLIC_DOMAIN",
  "TUNNEL_TRANSPORT",
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(host: string, remoteAddress = "127.0.0.1"): IncomingMessage {
  return { headers: { host }, socket: { remoteAddress } } as IncomingMessage;
}

describe("request tunnel trace tags", () => {
  it("identifies Portr requests and their subdomain", () => {
    process.env.TUNNEL_TRANSPORT = "portr";
    process.env.PORTR_TOKEN = "secret";
    process.env.TUNNEL_PUBLIC_DOMAIN = "demo.apps.dbx.tools";

    assert.deepEqual(requestTunnelTraceTags(request("demo.apps.dbx.tools")), {
      [TUNNEL_TRACE_TAG]: "portr",
      [TUNNEL_SUBDOMAIN_TRACE_TAG]: "demo",
    });
    assert.deepEqual(requestTunnelTraceTags(request("localhost:8000")), {});
    assert.deepEqual(requestTunnelTraceTags(request("demo.apps.dbx.tools", "203.0.113.8")), {});
  });

  it("identifies FRP requests and their public subdomain", () => {
    process.env.TUNNEL_TRANSPORT = "frp";
    process.env.TUNNEL_FRP_PUBLIC_DOMAIN = "reports.example.com";
    process.env.FRP_PROXY_NAME = "reports-app";

    assert.deepEqual(requestTunnelTraceTags(request("reports.example.com:443")), {
      [TUNNEL_TRACE_TAG]: "frp",
      [TUNNEL_SUBDOMAIN_TRACE_TAG]: "reports",
    });
  });

  it("accepts IPv4-mapped and IPv6 loopback tunnel clients", () => {
    process.env.TUNNEL_TRANSPORT = "portr";
    process.env.PORTR_TOKEN = "secret";
    process.env.TUNNEL_PUBLIC_DOMAIN = "demo.apps.dbx.tools";

    assert.deepEqual(requestTunnelTraceTags(request("demo.apps.dbx.tools", "::ffff:127.0.0.1")), {
      [TUNNEL_TRACE_TAG]: "portr",
      [TUNNEL_SUBDOMAIN_TRACE_TAG]: "demo",
    });
    assert.deepEqual(requestTunnelTraceTags(request("demo.apps.dbx.tools", "::1")), {
      [TUNNEL_TRACE_TAG]: "portr",
      [TUNNEL_SUBDOMAIN_TRACE_TAG]: "demo",
    });
  });
});
