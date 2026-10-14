import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { SshSession } from "@dbx-tools/lakebox/session";
import express from "express";
import { LakeboxRouteRegistry, type LakeboxRouteResolution } from "../src/routes.ts";
import { lakeboxUser } from "../src/user.ts";

const owner = lakeboxUser("owner@example.com", "/lakebox");
const other = lakeboxUser("other@example.com", "/lakebox");
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return (server.address() as { port: number }).port;
}

async function app(resolution: () => LakeboxRouteResolution): Promise<number> {
  const registry = new LakeboxRouteRegistry("/lakebox", {
    user: (headers: IncomingHttpHeaders) =>
      headers["x-forwarded-user"] === "owner@example.com" ? owner : undefined,
    resolve: async () => resolution(),
    unavailable: () => undefined,
  });
  closers.push(() => registry.close());
  const application = express();
  application.use(registry.middleware());
  application.use((_request, response) => response.status(418).end("next"));
  return listen(application);
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

describe("LakeboxRouteRegistry", () => {
  it("fails closed without identity or for another user's hash", async () => {
    const port = await app(() => ({ kind: "loading" }));
    assert.equal((await get(port, `/lakebox/${owner.hash}/terminal/`)).status, 404);
    const foreign = await get(port, `/lakebox/${other.hash}/terminal/`, {
      "x-forwarded-user": "owner@example.com",
    });
    assert.equal(foreign.status, 404);
    assert.equal((await get(port, "/unrelated")).status, 418);
  });

  it("redirects exact mounts and reports loading, failed, and missing services", async () => {
    let next: LakeboxRouteResolution = { kind: "loading" };
    const port = await app(() => next);
    const headers = { "x-forwarded-user": "owner@example.com" };
    const redirect = await get(port, `/lakebox/${owner.hash}/web?x=1`, headers);
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.location, `/lakebox/${owner.hash}/web/?x=1`);
    const loading = await get(port, `/lakebox/${owner.hash}/web/`, headers);
    assert.equal(loading.status, 202);
    assert.match(loading.body, /loading/);
    next = { kind: "failed", message: "boom" };
    assert.equal((await get(port, `/lakebox/${owner.hash}/web/`, headers)).status, 502);
    next = { kind: "missing" };
    assert.equal((await get(port, `/lakebox/${owner.hash}/web/`, headers)).status, 404);
  });

  it("forwards ready services through the session without identity headers", async () => {
    let seen: IncomingHttpHeaders = {};
    let seenPath = "";
    const servicePort = await listen((request, response) => {
      seen = request.headers;
      seenPath = request.url ?? "";
      response.end("service");
    });
    const session = {
      forwardOut: async (host: string, port: number) => connect({ host, port }),
    } as unknown as SshSession;
    const port = await app(() => ({
      kind: "ready",
      session,
      route: { port: servicePort, stripPrefix: true, redirectToSlash: true },
    }));
    const response = await get(port, `/lakebox/${owner.hash}/web/page?q=1`, {
      "x-forwarded-user": "owner@example.com",
      "x-forwarded-access-token": "secret",
      cookie: "session=1",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "service");
    assert.equal(seenPath, "/page?q=1");
    assert.equal(seen["x-forwarded-access-token"], undefined);
    assert.equal(seen.cookie, undefined);
  });
});
