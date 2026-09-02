import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exec } from "@dbx-tools/core";

import { resolveBindAddresses } from "../src/network.ts";

describe("container bind discovery", () => {
  it("reads Docker and Podman gateways but binds only local addresses", async () => {
    const calls: string[] = [];
    const execute = ((command: string) => {
      calls.push(command);
      const stdout =
        command === "docker"
          ? JSON.stringify([{ IPAM: { Config: [{ Gateway: "::1" }, { Gateway: "172.99.0.1" }] } }])
          : JSON.stringify([{ subnets: [{ gateway: "127.0.0.2" }] }]);
      return { exitCode: 0, stdout, stderr: "" };
    }) as typeof exec.spawnSync;

    const addresses = await resolveBindAddresses(["127.0.0.1"], "auto", execute);

    assert.deepEqual(calls, ["docker", "podman"]);
    assert.deepEqual(addresses, ["127.0.0.1", "::1"]);
  });

  it("reports explicit container-engine discovery failures", async () => {
    const execute = (() => ({
      exitCode: 1,
      stdout: "",
      stderr: "not installed",
    })) as typeof exec.spawnSync;

    await assert.rejects(
      () => resolveBindAddresses(["127.0.0.1", "192.168.1.10"], "podman", execute),
      /podman gateway discovery failed: not installed/,
    );
  });

  it("ignores an uninstalled optional engine during automatic discovery", async () => {
    const execute = ((command: string) =>
      command === "docker"
        ? { exitCode: 0, stdout: "[]", stderr: "" }
        : { exitCode: 127, stdout: "", stderr: "command not found" }) as typeof exec.spawnSync;

    assert.deepEqual(await resolveBindAddresses(["127.0.0.1"], "auto", execute), ["127.0.0.1"]);
  });
});
