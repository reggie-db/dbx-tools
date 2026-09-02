import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { exec } from "@dbx-tools/core";

import { resolveBindAddresses } from "../src/network.ts";

describe("container bind discovery", () => {
  it("reads Docker and Podman gateways but binds only local addresses", async () => {
    const calls: string[] = [];
    const execute = (async (command: string) => {
      calls.push(command);
      const stdout =
        command === "docker"
          ? JSON.stringify([{ IPAM: { Config: [{ Gateway: "::1" }, { Gateway: "172.99.0.1" }] } }])
          : JSON.stringify([{ subnets: [{ gateway: "127.0.0.2" }] }]);
      return { exitCode: 0, stdout, stderr: "" };
    }) as typeof exec.spawn;

    const addresses = await resolveBindAddresses(["127.0.0.1"], "auto", execute);

    assert.deepEqual(calls, ["docker", "podman"]);
    assert.deepEqual(addresses, ["127.0.0.1", "::1"]);
  });

  it("keeps explicit binds when a container engine is unavailable", async () => {
    const execute = (async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "not installed",
    })) as typeof exec.spawn;

    assert.deepEqual(await resolveBindAddresses(["127.0.0.1", "192.168.1.10"], "podman", execute), [
      "127.0.0.1",
      "192.168.1.10",
    ]);
  });
});
