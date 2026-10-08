import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolveServicePackageBin } from "@dbx-tools/cli-service/definition";

import { buildProgram } from "../src/genie-code/cli.ts";

describe("Genie Code CLI", () => {
  it("ships executable gateway and Genie entrypoints", async () => {
    await access(resolveServicePackageBin(import.meta.url, "dbx-model-gateway"), constants.X_OK);
    await access(resolveServicePackageBin(import.meta.url, "dbx-genie"), constants.X_OK);
  });

  it("reuses shared Databricks profile and model options", () => {
    const help = buildProgram("dbx genie").helpInformation();

    assert.match(help, /--profile <value>/);
    assert.match(help, /DATABRICKS_CONFIG_PROFILE/);
    assert.match(help, /--model <value>/);
    assert.match(help, /--gateway-listen <value>/);
  });

  it("forwards native Genie arguments after wrapper options", async () => {
    const calls: unknown[] = [];
    await buildProgram("dbx genie", {
      async run(input) {
        calls.push(input);
      },
    }).parseAsync(
      [
        "--profile",
        "PROFILE",
        "--model",
        "grok",
        "--gateway-listen",
        "localhost:4400",
        "--",
        "--search",
        "summarize this repository",
      ],
      { from: "user" },
    );

    assert.deepEqual(calls, [
      {
        cwd: process.cwd(),
        genieArgs: ["--search", "summarize this repository"],
        options: {
          profile: "PROFILE",
          model: "grok",
          gatewayListen: { scheme: "tcp", host: "localhost", port: 4400 },
        },
      },
    ]);
  });

  it("forwards unknown flags to Genie Code without a -- separator", async () => {
    const calls: unknown[] = [];
    await buildProgram("dbx genie", {
      async run(input) {
        calls.push(input);
      },
    }).parseAsync(
      [
        "--profile",
        "PROFILE",
        "exec",
        "-C",
        "/tmp/project",
        "--sandbox",
        "read-only",
        "--ephemeral",
        "-o",
        "notes.md",
        "summarize this repository",
      ],
      { from: "user" },
    );

    assert.deepEqual(calls, [
      {
        cwd: process.cwd(),
        genieArgs: [
          "exec",
          "-C",
          "/tmp/project",
          "--sandbox",
          "read-only",
          "--ephemeral",
          "-o",
          "notes.md",
          "summarize this repository",
        ],
        options: {
          profile: "PROFILE",
          model: "gpt",
          gatewayListen: { scheme: "tcp", host: "127.0.0.1", port: 0 },
        },
      },
    ]);
  });
});
