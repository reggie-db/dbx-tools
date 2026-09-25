import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePortrOutput, portrAssetName, probePortrPublicUrl } from "../src/portr.ts";

describe("normalizePortrOutput", () => {
  it("removes pictographs from portr lifecycle logs", () => {
    const rocket = String.fromCodePoint(0x1f680);
    const stop = String.fromCodePoint(0x1f6d1);
    assert.equal(
      normalizePortrOutput(
        `${rocket} Starting tunnel: demo (localhost:8000)\n${stop} Shutting down tunnels...\n`,
      ),
      "Starting tunnel: demo (localhost:8000)\nShutting down tunnels...\n",
    );
  });
});

describe("probePortrPublicUrl", () => {
  it("treats an unregistered subdomain as unhealthy", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 404,
        headers: { "x-portr-error": "true", "x-portr-error-reason": "unregistered-subdomain" },
      })) as typeof fetch;
    try {
      assert.equal(await probePortrPublicUrl("https://lensiq.apps.dbx.tools"), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("treats an auth challenge as healthy (tunnel is registered)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 401, headers: { "content-type": "text/html" } })) as typeof fetch;
    try {
      assert.equal(await probePortrPublicUrl("https://lensiq.apps.dbx.tools"), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("portrAssetName", () => {
  it("selects Darwin and Linux architecture assets", () => {
    assert.equal(portrAssetName("1.0.13", "darwin", "arm64"), "portr_1.0.13_Darwin_arm64.zip");
    assert.equal(portrAssetName("1.0.13", "darwin", "x64"), "portr_1.0.13_Darwin_x86_64.zip");
    assert.equal(portrAssetName("1.0.13", "linux", "arm64"), "portr_1.0.13_Linux_arm64.zip");
    assert.equal(portrAssetName("1.0.13", "linux", "x64"), "portr_1.0.13_Linux_x86_64.zip");
    assert.equal(
      portrAssetName("1.0.15-sse.2", "darwin", "arm64"),
      "portr_1.0.15-sse.2_Darwin_arm64.zip",
    );
  });

  it("rejects platforms without a published asset", () => {
    assert.throws(() => portrAssetName("1.0.13", "win32", "x64"), /no supported release asset/);
    assert.throws(() => portrAssetName("1.0.13", "linux", "riscv64"), /no supported release asset/);
  });
});
