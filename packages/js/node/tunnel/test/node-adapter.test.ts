import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { sendWebResponse, webRequest } from "../src/gate.ts";

function streamRequest(body: string): IncomingMessage & PassThrough {
  const request = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(request, {
    headers: {
      host: "localhost",
      "content-length": String(Buffer.byteLength(body)),
      "content-type": "application/json",
    },
    httpVersionMajor: 1,
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
    url: "/api/email/auth/sign-in/email-otp",
  });
  return request;
}

describe("Better Call Node adapters", () => {
  it("streams raw request bodies without a second buffering implementation", async () => {
    const incoming = streamRequest('{"otp":"123456"}');
    const request = webRequest(incoming);
    incoming.end('{"otp":"123456"}');

    assert.equal(await request.text(), '{"otp":"123456"}');
    assert.equal(request.headers.get("x-real-ip"), "127.0.0.1");
  });

  it("serializes a body already consumed by Express and preserves its mounted URL", async () => {
    const incoming = {
      baseUrl: "/api/email/auth",
      body: { email: "user@example.com" },
      destroyed: false,
      headers: { host: "localhost", "content-type": "application/json" },
      httpVersionMajor: 1,
      method: "POST",
      originalUrl: "/api/email/auth/email-otp/send-verification-otp?source=login",
      readable: false,
      readableEnded: true,
      socket: { remoteAddress: "127.0.0.1" },
      url: "/email-otp/send-verification-otp?source=login",
    } as unknown as IncomingMessage;

    const request = webRequest(incoming);
    assert.equal(
      request.url,
      "http://localhost/api/email/auth/email-otp/send-verification-otp?source=login",
    );
    assert.deepEqual(await request.json(), { email: "user@example.com" });
  });

  it("rejects an interrupted body instead of accepting its partial bytes", async () => {
    const incoming = streamRequest('{"otp":"123456"}');
    const request = webRequest(incoming);
    incoming.write('{"otp":');
    incoming.emit("error", new Error("connection interrupted"));

    await assert.rejects(request.text(), /connection interrupted/);
  });

  it("preserves separate Set-Cookie headers when writing the fetch response", async () => {
    const server = createServer((_request, response) => {
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "session=one; Path=/; HttpOnly");
      headers.append("set-cookie", "challenge=two; Path=/; HttpOnly");
      void sendWebResponse(response, new Response("ok", { headers, status: 201 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    try {
      const result = await new Promise<{ body: string; cookies?: string[]; status?: number }>(
        (resolve, reject) => {
          const request = httpRequest(
            { host: "127.0.0.1", port: address.port, path: "/" },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => (body += chunk));
              response.on("end", () =>
                resolve({
                  body,
                  cookies: response.headers["set-cookie"],
                  status: response.statusCode,
                }),
              );
            },
          );
          request.on("error", reject);
          request.end();
        },
      );
      assert.equal(result.status, 201);
      assert.equal(result.body, "ok");
      assert.deepEqual(result.cookies, [
        "session=one; Path=/; HttpOnly",
        "challenge=two; Path=/; HttpOnly",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
