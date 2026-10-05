import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelGatewayTrayIcon } from "../src/_tray-icon.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("model gateway tray icon", () => {
  it("renders the prior monochrome macOS glyph as PNG", () => {
    const icon = Buffer.from(modelGatewayTrayIcon("darwin"), "base64");

    assert.deepEqual(icon.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
    assert.equal(icon.readUInt32BE(16), 32);
    assert.equal(icon.readUInt32BE(20), 32);
  });

  it("wraps the prior glyph PNG in an ICO container on Windows", () => {
    const icon = Buffer.from(modelGatewayTrayIcon("win32"), "base64");

    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), 1);
    assert.equal(icon[6], 32);
    assert.equal(icon[7], 32);
    assert.deepEqual(icon.subarray(22, 22 + PNG_SIGNATURE.length), PNG_SIGNATURE);
  });
});
