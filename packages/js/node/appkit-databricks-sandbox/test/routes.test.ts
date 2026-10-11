import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { createConnection } from "node:net";
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
      assert.equal(stripped.stripPrefix, true);
      assert.equal(preserved.stripPrefix, false);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/stripped/assets?q=1`).then((res) =>
          res.text(),
        ),
        "/assets?q=1",
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/preserved/assets?q=1`).then((res) =>
          res.text(),
        ),
        "/sandbox/preserved/assets?q=1",
      );
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("proxies owner-scoped browser aliases and WebSocket upgrades", async () => {
    let upgradedPath: string | undefined;
    let upgradeHandled = false;
    const remote = createHttpServer((request, response) => response.end(request.url));
    remote.on("upgrade", (request, socket) => {
      upgradedPath = request.url;
      socket.destroy();
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
        browserPaths: ["/api", "/ws"],
      });
      const root = await fetch(`http://127.0.0.1:${proxyPort}${route.path}`, {
        headers: { [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com" },
      });
      assert.equal(await root.text(), "/");
      const cookie = root.headers.getSetCookie()[0]?.split(";", 1)[0];
      assert.ok(cookie);
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/api/info`, {
          headers: {
            cookie,
            [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          },
        }).then((response) => response.text()),
        "/api/info",
      );
      await sendWebsocketUpgrade(proxyPort, "/ws/events", cookie);
      assert.equal(upgradeHandled, true);
      assert.equal(upgradedPath, "/ws/events");
    } finally {
      await registry.close();
      await close(proxy);
      await close(remote);
    }
  });

  it("serves execution-backed routes when an SSH socket is unavailable", async () => {
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
      await registry.addExecutor(
        {
          ownerId: "user-123",
          machineId: "sandbox-1",
          remoteHost: "127.0.0.1",
          remotePort: 8080,
          path: "/sandbox/executed",
        },
        async ({ url }) => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: new TextEncoder().encode(url),
        }),
      );
      assert.equal(
        await fetch(`http://127.0.0.1:${proxyPort}/sandbox/executed/asset?q=1`, {
          headers: {
            [USER_ID_HEADER]: "user-123",
            [USER_EMAIL_HEADER]: "reggie.pierce@databricks.com",
          },
        }).then((res) => res.text()),
        "/asset?q=1",
      );
    } finally {
      await registry.close();
      await close(proxy);
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function sendWebsocketUpgrade(port: number, path: string, cookie: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 100);
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
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: ZGJ4LXRvb2xzLXRlc3Q=",
          `Cookie: ${cookie}`,
          `${USER_EMAIL_HEADER}: reggie.pierce@databricks.com`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", () => {
      clearTimeout(timer);
      resolve();
      socket.destroy();
    });
  });
}
