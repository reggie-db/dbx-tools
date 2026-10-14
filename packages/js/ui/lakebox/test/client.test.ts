import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { LAKEBOX_DEFAULT_BASE_PATH, LakeboxClientConfigSchema } from "@dbx-tools/shared-lakebox";
import { LakeboxClient } from "../src/react/client.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("LakeboxClient", () => {
  it("defaults the shared API mount and route prefix", () => {
    assert.deepEqual(LakeboxClientConfigSchema.parse({}), {
      basePath: LAKEBOX_DEFAULT_BASE_PATH,
      routePrefix: "/lakebox",
    });
  });

  it("derives endpoints from shared routes and surfaces server errors", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return Response.json({ error: "Lakebox is busy" }, { status: 409 });
    }) as typeof fetch;
    const client = new LakeboxClient();

    await assert.rejects(client.startService("desktop"), /Lakebox is busy/);
    await assert.rejects(client.serviceLogs("web", { maxLines: 5 }), /Lakebox is busy/);
    assert.deepEqual(requests, [
      "POST /api/lakebox/services/desktop/start",
      "GET /api/lakebox/services/web/logs?maxLines=5&maxChars=16000",
    ]);
  });

  it("parses metrics streamed over server-sent events", async () => {
    const payload = { status: "running", series: [] };
    globalThis.fetch = (async () =>
      new Response(
        `data: ${JSON.stringify(payload)}\n\ndata: ${JSON.stringify(payload)}\n\n`,
      )) as typeof fetch;
    const received: unknown[] = [];
    for await (const response of new LakeboxClient().metricsStream()) received.push(response);
    assert.equal(received.length, 2);
  });
});
