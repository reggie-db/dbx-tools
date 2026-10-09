import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createGraphitiChildProcess,
  graphitiHealthCheck,
  graphitiHttpUrl,
  remainingTimeoutMs,
  resolveGraphitiPythonCommand,
  runGraphiti,
} from "../src/runtime.ts";

describe("Graphiti runtime", () => {
  it("exposes only option-driven lifecycle entry points", () => {
    assert.equal(typeof createGraphitiChildProcess, "function");
    assert.equal(typeof runGraphiti, "function");
    assert.equal(
      graphitiHttpUrl(
        { listen: { scheme: "tcp", host: "127.0.0.1", port: 7272 } },
        "/openapi.json",
      ),
      "http://127.0.0.1:7272/openapi.json",
    );
  });

  it("checks the Graphiti health endpoint and returns a boolean", async () => {
    const originalFetch = globalThis.fetch;
    const urls: string[] = [];
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(undefined, { status: urls.length === 1 ? 204 : 503 });
    }) as typeof fetch;
    try {
      const options = { listen: { scheme: "tcp" as const, host: "127.0.0.1", port: 7272 } };
      const signal = new AbortController().signal;
      assert.equal(
        await graphitiHealthCheck(options, signal),
        true,
      );
      assert.equal(await graphitiHealthCheck({ ...options, bearer: "secret" }, signal), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(urls, [
      "http://127.0.0.1:7272/healthcheck",
      "http://127.0.0.1:7272/healthcheck",
    ]);
    assert.deepEqual(authorizations, [null, "Bearer secret"]);
  });

  it("computes remaining startup budget without going negative", () => {
    assert.equal(remainingTimeoutMs(1_000, 5_000, 2_500), 3_500);
    assert.equal(remainingTimeoutMs(1_000, 5_000, 8_000), 0);
  });

  it("launches configured Python directly and otherwise provisions through uv", async () => {
    const previous = process.env.PYTHON;
    try {
      process.env.PYTHON = "/custom/python";
      assert.deepEqual(await resolveGraphitiPythonCommand({}, "-m", "dbx_tools.graphiti"), {
        command: "/custom/python",
        args: ["-m", "dbx_tools.graphiti"],
      });

      delete process.env.PYTHON;
      const provisioned = await resolveGraphitiPythonCommand(
        { dev: true },
        "-m",
        "dbx_tools.graphiti",
      );
      assert.equal(provisioned.command, "uv");
      assert.ok(provisioned.args.includes("--with"));
      assert.ok(provisioned.args.some((arg) => arg.startsWith("dbx-tools-graphiti[dev]==")));
    } finally {
      if (previous === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previous;
    }
  });
});
