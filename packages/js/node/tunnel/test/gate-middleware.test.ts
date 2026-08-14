import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SESSION_COOKIE_NAME } from "@dbx-tools/shared-auth";
import type { Request, RequestHandler, Response } from "express";
import {
  AUTH_PREFIX,
  isTunnelHost,
  mountGate,
  normalizeReturnTo,
  webHeaders,
  type GateOptions,
} from "../src/gate.ts";
import { loginPageHtml } from "../src/login-page.ts";
import { mountGateOnContext, type AuthGateApi } from "../src/plugin.ts";

const PUBLIC_DOMAIN = "demo.apps.dbx.tools";

describe("isTunnelHost", () => {
  it("accepts any configured public tunnel domain", () => {
    const request = makeReq("demo.frp.example.com:443", "/");
    assert.equal(isTunnelHost(request, ["demo.apps.dbx.tools", "demo.frp.example.com"]), true);
    assert.equal(isTunnelHost(request, ["demo.apps.dbx.tools"]), false);
  });
});

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
    close: async () => undefined,
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
    originalUrl: url,
    headers: { host, ...(cookie ? { cookie } : {}) },
    socket: { remoteAddress: "127.0.0.1" },
    on: () => {},
  } as unknown as Request;
}

function makeRes(): Response & { statusCode?: number; jsonBody?: unknown; sentBody?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    jsonBody: undefined as unknown,
    sentBody: undefined as unknown,
    setHeader() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
    type() {
      return res;
    },
    send(body: unknown) {
      res.sentBody = body;
      return res;
    },
  };
  return res as unknown as Response & {
    statusCode?: number;
    jsonBody?: unknown;
    sentBody?: unknown;
  };
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

describe("Better Auth request headers", () => {
  it("supplies the nearest trusted client IP instead of an inbound claim", () => {
    const request = makeReq(PUBLIC_DOMAIN, "/");
    request.headers["x-forwarded-for"] = "spoofed, 203.0.113.8";
    assert.equal(webHeaders(request).get("x-real-ip"), "203.0.113.8");
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
    assert.deepEqual(res.jsonBody, {
      error: "authentication required",
      loginPath: `${AUTH_PREFIX}?returnTo=%2F`,
    });
  });

  it("preserves the same-origin referring page for an API login", async () => {
    const { middleware } = mount();
    const res = makeRes();
    const req = makeReq(PUBLIC_DOMAIN, "/api/data");
    req.headers.referer = `https://${PUBLIC_DOMAIN}/reports/weekly?team=data`;

    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      req,
      res,
      () => {},
    );

    assert.deepEqual(res.jsonBody, {
      error: "authentication required",
      loginPath: `${AUTH_PREFIX}?returnTo=${encodeURIComponent("/reports/weekly?team=data")}`,
    });
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

  it("gates a `gatePaths` prefix (e.g. /ws) without a session", async () => {
    const { middleware } = mount({ gatePaths: ["/ws"] });
    let nexted = false;
    const res = makeRes();
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq(PUBLIC_DOMAIN, "/ws"),
      res,
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonBody, {
      error: "authentication required",
      loginPath: `${AUTH_PREFIX}?returnTo=%2F`,
    });
  });

  it("lets a `gatePaths` prefix through with a valid session", async () => {
    const { middleware } = mount({ gatePaths: ["/ws"] });
    let nexted = false;
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      makeReq(PUBLIC_DOMAIN, "/ws", `${SESSION_COOKIE_NAME}=tok`),
      makeRes(),
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, true);
  });

  it("in app-gating mode, denies an unauthenticated browser navigation (for the login page)", async () => {
    const { middleware } = mount({ gatePaths: ["/ws"] });
    let nexted = false;
    const res = makeRes();
    const req = makeReq(PUBLIC_DOMAIN, "/");
    req.headers.accept = "text/html";
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      req,
      res,
      () => {
        nexted = true;
      },
    );
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 401);
    assert.match(String(res.sentBody), /Sign in — Databricks App/);
    assert.match(String(res.sentBody), /var RETURN_TO = "\/"/);
    assert.match(String(res.sentBody), /window\.location\.replace\(RETURN_TO\)/);
  });

  it("preserves a deep navigation path through hosted login", async () => {
    const { middleware } = mount({ gatePaths: ["/ws"] });
    const res = makeRes();
    const req = makeReq(PUBLIC_DOMAIN, "/reports/weekly?team=data");
    req.headers.accept = "text/html";

    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      req,
      res,
      () => {},
    );

    assert.equal(res.statusCode, 401);
    assert.match(String(res.sentBody), /var RETURN_TO = "\/reports\/weekly\?team=data"/);
  });

  it("serves a dedicated login URL with a validated return path", async () => {
    const { authMiddleware } = mount();
    const res = makeRes();
    const req = makeReq(
      PUBLIC_DOMAIN,
      `${AUTH_PREFIX}?returnTo=${encodeURIComponent("/reports/weekly?team=data")}`,
    );
    req.headers.accept = "text/html";

    await Promise.resolve(authMiddleware(req, res, () => {}));

    assert.equal(res.statusCode, 200);
    assert.match(String(res.sentBody), /var RETURN_TO = "\/reports\/weekly\?team=data"/);
  });

  it("escapes a return path before embedding it in the login script", async () => {
    const { authMiddleware } = mount();
    const res = makeRes();
    const req = makeReq(
      PUBLIC_DOMAIN,
      `${AUTH_PREFIX}?returnTo=${encodeURIComponent("/</script><script>alert(1)</script>")}`,
    );
    req.headers.accept = "text/html";

    await Promise.resolve(authMiddleware(req, res, () => {}));

    assert.doesNotMatch(String(res.sentBody), /var RETURN_TO = "\/<\/script>/);
    assert.match(String(res.sentBody), /var RETURN_TO = "\/%3C/);
  });

  it("without gatePaths, static still passes (self-protecting SPA model)", async () => {
    const { middleware } = mount();
    let nexted = false;
    const req = makeReq(PUBLIC_DOMAIN, "/");
    req.headers.accept = "text/html";
    await (middleware as (r: Request, s: Response, n: () => void) => Promise<void>)(
      req,
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

describe("login return paths", () => {
  it("accepts same-origin paths and rejects external redirects", () => {
    assert.equal(normalizeReturnTo("/reports/weekly?team=data"), "/reports/weekly?team=data");
    assert.equal(normalizeReturnTo("https://example.com/reports"), "/");
    assert.equal(normalizeReturnTo("//example.com/reports"), "/");
    assert.equal(normalizeReturnTo("/\\example.com"), "/");
  });

  it("escapes direct login-page values for an inline script", () => {
    const html = loginPageHtml({
      brandName: "Example",
      returnTo: "/</script><script>alert(1)</script>",
    });
    assert.doesNotMatch(html, /var RETURN_TO = "\/<\/script>/);
    assert.match(html, /var RETURN_TO = "\/\\u003c/);
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
