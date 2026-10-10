import { deflateSync } from "node:zlib";

const SIZE = 32;
const MODEL_PROXY_RECTANGLES = [
  [4, 13, 6, 6],
  [24, 4, 6, 6],
  [24, 13, 6, 6],
  [24, 22, 6, 6],
  [10, 15, 6, 2],
  [16, 6, 2, 20],
  [18, 6, 6, 2],
  [18, 15, 6, 2],
  [18, 24, 6, 2],
] as const;
const GRAPHITI_BOLT_RECTANGLES = [
  [10, 5, 10, 2],
  [17, 7, 2, 2],
  [15, 9, 7, 2],
] as const;

/** Plain glyphs available to identify dbx-tools system-tray services. */
export type ServiceTrayGlyph = "model-proxy" | "graphiti" | "lakebase";

/** Return a service glyph as a systray2 PNG or Windows ICO payload. */
export function serviceTrayIcon(
  glyph: ServiceTrayGlyph = "model-proxy",
  platform: NodeJS.Platform = process.platform,
): string {
  const color =
    platform === "darwin"
      ? ([0x00, 0x00, 0x00, 0xff] as const)
      : ([0xff, 0x36, 0x21, 0xff] as const);
  const png = encodePng(renderGlyph(glyph, color));
  return (platform === "win32" ? encodeIco(png) : png).toString("base64");
}

function renderGlyph(
  glyph: ServiceTrayGlyph,
  color: readonly [number, number, number, number],
): Buffer {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const opacity = glyphOpacity(glyph, x, y);
      if (opacity === 0) continue;
      rgba.set([color[0], color[1], color[2], Math.round(color[3] * opacity)], (y * SIZE + x) * 4);
    }
  }
  return rgba;
}

function glyphOpacity(glyph: ServiceTrayGlyph, x: number, y: number): number {
  switch (glyph) {
    case "model-proxy":
      return modelProxyGlyphContains(x, y) ? 1 : 0;
    case "graphiti":
      return graphitiGlyphContains(x, y) ? 1 : 0;
    case "lakebase":
      return lakebaseGlyphOpacity(x, y);
  }
}

function modelProxyGlyphContains(x: number, y: number): boolean {
  return MODEL_PROXY_RECTANGLES.some(
    ([left, top, width, height]) => x >= left && x < left + width && y >= top && y < top + height,
  );
}

function graphitiGlyphContains(x: number, y: number): boolean {
  // Preserve the Graphiti bot mark through its bolt, antennae, outlined head, and ringed eyes.
  const bolt = GRAPHITI_BOLT_RECTANGLES.some(
    ([left, top, width, height]) => x >= left && x < left + width && y >= top && y < top + height,
  );
  const head =
    (y >= 10 && y < 13 && x >= 6 && x < 26) ||
    (y >= 13 && y < 25 && x >= 4 && x < 7) ||
    (y >= 13 && y < 25 && x >= 25 && x < 28) ||
    (y >= 24 && y < 27 && x >= 6 && x < 26);
  const antenna = y >= 3 && y < 11 && ((x >= 7 && x < 9) || (x >= 23 && x < 25));
  return bolt || head || antenna || graphitiEyeContains(x, y, 11) || graphitiEyeContains(x, y, 21);
}

function graphitiEyeContains(x: number, y: number, centerX: number): boolean {
  const distance = (x - centerX) ** 2 + (y - 18) ** 2;
  return distance >= 10 && distance <= 25;
}

function lakebaseGlyphOpacity(x: number, y: number): number {
  if (x < 5 || x >= 27) return 0;
  if (y >= 5 && y < 11) return 0.45;

  // Keep the official mark's light middle band, dark wave channel, and solid lower band.
  const middleBoundary = 19 - Math.round(Math.sin(((x - 5) / 21) * Math.PI * 2));
  if (y >= 13 && y < middleBoundary) return 0.45;
  if (y >= middleBoundary + 3 && y < 27) return 1;
  return 0;
}

function encodePng(rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8;
  header[9] = 6;

  const scanlines = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    const offset = y * (SIZE * 4 + 1);
    scanlines[offset] = 0;
    rgba.copy(scanlines, offset + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (const byte of data) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function encodeIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = SIZE;
  header[7] = SIZE;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}
