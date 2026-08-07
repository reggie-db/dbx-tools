import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_COOKIE_NAME } from "@dbx-tools/shared-email";
import type { Request, RequestHandler, Response } from "express";
import { AUTH_PREFIX, isTunnelHost, mountGate, type GateOptions } from "../src/gate.ts";
import { mountGateOnContext, type AuthGateApi } from "../src/plugin.ts";

const PUBLIC_DOMAIN = "demo.apps.dbx.tools";

/** A gate API double: every session is valid iff a cookie value is present. */
function fakeGate(overrides: Partial<AuthGateApi> = {}): AuthGateApi {
  return {
    passkeysEnabled: true,
    handler: async () => new globalThis.Response("{}", { status: 200 }),
    session: async (headers) =>
      headers.get("cookie")?.includes(`${SESSION_COOKIE_NAME}=tok`)
        ? "user@example.com"
        : undefined,
    status: async (headers) => ({
      authenticated: Boolean(headers.get("cookie")),
      email: headers.get("cookie") ? "user@example.com" : undefined,
      enabled: true,
      passkeysEnabled: true,
    }),
    ...overrides,
  };
}

/** Capture what `mountGate` registers so tests can drive handlers directly. */
function mount(opts: Partial<GateOptions> = {}): {
  routes: Map<string, RequestHandler>;
  authMiddleware: RequestHandler;
  middleware: RequestHandler;
} {
  const routes = new Map<string, RequestHandler>();
  let authMiddleware: RequestHandler | undefined;
  let middleware: RequestHandler | undefined;
  mountGate(
    { gate: fakeGate(), publicDomain: PUBLIC_DOMAIN, ...opts },
    (method, path, handler) => routes.set(`${method} ${path}`, handler),
    (path, handler) => {
      if (path === AUTH_PREFIX) authMiddleware = handler;
      else middleware = handler;
    },
  );
  assert.ok(authMiddleware, "auth middleware was registered");
  assert.ok(middleware, "gate middleware was registered");
  return { routes, authMiddleware, middleware };
}

/** Minimal Express req/res doubles. */
function makeReq(host: string, url: string, cookie?: string): Request {
  return {
    url,
    headers: { host, ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: "127.0.0.1" },
    on: () => {},
  } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; jsonBody?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    jsonBody: undefined as unknown,
    setHeader() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res as unknown as Response & { statusCode?: number; jsonBody?: unknown };
}

describe("isTunnelHost", () => {
  it("matches the public domain (case-insensitive, port-stripped)", () => {
    assert.equal(isTunnelHost(makeReq("demo.apps.dbx.tools", "/"), PUBLIC_DOMAIN), true);
    assert.equal(isTunnelHost(makeReq("DEMO.APPS.DBX.TOOLS:443", "/"), PUBLIC_DOMAIN), true);
  });
  it("does not match localhost or the platform host", () => {
    assert.equal(isTunnelHost(makeReq("127.0.0.1:8000", "/"), PUBLIC_DOMAIN), false);
    assert.equal(isTunnelHost(makeReq("app.databricksapps.com", "/"), PUBLIC_DOMAIN), false);
  });
  it("matches nothing when no public domain is configured", () => {
    assert.equal(isTunnelHost(makeReq("demo.apps.dbx.tools", "/"), undefined), false);
  });
});

describe("gate middleware", () => {
  it("passes NON-tunnel traffic through untouched (platform / other local caller)", async () => {
    const { middleware } = mount();
    let nexted = false;
    const res = makeRes();
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq("127.0.0.1:8000", "/api/data"),
      res,
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, true);
    assert.equal(res.statusCode, undefined); // never short-circuited
  });

  it("401s tunnel /api/* without a session", async () => {
    const { middleware } = mount();
    let nexted = false;
    const res = makeRes();
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq(PUBLIC_DOMAIN, "/api/data"),
      res,
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
  });

  it("lets a tunnel /api/* with a valid session through, injecting identity", async () => {
    const { middleware } = mount();
    let nexted = false;
    const req = makeReq(PUBLIC_DOMAIN, "/api/data", `${SESSION_COOKIE_NAME}=tok`);
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      req,
      makeRes(),
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, true);
    // Identity injected for the app; gate cookie stripped.
    assert.equal(req.headers["x-forwarded-user"], "user@example.com");
    assert.equal(req.headers.cookie, undefined);
  });

  it("lets the login routes through on tunnel traffic (open)", async () => {
    const { middleware } = mount();
    let nexted = false;
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq(PUBLIC_DOMAIN, `${AUTH_PREFIX}/status`),
      makeRes(),
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, true);
  });

  it("lets tunnel STATIC (non-api) through so the SPA can render", async () => {
    const { middleware } = mount();
    let nexted = false;
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq(PUBLIC_DOMAIN, "/index.html"),
      makeRes(),
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, true);
  });

  it("registers one Better Auth middleware for every auth route", () => {
    const { routes, authMiddleware } = mount();
    assert.equal(routes.size, 0);
    assert.ok(authMiddleware);
  });

  it("reports the gate disabled on non-tunnel hosts", async () => {
    const { authMiddleware } = mount();
    const res = makeRes();
    await (authMiddleware as (req: Request, res: Response) => Promise<void>)(
      makeReq("127.0.0.1:6868", `${AUTH_PREFIX}/status`),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, {
      authenticated: false,
      enabled: false,
      passkeysEnabled: false,
    });
  });

  it("does not expose auth handlers on non-tunnel hosts", async () => {
    const { authMiddleware } = mount({
      gate: fakeGate({
        handler: async () => {
          throw new Error("gate method should not be called");
        },
      }),
    });

    for (const path of ["request", "verify", "logout"]) {
      const res = makeRes();
      await Promise.resolve(
        authMiddleware(makeReq("127.0.0.1:6868", `${AUTH_PREFIX}/${path}`), res, () => {}),
      );
      assert.equal(res.statusCode, 404);
    }
  });
});

describe("gate context mounting", () => {
  it("mounts directly on the deferred server app instead of the late route buffer", () => {
    const registrations: string[] = [];
    let buffered = false;
    const register = (method: string) => (path: string, _handler: RequestHandler) => {
      registrations.push(`${method} ${path}`);
    };

    mountGateOnContext(
      {
        getPlugins: () =>
          new Map([
            [
              "server",
              {
                serverApplication: {
                  get: register("get"),
                  post: register("post"),
                  use: register("use"),
                },
              },
            ],
          ]),
        addRoute: () => {
          buffered = true;
        },
        addMiddleware: () => {
          buffered = true;
        },
      },
      { gate: fakeGate(), publicDomain: PUBLIC_DOMAIN },
    );

    assert.equal(buffered, false);
    assert.deepEqual(registrations, [`use ${AUTH_PREFIX}`, "use /"]);
  });
});
