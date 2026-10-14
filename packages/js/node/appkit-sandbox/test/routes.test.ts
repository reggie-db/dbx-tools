import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { createConnection, type Server as NetServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import { USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { SshRouteRegistry } from "../src/routes.ts";
import type { SshSession } from "../src/session.ts";

const unusedSession = { forwardOut: async () => assert.fail("not used") } as unknown as SshSession;

describe("SshRouteRegistry", () => {
  it("allocates and removes a route beneath the configured prefix", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    try {
      const route = await registry.add(unusedSession, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      assert.equal(route.path, "/sandbox/22padc/sandbox-1-3000");
      assert.equal(route.stripPrefix, true);
      assert.deepEqual(registry.list("sandbox-1", "reggie.pierce@databricks.com"), [route]);
      assert.deepEqual(registry.list("sandbox-1", "other@databricks.com"), []);
      const otherRoute = await registry.add(unusedSession, {
        ownerId: "other@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      });
      assert.equal(otherRoute.path, "/sandbox/1g9rdt/sandbox-1-3000");
      assert.equal(await registry.remove(route.id, "other@databricks.com"), false);
      assert.equal(await registry.remove(route.id, "reggie.pierce@databricks.com"), true);
      assert.equal(await registry.remove(route.id), false);
      assert.deepEqual(registry.list("sandbox-1"), [otherRoute]);
      await registry.removeMachine("sandbox-1");
      assert.deepEqual(registry.list("sandbox-1"), []);
    } finally {
      await registry.close();
    }
  });

  it("starts dormant routes and returns browser or JSON loading responses", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    let activationCount = 0;
    let finishActivation!: () => void;
    const activation = new Promise<void>((resolve) => {
      finishActivation = resolve;
    });
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.addWakeRoute(
        {
          id: "project-1",
          ownerId: "reggie.pierce@databricks.com",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          path: "/hello",
        },
        async () => {
          activationCount += 1;
          await activation;
        },
      );
      const headers = { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" };
      const browser = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: { ...headers, accept: "text/html" },
      });
      assert.equal(browser.status, 202);
      assert.match(await browser.text(), /Starting Sandbox project/);
      const api = await fetch(`http://127.0.0.1:${proxyPort}${route.path}/api`, {
        headers: { ...headers, accept: "application/json" },
      });
      assert.equal(api.status, 202);
      assert.deepEqual(await api.json(), {
        status: "loading",
        message: "Starting Sandbox project",
      });
      assert.equal(activationCount, 1);
      finishActivation();
    } finally {
      finishActivation();
      await close(proxy);
      await registry.close();
    }
  });

  it("preserves wake routes when a machine deactivates and removes them with the machine", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    let activationCount = 0;
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const input = {
        id: "project-1",
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: "/hello",
      } as const;
      const route = await registry.addWakeRoute(input, async () => {
        activationCount += 1;
      });
      await registry.add(unusedSession, input);
      await registry.deactivateMachine("sandbox-1", "reggie.pierce@databricks.com");

      const loading = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(loading.status, 202);
      assert.equal(activationCount, 1);

      await registry.removeMachine("sandbox-1", "reggie.pierce@databricks.com");
      const removed = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(removed.status, 404);
    } finally {
      await close(proxy);
      await registry.close();
    }
  });

  it("returns loading and starts recovery when an active project proxy is offline", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    let activationCount = 0;
    const session = {
      forwardOut: async () => {
        throw new Error("project is offline");
      },
    } as unknown as SshSession;
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const input = {
        id: "project-1",
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: "/hello",
      } as const;
      const route = await registry.addWakeRoute(input, async () => {
        activationCount += 1;
      });
      await registry.add(session, input);

      const loading = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: {
          [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          accept: "application/json",
        },
      });
      assert.equal(loading.status, 202);
      assert.deepEqual(await loading.json(), {
        status: "loading",
        message: "Starting Sandbox project",
      });
      assert.equal(activationCount, 1);
    } finally {
      await close(proxy);
      await registry.close();
    }
  });

  it("rejects route creation after shutdown and closes a racing bridge", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    const add = registry.add(unusedSession, {
      ownerId: "reggie.pierce@databricks.com",
      machineId: "sandbox-1",
      remoteHost: "127.0.0.1",
      remotePort: 3000,
    });
    const close = registry.close();

    await assert.rejects(add, /registry is closed/);
    await close;
    await assert.rejects(
      registry.add(unusedSession, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
      }),
      /registry is closed/,
    );
    assert.deepEqual(registry.list(), []);
  });

  it("serializes concurrent route publication and rejects duplicate ids", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    try {
      const first = await registry.add(unusedSession, {
        id: "shared-id",
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: "/first",
      });
      await assert.rejects(
        registry.add(unusedSession, {
          id: "shared-id",
          ownerId: "reggie.pierce@databricks.com",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 3001,
          path: "/second",
        }),
        /id shared-id is already registered/,
      );
      assert.deepEqual(registry.list(), [first]);
    } finally {
      await registry.close();
    }
  });

  it("strips non-root paths by default and preserves them when disabled", async () => {
    const remote = createHttpServer((request, response) => response.end(request.url));
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const inboundUrls: string[] = [];
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
      inboundUrls.push(request.url ?? "");
    });
    const proxyPort = await listen(proxy);
    try {
      const pathPrefix = registry.userPathPrefix("reggie.pierce@databricks.com");
      const stripped = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/stripped",
      });
      const preserved = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/preserved",
        stripPrefix: false,
      });
      await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/internal/test",
        internal: true,
      });
      const redirected = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/redirected",
        redirectToSlash: true,
      });
      assert.equal(stripped.stripPrefix, true);
      assert.equal(preserved.stripPrefix, false);
      assert.deepEqual(
        registry.list("sandbox-1", "reggie.pierce@databricks.com").map((route) => route.path),
        [`${pathPrefix}/stripped`, `${pathPrefix}/preserved`, `${pathPrefix}/redirected`],
      );
      assert.deepEqual(
        registry
          .list("sandbox-1", "reggie.pierce@databricks.com", { includeInternal: true })
          .map((route) => route.path),
        [
          `${pathPrefix}/stripped`,
          `${pathPrefix}/preserved`,
          "/internal/test",
          `${pathPrefix}/redirected`,
        ],
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${stripped.path}/assets?q=1`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((res) => res.text()),
        "/assets?q=1",
      );
      assert.ok(inboundUrls.includes(`${stripped.path}/assets?q=1`), inboundUrls.join(","));
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${preserved.path}/assets?q=1`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((res) => res.text()),
        `${preserved.path}/assets?q=1`,
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${stripped.path}/local`).then((res) =>
          res.text(),
        ),
        "/local",
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${stripped.path}/public`, {
          headers: { host: "local-demo.apps.dbx.tools" },
        }).then((response) => response.status),
        404,
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${stripped.path}`, {
          headers: { [USER_EMAIL_HEADER]: "other@databricks.com" },
        }).then(async (response) => `${response.status}:${await response.text()}`),
        "404:Not Found",
      );
      const redirect = await fetch(`http://127.0.0.1:${proxyPort}${redirected.path}`, {
        redirect: "manual",
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(redirect.status, 308);
      assert.equal(redirect.headers.get("location"), `${redirected.path}/`);
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("keeps one internal machine-service route for the sole owner", async () => {
    const remote = createHttpServer((_request, response) => response.end("ready"));
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    const path = "/sandbox/desktop/sandbox-1";
    const ownerExpirations = {
      "owner@databricks.com": Date.now() + 30 * 24 * 60 * 60 * 1_000,
    };
    const authorizeOwner = async (ownerId: string) => ownerId === "owner@databricks.com";
    try {
      const route = await registry.add(session, {
        ownerId: "owner@databricks.com",
        ownerExpirations,
        authorizeOwner,
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path,
        internal: true,
      });
      assert.deepEqual(
        registry.list("sandbox-1", "owner@databricks.com", { includeInternal: true }),
        [route],
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${path}/`, {
          headers: { [USER_EMAIL_HEADER]: "owner@databricks.com" },
        }).then((response) => response.text()),
        "ready",
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${path}/`).then((response) => response.status),
        200,
      );
      let replacementForwards = 0;
      const replacementSession = {
        forwardOut: async () => {
          replacementForwards += 1;
          return createConnection(remotePort, "127.0.0.1");
        },
      } as unknown as SshSession;
      assert.equal(
        await registry.add(replacementSession, {
          ownerId: "owner@databricks.com",
          ownerExpirations,
          authorizeOwner,
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort,
          path,
          internal: true,
        }),
        route,
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${path}/`, {
          headers: { [USER_EMAIL_HEADER]: "owner@databricks.com" },
        }).then((response) => response.text()),
        "ready",
      );
      assert.equal(replacementForwards, 1);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${path}/`, {
          headers: { [USER_EMAIL_HEADER]: "collaborator@databricks.com" },
        }).then((response) => response.status),
        404,
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${path}/`, {
          headers: { [USER_EMAIL_HEADER]: "other@databricks.com" },
        }).then((response) => response.status),
        404,
      );
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("injects route-owned HTML head content only into the service document", async () => {
    const remote = createHttpServer((request, response) => {
      response.setHeader(
        "content-type",
        request.url === "/asset.js" ? "text/javascript" : "text/html",
      );
      response.end(
        request.url === "/asset.js"
          ? "console.log('asset')"
          : "<!doctype html><html><head><title>Service</title></head><body>Ready</body></html>",
      );
    });
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/metrics/sandbox-1",
        stripPrefix: true,
        htmlHead: '<style id="viewport">html{height:100dvh}</style>',
        internal: true,
      });
      const headers = { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" };
      const document = await fetch(`http://127.0.0.1:${proxyPort}/sandbox/metrics/sandbox-1/`, {
        headers,
      });
      assert.equal(document.status, 200);
      assert.match(
        await document.text(),
        /<head><style id="viewport">html\{height:100dvh\}<\/style><title>Service<\/title>/,
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/metrics/sandbox-1/asset.js`, {
          headers,
        }).then((response) => response.text()),
        "console.log('asset')",
      );
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("replays JSON bodies consumed by AppKit before proxying", async () => {
    const remote = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => response.end(Buffer.concat(chunks)));
    });
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const proxy = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        Object.assign(request, {
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          path: url.pathname,
          header: (name: string) => request.headers[name.toLowerCase()],
        });
        registry.middleware()(request as never, response as never, () => {
          response.statusCode = 404;
          response.end();
        });
      });
    });
    const proxyPort = await listen(proxy);
    try {
      await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/terminal/sandbox-1",
        internal: true,
      });
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/sandbox/terminal/sandbox-1/api/tabs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          },
          body: JSON.stringify({ title: "Shell" }),
        },
      );
      assert.deepEqual(await response.json(), { title: "Shell" });
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("proxies owner-scoped HTTP and WebSocket traffic", async () => {
    let upgradedPath: string | undefined;
    let upgradedHeaders: IncomingHttpHeaders | undefined;
    let upgradeHandled = false;
    const remote = createHttpServer((request, response) => {
      response.end(
        request.url === "/"
          ? "<!doctype html><html><head></head><body></body></html>"
          : request.url,
      );
    });
    remote.on("upgrade", (request, socket, head) => {
      upgradedPath = request.url;
      upgradedHeaders = request.headers;
      const accept = createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Accept: ${accept}`,
          "Sec-WebSocket-Protocol: binary",
          "",
          "",
        ].join("\r\n"),
      );
      if (head.length > 0) socket.unshift(head);
    });
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => {
        return createConnection(remotePort, "127.0.0.1");
      },
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const proxy = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      Object.assign(request, {
        path: url.pathname,
        header: (name: string) => request.headers[name.toLowerCase()],
      });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    proxy.on("upgrade", async (request, socket, head) => {
      upgradeHandled = await registry.handleUpgrade(request, socket, head);
      if (!upgradeHandled) socket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/terminal/sandbox-1",
        internal: true,
      });
      const root = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(root.status, 200);
      assert.match(await root.text(), /<!doctype html>/);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/assets/app.js`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((response) => response.text()),
        "/assets/app.js",
      );
      const upgradeResponse = await sendWebsocketUpgrade(proxyPort, `${route.path}/ws/events`);
      assert.equal(upgradeHandled, true);
      assert.equal(upgradedPath, "/ws/events");
      assert.equal(upgradedHeaders?.authorization, undefined);
      assert.equal(upgradedHeaders?.cookie, undefined);
      assert.equal(upgradedHeaders?.origin, `http://127.0.0.1:${remotePort}`);
      assert.equal(upgradedHeaders?.["sec-websocket-protocol"], "binary");
      assert.equal(upgradedHeaders?.[USER_EMAIL_HEADER], undefined);
      assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/);
      await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        ownerExpirations: {
          "reggie.pierce@databricks.com": Date.now() + 300,
        },
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/terminal/sandbox-1",
        internal: true,
      });
      const expiringSocket = await openWebsocketUpgrade(proxyPort, `${route.path}/ws/expiring`);
      const replacementSession = {
        forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
      } as unknown as SshSession;
      let originalSessionDrained = false;
      const originalSessionDrain = registry.whenSessionDrained(session).then(() => {
        originalSessionDrained = true;
      });
      assert.equal(
        await Promise.race([
          registry.add(replacementSession, {
            ownerId: "reggie.pierce@databricks.com",
            ownerExpirations: {
              "reggie.pierce@databricks.com": Date.now() + 300,
            },
            machineId: "sandbox-1",
            remoteHost: "127.0.0.1",
            remotePort,
            path: "/sandbox/terminal/sandbox-1",
            internal: true,
          }),
          new Promise<undefined>((resolve) => setTimeout(resolve, 100)),
        ]),
        route,
      );
      assert.equal(originalSessionDrained, false);
      assert.equal(
        await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            expiringSocket.destroy();
            resolve("timeout");
          }, 1_000);
          expiringSocket.once("close", () => {
            clearTimeout(timer);
            resolve("closed");
          });
        }),
        "closed",
      );
      await originalSessionDrain;
      assert.equal(originalSessionDrained, true);
      assert.equal(
        await sendWebsocketUpgrade(proxyPort, "/sandbox/terminal/stale/ws/events"),
        "closed",
      );
      assert.equal(upgradeHandled, false);
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("returns 504 when an SSH forwarding channel never becomes responsive", async () => {
    const session = {
      forwardOut: () => new Promise<Duplex>(() => undefined),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox", 10);
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 61208,
        path: "/sandbox/metrics/sandbox-1",
        internal: true,
      });

      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((response) => response.status),
        504,
      );
    } finally {
      await registry.close();
      await close(proxy);
    }
  });

  it("does not treat slow application responses as forwarding setup failures", async () => {
    const remote = createHttpServer((_request, response) => {
      setTimeout(() => response.end("ready"), 30);
    });
    const remotePort = await listen(remote);
    const session = {
      forwardOut: async () => createConnection(remotePort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox", 10);
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/metrics/sandbox-1",
        internal: true,
      });

      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((response) => response.text()),
        "ready",
      );
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("returns 502 for a failed forwarding open without removing the route", async () => {
    const remote = createHttpServer((_request, response) => response.end("ready"));
    const remotePort = await listen(remote);
    let attempts = 0;
    const session = {
      forwardOut: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("SSH forwarding connection closed");
        return createConnection(remotePort, "127.0.0.1");
      },
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    const proxy = createHttpServer((request, response) => {
      Object.defineProperty(request, "path", {
        configurable: true,
        get: () => new URL(request.url ?? "/", "http://localhost").pathname,
      });
      Object.assign(request, { header: (name: string) => request.headers[name.toLowerCase()] });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/metrics/sandbox-1",
        internal: true,
      });
      const headers = { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" };

      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/`, { headers }).then(
          (response) => response.status,
        ),
        502,
      );
      assert.deepEqual(
        registry.list("sandbox-1", "reggie.pierce@databricks.com", { includeInternal: true }),
        [route],
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/`, { headers }).then((response) =>
          response.text(),
        ),
        "ready",
      );
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("returns 502 when the WebSocket upstream is down without crashing the process", async () => {
    const unhandled: unknown[] = [];
    const recordUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("uncaughtException", recordUnhandled);
    process.on("unhandledRejection", recordUnhandled);
    const unused = createHttpServer();
    const unusedPort = await listen(unused);
    await close(unused);
    const session = {
      forwardOut: async () => createConnection(unusedPort, "127.0.0.1"),
    } as unknown as SshSession;
    const registry = new SshRouteRegistry("/sandbox");
    let upgradeHandled = false;
    const proxy = createHttpServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      Object.assign(request, {
        path: url.pathname,
        header: (name: string) => request.headers[name.toLowerCase()],
      });
      registry.middleware()(request as never, response as never, () => {
        response.statusCode = 404;
        response.end();
      });
    });
    proxy.on("upgrade", async (request, socket, head) => {
      upgradeHandled = await registry.handleUpgrade(request, socket, head);
      if (!upgradeHandled) socket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: unusedPort,
        path: "/sandbox/terminal/sandbox-1",
        internal: true,
      });
      const upgradeResponse = await sendWebsocketUpgrade(proxyPort, `${route.path}/ws/sync`);
      assert.equal(upgradeHandled, true);
      assert.ok(
        upgradeResponse === "closed" || /^HTTP\/1\.1 502 /.test(upgradeResponse),
        upgradeResponse,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("uncaughtException", recordUnhandled);
      process.off("unhandledRejection", recordUnhandled);
      await registry.close();
      await close(proxy);
    }
  });

  it("scopes paths beneath the user namespace and rejects other full prefixes", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    try {
      const route = await registry.add(unusedSession, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: "/hello-world",
      });
      assert.equal(route.path, "/sandbox/22padc/hello-world");
      await assert.rejects(
        registry.add(unusedSession, {
          ownerId: "reggie.pierce@databricks.com",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          path: "/sandbox/1g9rdt/hello-world",
        }),
        /must be beneath \/sandbox\/22padc/,
      );
      await assert.rejects(
        registry.add(unusedSession, {
          ownerId: "reggie.pierce@databricks.com",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          path: "/api/admin",
        }),
        /cannot overlap/,
      );
    } finally {
      await registry.close();
    }
  });
});

async function listen(server: HttpServer | NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return address.port;
}

async function close(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function sendWebsocketUpgrade(
  port: number,
  path: string,
  cookie?: string,
  includeOwner = true,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      resolve("timeout");
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve("closed");
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Origin: http://127.0.0.1",
          "Sec-Fetch-Site: same-origin",
          "Authorization: Bearer front-door-token",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: binary",
          ...(cookie ? [`Cookie: ${cookie}`] : []),
          ...(includeOwner ? [`${USER_EMAIL_HEADER}: reggie.pierce@databricks.com`] : []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
      socket.destroy();
    });
  });
}

function openWebsocketUpgrade(port: number, path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("WebSocket upgrade timed out"));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Origin: http://127.0.0.1",
          "Sec-Fetch-Site: same-origin",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: binary",
          `${USER_EMAIL_HEADER}: reggie.pierce@databricks.com`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}
