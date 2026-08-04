import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import express from "express";
import { configureStaticDelivery } from "../src/_static-delivery.ts";

const STATIC_DIR = mkdtempSync(join(tmpdir(), "static-delivery-"));
const PAYLOAD = `const value = "${"compressible".repeat(2048)}";`;

writeFileSync(join(STATIC_DIR, "chunk-abcdefgh.js"), PAYLOAD);
writeFileSync(join(STATIC_DIR, "app.js"), PAYLOAD);

after(() => rmSync(STATIC_DIR, { recursive: true, force: true }));

describe("static frontend delivery", () => {
  it("compresses assets and applies content-aware cache headers", async () => {
    const app = express();
    configureStaticDelivery(app, STATIC_DIR);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    try {
      const hashed = await fetch(`http://127.0.0.1:${port}/chunk-abcdefgh.js`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      assert.equal(hashed.status, 200);
      assert.equal(hashed.headers.get("content-encoding"), "gzip");
      assert.equal(hashed.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.equal(await hashed.text(), PAYLOAD);

      const unhashed = await fetch(`http://127.0.0.1:${port}/app.js`);
      assert.equal(unhashed.status, 200);
      assert.equal(unhashed.headers.get("cache-control"), "no-cache");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
