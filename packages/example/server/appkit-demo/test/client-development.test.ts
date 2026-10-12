import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import express from "express";
import {
  CLIENT_DEVELOPMENT_CONFIG_PATH,
  createClientDevelopmentProxy,
} from "../src/_client-development.ts";

const PROTECTED_HEADER = "x-test-protected";
const SESSION_COOKIE = "session=allowed";

let clientServer: Bun.Server<undefined>;
let appServer: Server;
let appUrl: string;

before(async () => {
  clientServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      const url = new URL(request.url);
      if (url.pathname === "/_bun/hmr" && server.upgrade(request)) return;
      return new Response("<!doctype html><html><body><main>client</main></body></html>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    websocket: {
      message: () => undefined,
    },
  });

  const app = express();
  const developmentProxy = createClientDevelopmentProxy(`http://127.0.0.1:${clientServer.port}`, {
    isProtectedHost: (headers) => headers.get(PROTECTED_HEADER) === "1",
    session: async (headers) =>
      headers.get("cookie")?.includes(SESSION_COOKIE) ? "user@databricks.com" : undefined,
  });
  developmentProxy.configure(app);
  app.use((request, response) => {
    if (request.path === CLIENT_DEVELOPMENT_CONFIG_PATH) {
      response.send(`<!doctype html><html><body>
        <script id="__appkit__" type="application/json">{"plugins":{"mastra":{"basePath":"/api/mastra"}}}</script>
        <script>window.__appkit__ = JSON.parse(document.getElementById("__appkit__")?.textContent || "{}");</script>
        <main>static</main>
      </body></html>`);
      return;
    }
    response.status(401).send("auth gate");
  });
  appServer = app.listen(0, "127.0.0.1");
  await once(appServer, "listening");
  developmentProxy.attach(appServer);
  appUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

after(async () => {
  await closeServer(appServer);
  await clientServer.stop(true);
});

describe("development client proxy", () => {
  it("leaves Chrome DevTools well-known probes for the AppKit server", async () => {
    const response = await fetch(`${appUrl}/.well-known/appspecific/com.chrome.devtools.json`, {
      headers: { Accept: "*/*" },
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "auth gate");
  });

  it("proxies local HTML requests", async () => {
    const response = await fetch(`${appUrl}/chat`, {
      headers: { Accept: "text/html" },
    });

    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<main>client<\/main>/);
    assert.match(html, /<script id="__appkit__"/);
    assert.match(html, /"basePath":"\/api\/mastra"/);
  });

  it("leaves protected HTML requests for the auth gate", async () => {
    const response = await fetch(`${appUrl}/chat`, {
      headers: { Accept: "text/html", [PROTECTED_HEADER]: "1" },
    });

    assert.equal(response.status, 401);
    assert.equal(await response.text(), "auth gate");
  });

  it("proxies authenticated protected HTML requests", async () => {
    const response = await fetch(`${appUrl}/chat`, {
      headers: {
        Accept: "text/html",
        Cookie: SESSION_COOKIE,
        [PROTECTED_HEADER]: "1",
      },
    });

    assert.equal(response.status, 200);
    assert.match(await response.text(), /"basePath":"\/api\/mastra"/);
  });

  it("proxies local HMR upgrades", async () => {
    assert.equal(await requestUpgrade(false), true);
  });

  it("rejects unauthenticated protected HMR upgrades", async () => {
    assert.equal(await requestUpgrade(true), false);
  });

  it("proxies authenticated protected HMR upgrades", async () => {
    assert.equal(await requestUpgrade(true, SESSION_COOKIE), true);
  });
});

function requestUpgrade(protectedHost: boolean, cookie?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (protectedHost) headers[PROTECTED_HEADER] = "1";
    if (cookie) headers.Cookie = cookie;
    const socket = new WebSocket(`${appUrl.replace("http:", "ws:")}/_bun/hmr`, {
      headers,
      perMessageDeflate: false,
    });
    let opened = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out waiting for HMR upgrade response"));
    }, 3_000);
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      socket.close();
      resolve(true);
    });
    socket.addEventListener("error", () => {
      if (opened) return;
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (!error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolve();
      else reject(error);
    });
  });
}
