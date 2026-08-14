import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import ProxyModule from "http-proxy-3";

function stripPathPrefix(request: IncomingMessage, prefix: string): void {
  if (prefix === "/") return;
  const url = request.url ?? "/";
  if (url === prefix) request.url = "/";
  else if (url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
    request.url = url.slice(prefix.length) || "/";
  }
}

export async function startPathProxy(
  appPort: number,
  path: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const proxy = ProxyModule.createProxyServer({
    target: `http://127.0.0.1:${appPort}`,
    ws: true,
    xfwd: true,
  });
  const server = createServer((request, response) => {
    if (path !== "/" && request.url === path) {
      response.writeHead(308, { Location: `${path}/` });
      response.end();
      return;
    }
    stripPathPrefix(request, path);
    proxy.web(request, response);
  });
  server.on("upgrade", (request, socket, head) => {
    stripPathPrefix(request, path);
    proxy.ws(request, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
