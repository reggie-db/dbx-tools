import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuthClient, DatabricksAuthOptions } from "@dbx-tools/auth";
import type { BinContext } from "@dbx-tools/core/bin";
import { AuthType, TargetKind } from "@dbx-tools/shared-auth";

import { RUNNER_OPTIONS_ENV } from "../src/genie-code/runner.ts";
import {
  prepareGenieCodeRuntime,
  runGenieCode,
  type GenieCodeRuntimeDependencies,
} from "../src/genie-code/runtime.ts";

function fakeAuth(profile: string | undefined): AuthClient {
  return {
    profile,
    host: "https://workspace.example.com",
    target: TargetKind.Workspace,
    authType: AuthType.DatabricksCli,
    principal: profile ?? "ambient",
    async token() {
      throw new Error("Genie runtime preparation must not acquire a second token");
    },
    async headers() {
      throw new Error("Genie runtime preparation must not acquire headers");
    },
    async logout() {},
  };
}

const INSTALLATION: BinContext = {
  root: "/dbx/genie/release",
  binDir: "/dbx/genie/release/bin",
  path: "/dbx/genie/release/bin/genie",
};

describe("managed Genie Code runtime", () => {
  it("uses AuthClient.profile when no profile argument is supplied", async () => {
    const authOptions: DatabricksAuthOptions[] = [];
    const configs: unknown[] = [];
    const prepared = await prepareGenieCodeRuntime({
      cwd: "/workspace/project",
      options: { model: "gpt" },
      dependencies: {
        async createAuthClient(options = {}) {
          authOptions.push(options);
          return fakeAuth("AUTO-PROFILE");
        },
        install: async () => INSTALLATION,
        port: async () => 4312,
        resolveCodexModel: async (model) => `databricks/system.ai.${model}-5-6-sol`,
        token: () => "sidecar-token",
        async writeConfig(options) {
          configs.push(options);
          return {
            name: "auto-profile-gpt-hash",
            home: "/home/genie",
            configPath: "/home/genie/config.toml",
            overlayName: "dbx-run",
            overlayPath: "/home/genie/dbx-run.config.toml",
          };
        },
      },
    });

    assert.deepEqual(authOptions, [{}]);
    assert.equal(prepared.profile, "AUTO-PROFILE");
    assert.equal(prepared.model, "databricks/system.ai.gpt-5-6-sol");
    assert.equal(prepared.gatewayBaseUrl, "http://127.0.0.1:4312/v1");
    assert.deepEqual(configs, [
      {
        bearerToken: "sidecar-token",
        gatewayBaseUrl: "http://127.0.0.1:4312/v1",
        model: "databricks/system.ai.gpt-5-6-sol",
        profile: "AUTO-PROFILE",
        projectDirectory: "/workspace/project",
      },
    ]);
  });

  it("fails when automatic auth has no configured profile", async () => {
    await assert.rejects(
      prepareGenieCodeRuntime({
        dependencies: {
          createAuthClient: async () => fakeAuth(undefined),
        },
      }),
      /configured Databricks profile/,
    );
  });

  it("rejects an occupied explicit gateway port", async () => {
    await assert.rejects(
      prepareGenieCodeRuntime({
        options: {
          profile: "PROFILE",
          gatewayListen: "127.0.0.1:4400",
        },
        dependencies: {
          createAuthClient: async () => fakeAuth("PROFILE"),
          install: async () => INSTALLATION,
          port: async () => 4401,
        },
      }),
      /port 4400 is already in use/,
    );
  });

  it("supervises guarded gateway and readiness-gated Genie children", async () => {
    const supervised: Array<{
      commands: Parameters<GenieCodeRuntimeDependencies["supervise"]>[0];
      options: Parameters<GenieCodeRuntimeDependencies["supervise"]>[1];
    }> = [];
    await runGenieCode({
      cwd: "/workspace/project",
      genieArgs: ["--search", "hello"],
      options: { profile: "PROFILE", model: "grok" },
      dependencies: {
        createAuthClient: async () => fakeAuth("PROFILE"),
        install: async () => INSTALLATION,
        port: async () => 4312,
        resolveBin: (_reference, name) => `/package/bin/${name}`,
        resolveCodexModel: async () => "databricks/system.ai.grok-4-7",
        supervise(commands, options) {
          supervised.push({ commands, options });
          return { commands: [], result: Promise.resolve([]) };
        },
        token: () => "sidecar-token",
        writeConfig: async () => ({
          name: "profile-grok-hash",
          home: "/home/genie",
          configPath: "/home/genie/config.toml",
          overlayName: "dbx-run",
          overlayPath: "/home/genie/dbx-run.config.toml",
        }),
      },
    });

    assert.equal(supervised.length, 1);
    assert.deepEqual(supervised[0]?.options, {
      cwd: "/workspace/project",
      raw: true,
      killOthersOn: ["failure", "success"],
      killSignal: "SIGTERM",
      killTimeout: 17_000,
      successCondition: "command-genie",
    });
    const gateway = supervised[0]?.commands[0];
    assert.equal(gateway?.name, "gateway");
    assert.equal(gateway?.env?.DATABRICKS_CONFIG_PROFILE, "PROFILE");
    assert.equal(gateway?.env?.DBX_TOOLS_MODEL_GATEWAY_BEARER_TOKEN, "sidecar-token");
    assert.equal(gateway?.env?.LISTEN, "tcp://127.0.0.1:4312");
    const genie = supervised[0]?.commands[1];
    assert.equal(genie?.name, "genie");
    const runner = JSON.parse(String(genie?.env?.[RUNNER_OPTIONS_ENV]));
    assert.deepEqual(runner, {
      executable: INSTALLATION.path,
      arguments: ["-p", "dbx-run", "--search", "hello"],
      home: "/home/genie",
      gatewayHealthUrl: "http://127.0.0.1:4312/api/healthz",
      bearerToken: "sidecar-token",
      startupTimeoutMs: 60_000,
    });
  });
});
