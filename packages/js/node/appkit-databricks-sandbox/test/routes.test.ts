import assert from "node:assert/strict";
import {
  createServer as createHttpServer,
  type IncomingHttpHeaders,
  type Server as HttpServer,
} from "node:http";
import { createConnection, type Server as NetServer } from "node:net";
import { describe, it } from "node:test";
import { USER_EMAIL_HEADER, USER_ID_HEADER } from "@dbx-tools/appkit";
import { WebSocketServer } from "ws";
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
      assert.equal(route.path, "/sandbox/sandbox-1-3000");
      assert.equal(route.stripPrefix, true);
      assert.deepEqual(registry.list("sandbox-1", "reggie.pierce@databricks.com"), [route]);
      assert.deepEqual(registry.list("sandbox-1", "other@databricks.com"), []);
      await assert.rejects(
        registry.add(unusedSession, {
          ownerId: "other@databricks.com",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 3000,
        }),
        /owned by another user/,
      );
      assert.equal(await registry.remove(route.id, "other@databricks.com"), false);
      assert.equal(await registry.remove(route.id, "reggie.pierce@databricks.com"), true);
      assert.equal(await registry.remove(route.id), false);
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
    const proxyPort = await listen(proxy);
    try {
      const stripped = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/stripped",
      });
      const preserved = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/preserved",
        stripPrefix: false,
      });
      const redirected = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/redirected",
        redirectToSlash: true,
      });
      assert.equal(stripped.stripPrefix, true);
      assert.equal(preserved.stripPrefix, false);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/stripped/assets?q=1`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((res) => res.text()),
        "/assets?q=1",
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/preserved/assets?q=1`, {
          headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
        }).then((res) => res.text()),
        "/sandbox/preserved/assets?q=1",
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

  it("injects route-owned HTML head content only into the service document", async () => {
    const remote = createHttpServer((request, response) => {
      response.setHeader("content-type", request.url === "/asset.js" ? "text/javascript" : "text/html");
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
    const proxyPort = await listen(proxy);
    try {
      await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/sandbox-1/stats",
        stripPrefix: true,
        htmlHead: '<style id="viewport">html{height:100dvh}</style>',
      });
      const headers = { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" };
      const document = await fetch(
        `http://127.0.0.1:${proxyPort}/sandbox/sandbox-1/stats/`,
        { headers },
      );
      assert.equal(document.status, 200);
      assert.match(await document.text(), /<style id="viewport">html\{height:100dvh\}<\/style><\/head>/);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/sandbox-1/stats/asset.js`, {
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
        path: "/sandbox/sandbox-1/terminal",
      });
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/sandbox/sandbox-1/terminal/api/tabs`,
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

  it("proxies owner-scoped browser aliases and WebSocket upgrades", async () => {
    let upgradedPath: string | undefined;
    let upgradedHeaders: IncomingHttpHeaders | undefined;
    let upgradeHandled = false;
    const remote = createHttpServer((request, response) => response.end(request.url));
    const remoteWebSockets = new WebSocketServer({ noServer: true });
    remote.on("upgrade", (request, socket, head) => {
      upgradedPath = request.url;
      upgradedHeaders = request.headers;
      remoteWebSockets.handleUpgrade(request, socket, head, (client) => client.send("ready"));
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
    proxy.on("upgrade", (request, socket, head) => {
      upgradeHandled = registry.handleUpgrade(request, socket, head);
      if (!upgradeHandled) socket.destroy();
    });
    const proxyPort = await listen(proxy);
    try {
      const route = await registry.add(session, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort,
        path: "/sandbox/sandbox-1/terminal",
        browserRelay: true,
        browserPaths: ["/api", "/ws"],
      });
      const root = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        redirect: "manual",
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(root.status, 200);
      const bootstrap = await root.text();
      assert.match(bootstrap, /dinotty_device_active_server_v1/);
      assert.match(bootstrap, new RegExp(route.id));
      const cookie = root.headers.getSetCookie()[0]?.split(";", 1)[0];
      assert.ok(cookie);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}${route.path}/`, {
          headers: {
            cookie,
            [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          },
        }).then((response) => response.text()),
        "/",
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/api/info`, {
          headers: {
            cookie,
            [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          },
        }).then((response) => response.text()),
        "/api/info",
      );
      const upgradeResponse = await sendWebsocketUpgrade(
        proxyPort,
        `/__srv/${route.id}/ws/events`,
        "front-door=session",
        false,
      );
      assert.equal(upgradeHandled, true);
      assert.equal(upgradedPath, "/ws/events");
      assert.equal(upgradedHeaders?.authorization, undefined);
      assert.equal(upgradedHeaders?.cookie, undefined);
      assert.equal(upgradedHeaders?.origin, undefined);
      assert.equal(upgradedHeaders?.[USER_EMAIL_HEADER], undefined);
      assert.match(upgradeResponse, /^HTTP\/1\.1 101 Switching Protocols/);
    } finally {
      await registry.close();
      remoteWebSockets.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("scopes paths beneath the Sandbox namespace and rejects API overlap", async () => {
    const registry = new SshRouteRegistry("/sandbox");
    try {
      const route = await registry.add(unusedSession, {
        ownerId: "reggie.pierce@databricks.com",
        machineId: "sandbox-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        path: "/hello-world",
      });
      assert.equal(route.path, "/sandbox/hello-world");
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
          `${USER_EMAIL_HEADER}: reggie.pierce@databricks.com`,
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
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
