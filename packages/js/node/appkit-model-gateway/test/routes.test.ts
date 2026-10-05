import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type express from "express";

import type { ModelGateway } from "../src/gateway.ts";
import { sendHealth, sendInference } from "../src/routes.ts";

describe("model gateway Express lifecycle", () => {
  it("returns the compatibility health payload", async () => {
    const response = new MockResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const ended = new Promise<void>((resolve) => response.once("end", resolve));

    sendHealth(response as unknown as express.Response);
    await ended;

    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { ready: true });
  });

  it("aborts the upstream request when the client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const gateway = {
      inference(
        _protocol: unknown,
        _body: unknown,
        _headers: unknown,
        signal: AbortSignal,
      ): Promise<Response> {
        upstreamSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    } as unknown as ModelGateway;
    const request = new MockRequest();
    const response = new MockResponse();
    const pending = sendInference(
      gateway,
      "openai-responses",
      request as unknown as express.Request,
      response as unknown as express.Response,
    );

    request.emit("aborted");
    await pending;

    assert.equal(upstreamSignal?.aborted, true);
    assert.equal(response.destroyedByGateway, true);
  });

  it("pipes response bytes without rebuilding SSE frames", async () => {
    const bytes = [
      "event: response.created\r\n",
      'data: {"type":"response.created"}\r\n\r\n',
      "data: [DONE]\r\n\r\n",
    ].join("");
    const gateway = {
      async inference(): Promise<Response> {
        return new Response(bytes, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    } as unknown as ModelGateway;
    const request = new MockRequest();
    const response = new MockResponse();
    const chunks: Buffer[] = [];
    response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));

    await sendInference(
      gateway,
      "openai-responses",
      request as unknown as express.Request,
      response as unknown as express.Response,
    );

    assert.equal(Buffer.concat(chunks).toString(), bytes);
  });
});

class MockRequest extends EventEmitter {
  readonly body = { model: "databricks-gpt-test", stream: true };
  readonly headers: Record<string, string> = {};

  header(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
}

class MockResponse extends PassThrough {
  headersSent = false;
  destroyedByGateway = false;
  private readonly headerValues = new Map<string, string>();

  status(_code: number): this {
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headerValues.set(name.toLowerCase(), value);
    return this;
  }

  json(value: unknown): this {
    this.end(JSON.stringify(value));
    return this;
  }

  override destroy(error?: Error): this {
    this.destroyedByGateway = true;
    return super.destroy(error);
  }
}
