import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { serviceTrayIcon, type ServiceTrayGlyph } from "../src/icon.ts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GLYPHS = [
  "model-proxy",
  "graphiti",
  "lakebase",
] as const satisfies readonly ServiceTrayGlyph[];

describe("CLI service tray icon", () => {
  it("renders the monochrome macOS glyph as PNG", () => {
    const icon = Buffer.from(serviceTrayIcon("model-proxy", "darwin"), "base64");

    assert.deepEqual(icon.subarray(0, PNG_SIGNATURE.length), PNG_SIGNATURE);
    assert.equal(icon.readUInt32BE(16), 32);
    assert.equal(icon.readUInt32BE(20), 32);
  });

  it("renders a unique payload for every service glyph", () => {
    const icons = GLYPHS.map((glyph) => serviceTrayIcon(glyph, "darwin"));

    assert.equal(new Set(icons).size, GLYPHS.length);
  });

  it("wraps the glyph PNG in an ICO container on Windows", () => {
    const icon = Buffer.from(serviceTrayIcon("graphiti", "win32"), "base64");

    assert.equal(icon.readUInt16LE(2), 1);
    assert.equal(icon.readUInt16LE(4), 1);
    assert.equal(icon[6], 32);
    assert.equal(icon[7], 32);
    assert.deepEqual(icon.subarray(22, 22 + PNG_SIGNATURE.length), PNG_SIGNATURE);
  });
});
