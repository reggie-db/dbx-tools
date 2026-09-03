import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exec } from "@dbx-tools/core";

import { GoogleTokenProvider } from "../src/google.ts";

const GCLOUD = "/opt/homebrew/bin/gcloud";

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
});
