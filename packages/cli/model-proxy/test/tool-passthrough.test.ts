import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "bun:test";

import type { ServingEndpointSummary } from "@dbx-tools/shared-model";

import { startProxyServer, type ModelProxyBackend, type StartProxyOptions } from "../src/server.ts";

const TOOL = {
  type: "function",
  name: "queue_status",
  description: "Check queued work",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

/** Read one JSON request body. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** Listen on loopback with an ephemeral port. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

/** Close a Node HTTP server after its active request settles. */
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
}

class FakeBackend implements ModelProxyBackend {
  constructor(
    private readonly upstream: string,
    private readonly endpoints: ServingEndpointSummary[],
    private readonly options: { openResponses?: boolean; responsesOnly?: boolean } = {},
  ) {}

  async authHeaders(): Promise<Record<string, string>> {
    return { authorization: "Bearer upstream" };
  }

  invocationsUrl(): string {
    return `${this.upstream}/invocations`;
  }

  isResponsesOnly(): boolean {
    return this.options.responsesOnly === true;
  }

  async models(): Promise<ServingEndpointSummary[]> {
    return this.endpoints;
  }

  async resolve(model: string): Promise<{ modelId: string; matched: boolean }> {
    return { modelId: model, matched: true };
  }

  responsesUrl(): string {
    return `${this.upstream}/${this.options.openResponses ? "open-responses" : "responses"}`;
  }
}

/** Start a proxy around `backend`, run `test`, then close it. */
async function withProxy(
  backend: ModelProxyBackend,
  test: (url: string) => Promise<void>,
  options: StartProxyOptions = {},
): Promise<void> {
  const running = await startProxyServer(backend, { ...options, host: "127.0.0.1", port: 0 });
  try {
    await test(running.url);
  } finally {
    await close(running.server);
  }
}

/** POST JSON and return the response plus parsed JSON body. */
async function post(url: string, body: unknown): Promise<{ response: Response; body: any }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

describe("Responses function tools", () => {
  it("forwards tools and stateless function-call output without rewriting", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const upstream = createServer(async (req, res) => {
      forwarded = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          output: [
            {
              type: "function_call",
              name: "queue_status",
              call_id: "call_1",
              arguments: "{}",
            },
          ],
        }),
      );
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-gpt-5-6-sol",
      task: "llm/v1/chat",
      supportsTools: true,
    };

    try {
      await withProxy(new FakeBackend(upstreamUrl, [endpoint]), async (proxyUrl) => {
        const input = [
          { type: "function_call", name: "queue_status", call_id: "call_1", arguments: "{}" },
          { type: "function_call_output", call_id: "call_1", output: '{"queued":true}' },
        ];
        const request = {
          model: endpoint.name,
          input,
          tools: [TOOL],
          tool_choice: { type: "function", name: "queue_status" },
        };
        const result = await post(`${proxyUrl}/v1/responses`, request);

        assert.equal(result.response.status, 200);
        assert.deepEqual(forwarded, request);
        assert.deepEqual(result.body.output[0], {
          type: "function_call",
          name: "queue_status",
          call_id: "call_1",
          arguments: "{}",
        });
      });
    } finally {
      await close(upstream);
    }
  });

  it("relays streaming function-call events byte-for-byte", async () => {
    const frames = [
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"queue_status","call_id":"call_1"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","arguments":"{}"}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const upstream = createServer(async (req, res) => {
      await readBody(req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(frames);
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-gpt-5-3-codex",
      task: "llm/v1/chat",
      supportsTools: true,
    };

    try {
      await withProxy(new FakeBackend(upstreamUrl, [endpoint]), async (proxyUrl) => {
        const response = await fetch(`${proxyUrl}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: endpoint.name,
            input: "check",
            tools: [TOOL],
            stream: true,
          }),
        });
        assert.equal(await response.text(), frames);
      });
    } finally {
      await close(upstream);
    }
  });

  it("keeps function tools/results while stripping unsupported Open Responses tools", async () => {
    let forwarded: Record<string, any> | undefined;
    const upstream = createServer(async (req, res) => {
      forwarded = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_test", object: "response", output: [] }));
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-claude-sonnet-5",
      task: "llm/v1/chat",
      supportsTools: true,
    };

    try {
      await withProxy(
        new FakeBackend(upstreamUrl, [endpoint], { openResponses: true }),
        async (proxyUrl) => {
          const result = await post(`${proxyUrl}/v1/responses`, {
            model: endpoint.name,
            input: [{ type: "function_call_output", call_id: "call_1", output: "{}" }],
            tools: [{ type: "web_search" }, TOOL],
            tool_choice: "auto",
          });
          assert.equal(result.response.status, 200);
          assert.deepEqual(forwarded?.tools, [TOOL]);
          assert.equal(forwarded?.tool_choice, "auto");
          assert.deepEqual(forwarded?.input, [
            { type: "function_call_output", call_id: "call_1", output: "{}" },
          ]);
        },
      );
    } finally {
      await close(upstream);
    }
  });
});

describe("Chat function tools", () => {
  it("preserves chat tools, tool choice, calls, and tool-role results", async () => {
    let forwarded: Record<string, unknown> | undefined;
    const upstream = createServer(async (req, res) => {
      forwarded = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" } }] }));
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-claude-sonnet-5",
      task: "llm/v1/chat",
      supportsTools: true,
    };
    const chatTool = { type: "function", function: TOOL };

    try {
      await withProxy(new FakeBackend(upstreamUrl, [endpoint]), async (proxyUrl) => {
        const messages = [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "queue_status", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: '{"queued":true}' },
        ];
        const result = await post(`${proxyUrl}/v1/chat/completions`, {
          model: endpoint.name,
          messages,
          tools: [chatTool],
          tool_choice: "auto",
        });
        assert.equal(result.response.status, 200);
        assert.deepEqual(forwarded, {
          model: endpoint.name,
          messages,
          tools: [chatTool],
          tool_choice: "auto",
        });
      });
    } finally {
      await close(upstream);
    }
  });

  it("translates Responses-only function calls back to Chat tool_calls", async () => {
    let forwarded: Record<string, any> | undefined;
    const upstream = createServer(async (req, res) => {
      forwarded = await readBody(req);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "resp_test",
          output: [
            {
              type: "function_call",
              name: "queue_status",
              call_id: "call_1",
              arguments: "{}",
            },
          ],
        }),
      );
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-gpt-5-3-codex",
      task: "llm/v1/chat",
      supportsTools: true,
    };

    try {
      await withProxy(
        new FakeBackend(upstreamUrl, [endpoint], { responsesOnly: true }),
        async (proxyUrl) => {
          const result = await post(`${proxyUrl}/v1/chat/completions`, {
            model: endpoint.name,
            messages: [{ role: "user", content: "check" }],
            tools: [{ type: "function", function: TOOL }],
            tool_choice: "auto",
          });
          assert.deepEqual(forwarded?.tools, [TOOL]);
          assert.deepEqual(result.body.choices[0].message.tool_calls, [
            {
              id: "call_1",
              type: "function",
              function: { name: "queue_status", arguments: "{}" },
            },
          ]);
        },
      );
    } finally {
      await close(upstream);
    }
  });
});

describe("tool-capable model enforcement", () => {
  it("rejects tool requests for unsupported models before calling upstream", async () => {
    let called = false;
    const upstream = createServer((_req, res) => {
      called = true;
      res.end();
    });
    const upstreamUrl = await listen(upstream);
    const endpoint = {
      name: "databricks-gemini-3-5-flash",
      task: "llm/v1/chat",
      supportsTools: false,
    };

    try {
      await withProxy(new FakeBackend(upstreamUrl, [endpoint]), async (proxyUrl) => {
        const result = await post(`${proxyUrl}/v1/responses`, {
          model: endpoint.name,
          input: "check",
          tools: [TOOL],
        });
        assert.equal(result.response.status, 400);
        assert.match(result.body.error.message, /does not support function tools/);
        assert.equal(called, false);
      });
    } finally {
      await close(upstream);
    }
  });

  it("only advertises tool-capable endpoints to Codex", async () => {
    const endpoints: ServingEndpointSummary[] = [
      { name: "databricks-gpt-5-3-codex", task: "llm/v1/chat", supportsTools: true },
      { name: "databricks-gemini-3-5-flash", task: "llm/v1/chat", supportsTools: false },
      { name: "databricks-gte-large-en", task: "llm/v1/embeddings", supportsTools: false },
    ];

    await withProxy(new FakeBackend("http://unused", endpoints), async (proxyUrl) => {
      const response = await fetch(`${proxyUrl}/v1/models?client_version=test`);
      const body = (await response.json()) as { models: Array<{ slug: string }> };
      assert.deepEqual(
        body.models.map((model) => model.slug),
        ["databricks-gpt-5-3-codex"],
      );
    });
  });
});
