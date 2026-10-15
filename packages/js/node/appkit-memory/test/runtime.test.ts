import { describe, expect, test } from "bun:test";

import {
  graphitiHealthCheck,
  graphitiHttpUrl,
  remainingTimeoutMs,
  resolveGraphitiPythonCommand,
} from "../src/graphiti/runtime.ts";

describe("Graphiti runtime", () => {
  test("builds the private HTTP endpoint and health authorization", async () => {
    expect(
      graphitiHttpUrl(
        { listen: { scheme: "tcp", host: "127.0.0.1", port: 7272 } },
        "/openapi.json",
      ),
    ).toBe("http://127.0.0.1:7272/openapi.json");

    const originalFetch = globalThis.fetch;
    const authorizations: Array<string | null> = [];
    globalThis.fetch = (async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(undefined, { status: 204 });
    }) as typeof fetch;
    try {
      expect(
        await graphitiHealthCheck(
          {
            listen: { scheme: "tcp", host: "127.0.0.1", port: 7272 },
            bearer: "secret",
          },
          new AbortController().signal,
        ),
      ).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(authorizations).toEqual(["Bearer secret"]);
  });

  test("computes a bounded remaining startup budget", () => {
    expect(remainingTimeoutMs(1_000, 5_000, 2_500)).toBe(3_500);
    expect(remainingTimeoutMs(1_000, 5_000, 8_000)).toBe(0);
  });

  test("uses an explicitly configured Python executable", async () => {
    const previous = process.env.PYTHON;
    process.env.PYTHON = "/custom/python";
    try {
      expect(await resolveGraphitiPythonCommand({}, "-m", "dbx_tools.graphiti")).toEqual({
        command: "/custom/python",
        args: ["-m", "dbx_tools.graphiti"],
      });
    } finally {
      if (previous === undefined) delete process.env.PYTHON;
      else process.env.PYTHON = previous;
    }
  });
});
