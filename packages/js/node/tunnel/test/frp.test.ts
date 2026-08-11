import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { frpAssetName, resolveFrpConfig, writeFrpConfig } from "../src/frp.ts";

describe("frp", () => {
  it("selects published Darwin and Linux assets", () => {
    assert.equal(frpAssetName("0.68.1", "darwin", "arm64"), "frp_0.68.1_darwin_arm64.tar.gz");
    assert.equal(frpAssetName("0.68.1", "darwin", "x64"), "frp_0.68.1_darwin_amd64.tar.gz");
    assert.equal(frpAssetName("0.68.1", "linux", "arm64"), "frp_0.68.1_linux_arm64.tar.gz");
    assert.equal(frpAssetName("0.68.1", "linux", "x64"), "frp_0.68.1_linux_amd64.tar.gz");
    assert.throws(() => frpAssetName("0.68.1", "win32", "x64"), /no supported release asset/);
  });

  it("renders the MediaMix-style WSS HTTP proxy config", async () => {
    const homeDir = await mkdtemp(join(tmpdir(), "frpc-config-"));
    try {
      const resolved = resolveFrpConfig({
        publicDomain: "inspire.example.com",
        token: "secret\"token",
        port: 8000,
      });
      assert.ok(resolved);
      const path = await writeFrpConfig(resolved, { HOME: homeDir });
      assert.equal(
        await readFile(path, "utf8"),
        [
          'serverAddr = "inspire.example.com"',
          "serverPort = 443",
          'transport.protocol = "wss"',
          'auth.token = "secret\\\"token"',
          "",
          "[[proxies]]",
          'name = "inspire"',
          'type = "http"',
          "localPort = 8000",
          'customDomains = ["inspire.example.com"]',
          "",
        ].join("\n"),
      );
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
