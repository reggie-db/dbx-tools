import { deflateSync } from "node:zlib";

const SIZE = 32;
const RECTANGLES = [
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

/** Return the prior 32-pixel service glyph as a systray2 PNG or Windows ICO payload. */
export function modelGatewayTrayIcon(platform: NodeJS.Platform = process.platform): string {
  const color =
    platform === "darwin"
      ? ([0x00, 0x00, 0x00, 0xff] as const)
      : ([0xff, 0x36, 0x21, 0xff] as const);
  const png = encodePng(renderGlyph(color));
  return (platform === "win32" ? encodeIco(png) : png).toString("base64");
}

function renderGlyph(color: readonly [number, number, number, number]): Buffer {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (
        !RECTANGLES.some(
          ([left, top, width, height]) =>
            x >= left && x < left + width && y >= top && y < top + height,
        )
      ) {
        continue;
      }
      rgba.set(color, (y * SIZE + x) * 4);
    }
  }
  return rgba;
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
