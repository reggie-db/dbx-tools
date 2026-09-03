import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exec } from "@dbx-tools/core";

import { GoogleTokenProvider } from "../src/google.ts";

const GCLOUD = "/opt/homebrew/bin/gcloud";
const INVALID_SCOPES = "ERROR: Invalid value for [--scopes]: Invalid scopes value.";

function requestedScopes(args: string[]): string[] {
  const value = args.find((arg) => arg.startsWith("--scopes="));
  return value ? value.slice("--scopes=".length).split(",") : [];
}

function unverifiedToken(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "unverified",
  ].join(".");
}

describe("GoogleTokenProvider", () => {
  it("delegates scoped ADC token minting to gcloud", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const execute = (async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { exitCode: 0, stdout: "short-lived-token\n", stderr: "" };
    }) as typeof exec.spawn;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      now: () => 1_000,
      execute,
      executable: GCLOUD,
    });

    assert.deepEqual(await provider.acquire(["scope:a", "scope:b"]), {
      accessToken: "short-lived-token",
      tokenType: "Bearer",
      expiresAt: 3_601_000,
      scopes: ["scope:a", "scope:b"],
    });
    assert.deepEqual(calls, [
      {
        command: GCLOUD,
        args: [
          "auth",
          "application-default",
          "print-access-token",
          "--quiet",
          "--scopes=scope:a,scope:b",
        ],
      },
    ]);
  });

  it("does not mistake gcloud diagnostics for a token", async () => {
    const execute = (async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "run gcloud auth application-default login",
    })) as typeof exec.spawn;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      execute,
      executable: GCLOUD,
    });

    await assert.rejects(() => provider.acquire([]), /application-default login/);
  });

  it("omits the scopes flag when the request has no scopes", async () => {
    let args: string[] = [];
    const execute = (async (_command: string, commandArgs: string[]) => {
      args = commandArgs;
      return { exitCode: 0, stdout: "default-token\n", stderr: "" };
    }) as typeof exec.spawn;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      execute,
      executable: GCLOUD,
    });

    await provider.acquire([]);

    assert.equal(
      args.some((arg) => arg.startsWith("--scopes")),
      false,
    );
  });

  it("serializes browser authorization and combines current scopes", async () => {
    const authorized = new Set(["scope:existing"]);
    let activeLogins = 0;
    let loginCount = 0;
    let maxActiveLogins = 0;
    let loginArguments: string[] = [];
    let loginScopes: string[] = [];
    const execute = (async (_command: string, args: string[]) => {
      if (args.includes("print-access-token")) {
        const scopes = requestedScopes(args);
        if (scopes.length === 0) {
          return { exitCode: 0, stdout: "current-token", stderr: "" };
        }
        return scopes.every((scope) => authorized.has(scope))
          ? { exitCode: 0, stdout: "expanded-token", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: INVALID_SCOPES };
      }
      loginCount++;
      activeLogins++;
      maxActiveLogins = Math.max(maxActiveLogins, activeLogins);
      loginArguments = args;
      loginScopes = requestedScopes(args);
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const scope of loginScopes) authorized.add(scope);
      activeLogins--;
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof exec.spawn;
    const inspect = (async () =>
      new Response(JSON.stringify({ scope: [...authorized].join(" ") }), {
        status: 200,
      })) as typeof globalThis.fetch;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      execute,
      executable: GCLOUD,
      fetch: inspect,
    });

    const [first, second] = await Promise.all([
      provider.acquire(["scope:new"]),
      provider.acquire(["scope:new"]),
    ]);

    assert.equal(first.accessToken, "expanded-token");
    assert.equal(second.accessToken, "expanded-token");
    assert.equal(loginCount, 1);
    assert.equal(maxActiveLogins, 1);
    assert.ok(loginArguments.includes("--launch-browser"));
    assert.deepEqual(loginScopes, ["scope:existing", "scope:new"]);
  });

  it("reuses the current ADC token when it already covers the requested scopes", async () => {
    let loginCount = 0;
    const execute = (async (_command: string, args: string[]) => {
      if (args.includes("print-access-token")) {
        return requestedScopes(args).length === 0
          ? { exitCode: 0, stdout: "current-token", stderr: "" }
          : { exitCode: 1, stdout: "", stderr: INVALID_SCOPES };
      }
      loginCount++;
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof exec.spawn;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      execute,
      executable: GCLOUD,
      fetch: (async () =>
        new Response(JSON.stringify({ scope: "scope:existing scope:new" }), {
          status: 200,
        })) as typeof globalThis.fetch,
    });

    const token = await provider.acquire(["scope:new"]);

    assert.equal(token.accessToken, "current-token");
    assert.deepEqual(token.scopes, ["scope:new"]);
    assert.equal(loginCount, 0);
  });

  it("reads JWT scope claims locally without calling tokeninfo", async () => {
    const currentToken = unverifiedToken({ scope: "scope:existing scope:new" });
    let fetchCount = 0;
    let loginCount = 0;
    const execute = (async (_command: string, args: string[]) => {
      if (args.includes("print-access-token")) {
        return requestedScopes(args).length === 0
          ? { exitCode: 0, stdout: currentToken, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: INVALID_SCOPES };
      }
      loginCount++;
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as typeof exec.spawn;
    const provider = new GoogleTokenProvider({
      accessTokenTtlSeconds: 3600,
      execute,
      executable: GCLOUD,
      fetch: (async () => {
        fetchCount++;
        throw new Error("tokeninfo must not be called");
      }) as typeof globalThis.fetch,
    });

    const token = await provider.acquire(["scope:new"]);

    assert.equal(token.accessToken, currentToken);
    assert.equal(fetchCount, 0);
    assert.equal(loginCount, 0);
  });
});
