import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceClient } from "@databricks/appkit";

import {
  modelGatewayRateLimit,
  ProfileFallback,
  type ModelGatewayProfile,
} from "../src/profile-fallback.ts";

describe("model gateway profile fallback", () => {
  it("parses Retry-After headers before Databricks body timing", async () => {
    const rateLimit = await modelGatewayRateLimit(
      Response.json(
        {
          error: {
            message: "Rate limit exceeded",
            retry_after: "15",
            error_code: "REQUEST_LIMIT_EXCEEDED",
          },
        },
        { status: 429, headers: { "retry-after": "3" } },
      ),
      0,
    );

    assert.deepEqual(rateLimit, {
      retryAfterMs: 3_000,
      source: "header",
      errorCode: "REQUEST_LIMIT_EXCEEDED",
      message: "Rate limit exceeded",
    });
  });

  it("uses a full token window for the live Databricks workspace error", async () => {
    const rateLimit = await modelGatewayRateLimit(
      Response.json(
        {
          error_code: "REQUEST_LIMIT_EXCEEDED",
          message:
            "REQUEST_LIMIT_EXCEEDED: Exceeded workspace long-context tokens per minute rate limit for databricks-gpt-5-6-sol.",
        },
        { status: 429 },
      ),
      0,
    );

    assert.deepEqual(rateLimit, {
      retryAfterMs: 60_000,
      source: "workspace-token-window",
      errorCode: "REQUEST_LIMIT_EXCEEDED",
      message:
        "REQUEST_LIMIT_EXCEEDED: Exceeded workspace long-context tokens per minute rate limit for databricks-gpt-5-6-sol.",
    });
  });

  it("falls back in order and returns to the primary after cooldown", async () => {
    let now = 1_000;
    const profiles = [profile("PRIMARY"), profile("SECONDARY"), profile("TERTIARY")];
    const fallback = new ProfileFallback(profiles, { now: () => now });
    const calls: string[] = [];
    let primaryRateLimited = true;

    const send = async (candidate: ModelGatewayProfile) => {
      calls.push(candidate.profile!);
      if (candidate.profile === "PRIMARY" && primaryRateLimited) {
        return Response.json(
          { error: { message: "Rate limit exceeded", retry_after: 30 } },
          { status: 429 },
        );
      }
      return Response.json({ profile: candidate.profile });
    };

    assert.equal((await fallback.request("model", signal(), send)).status, 200);
    assert.deepEqual(calls, ["PRIMARY", "SECONDARY"]);

    calls.length = 0;
    assert.equal((await fallback.request("model", signal(), send)).status, 200);
    assert.deepEqual(calls, ["SECONDARY"]);

    now += 30_000;
    primaryRateLimited = false;
    calls.length = 0;
    assert.equal((await fallback.request("model", signal(), send)).status, 200);
    assert.deepEqual(calls, ["PRIMARY"]);
  });

  it("shares cooldowns across profiles for the same workspace and model", async () => {
    const profiles = [
      profile("PRIMARY", "https://workspace-a.example"),
      profile("SAME-WORKSPACE", "https://workspace-a.example/"),
      profile("OTHER-WORKSPACE", "https://workspace-b.example"),
    ];
    const fallback = new ProfileFallback(profiles);
    const calls: string[] = [];

    const response = await fallback.request("model-a", signal(), async (candidate) => {
      calls.push(candidate.profile!);
      if (candidate.profile === "PRIMARY") {
        return Response.json(
          { error: { message: "Rate limit exceeded", retry_after: 30 } },
          { status: 429 },
        );
      }
      return Response.json({ profile: candidate.profile });
    });

    assert.equal(response.status, 200);
    assert.deepEqual(calls, ["PRIMARY", "OTHER-WORKSPACE"]);

    calls.length = 0;
    await fallback.request("model-b", signal(), async (candidate) => {
      calls.push(candidate.profile!);
      return Response.json({ profile: candidate.profile });
    });
    assert.deepEqual(calls, ["PRIMARY"]);
  });

  it("rehosts and reauthenticates translated requests before canceling a 429 body", async () => {
    let canceled = false;
    const requests: { readonly url: string; readonly authorization: string | null }[] = [];
    const profiles = [
      authenticatedProfile("PRIMARY", "https://workspace-a.example", "primary-token"),
      authenticatedProfile("SECONDARY", "https://workspace-b.example", "secondary-token"),
    ];
    const fallback = new ProfileFallback(profiles, {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        requests.push({
          url: input.toString(),
          authorization: headers.get("authorization"),
        });
        if (requests.length === 1) {
          return {
            status: 429,
            headers: new Headers({ "retry-after": "30" }),
            clone: () => Response.json({ message: "Rate limit exceeded" }, { status: 429 }),
            body: {
              async cancel() {
                canceled = true;
              },
            },
          } as unknown as Response;
        }
        return Response.json({ ok: true });
      },
    });

    const response = await fallback.createFetch("model-a")(
      "https://provider.example/serving-endpoints/model-a/invocations?stream=true",
      {
        method: "POST",
        headers: {
          authorization: "Bearer original-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ input: "hello" }),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(canceled, true);
    assert.deepEqual(requests, [
      {
        url: "https://workspace-a.example/serving-endpoints/model-a/invocations?stream=true",
        authorization: "Bearer primary-token",
      },
      {
        url: "https://workspace-b.example/serving-endpoints/model-a/invocations?stream=true",
        authorization: "Bearer secondary-token",
      },
    ]);
  });

  it("waits for the earliest existing cooldown when every profile is paused", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const profiles = [profile("PRIMARY"), profile("SECONDARY")];
    const fallback = new ProfileFallback(profiles, {
      now: () => now,
      sleep: async (delayMs) => {
        sleeps.push(delayMs);
        now += delayMs;
      },
    });
    const firstCalls: string[] = [];
    const first = await fallback.request("model", signal(), async (candidate) => {
      firstCalls.push(candidate.profile!);
      return Response.json(
        {
          error: {
            message: "Rate limit exceeded",
            retry_after: candidate.profile === "PRIMARY" ? 5 : 8,
          },
        },
        { status: 429 },
      );
    });
    assert.equal(first.status, 429);
    assert.deepEqual(firstCalls, ["PRIMARY", "SECONDARY"]);

    const secondCalls: string[] = [];
    const second = await fallback.request("model", signal(), async (candidate) => {
      secondCalls.push(candidate.profile!);
      return Response.json({ profile: candidate.profile });
    });
    assert.equal(second.status, 200);
    assert.deepEqual(sleeps, [5_000]);
    assert.deepEqual(secondCalls, ["PRIMARY"]);
  });
});

function profile(
  name: string,
  workspace = `https://${name.toLowerCase()}.example`,
): ModelGatewayProfile {
  return { profile: name, workspace, client: {} as WorkspaceClient };
}

function authenticatedProfile(name: string, workspace: string, token: string): ModelGatewayProfile {
  return {
    profile: name,
    workspace,
    client: {
      config: {
        async authenticate(headers: Headers) {
          headers.set("authorization", `Bearer ${token}`);
        },
      },
    } as unknown as WorkspaceClient,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
