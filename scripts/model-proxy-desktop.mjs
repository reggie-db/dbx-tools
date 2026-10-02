/**
 * Builds or verifies the committed Model Proxy desktop frontend.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const ROOT = resolve(import.meta.dirname, "..");
const DESKTOP = join(ROOT, "packages/rs/model-proxy/desktop");
const DIST = join(DESKTOP, "dist");
const ICON = join(DESKTOP, "src-tauri/icons/icon.png");
const WRITE = process.argv.includes("--write");

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}

function desktopIcon() {
  const width = 64;
  const height = 64;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  const rectangles = [
    [8, 26, 12, 12],
    [48, 8, 12, 12],
    [48, 26, 12, 12],
    [48, 44, 12, 12],
    [20, 30, 12, 4],
    [32, 12, 4, 40],
    [36, 12, 12, 4],
    [36, 30, 12, 4],
    [36, 48, 12, 4],
  ];
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    for (let x = 0; x < width; x += 1) {
      const cornerX = x < 12 ? 12 - x : x >= 52 ? x - 51 : 0;
      const cornerY = y < 12 ? 12 - y : y >= 52 ? y - 51 : 0;
      const insideBadge = cornerX === 0 || cornerY === 0 || cornerX ** 2 + cornerY ** 2 <= 144;
      const insideGlyph = rectangles.some(
        ([left, top, rectWidth, rectHeight]) =>
          x >= left && x < left + rectWidth && y >= top && y < top + rectHeight,
      );
      const color = insideGlyph
        ? [0xff, 0x36, 0x21, 0xff]
        : insideBadge
          ? [0xf9, 0xf7, 0xf4, 0xff]
          : [0, 0, 0, 0];
      const offset = row + 1 + x * 4;
      pixels.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function build(outdir) {
  const result = await Bun.build({
    entrypoints: [join(DESKTOP, "index.html")],
    outdir,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    minify: true,
    splitting: true,
    sourcemap: "none",
  });
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    throw new Error("Model Proxy desktop build failed");
  }
}

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) result.push(join(entry.parentPath, entry.name));
  }
  return result.sort();
}

async function verify(expected, actual) {
  const expectedFiles = (await files(expected)).map((path) => relative(expected, path));
  const actualFiles = (await files(actual)).map((path) => relative(actual, path));
  if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles)) {
    throw new Error("Model Proxy desktop assets are stale; run bun run model-proxy:desktop-build");
  }
  for (const path of expectedFiles) {
    const [expectedBytes, actualBytes] = await Promise.all([
      readFile(join(expected, path)),
      readFile(join(actual, path)),
    ]);
    if (!expectedBytes.equals(actualBytes)) {
      throw new Error(
        `Model Proxy desktop asset ${path} is stale; run bun run model-proxy:desktop-build`,
      );
    }
  }
}

if (WRITE) {
  await rm(DIST, { recursive: true, force: true });
  await build(DIST);
  await writeFile(ICON, desktopIcon());
} else {
  const temporary = await mkdtemp(join(tmpdir(), "dbx-model-proxy-desktop-"));
  try {
    await build(temporary);
    await verify(DIST, temporary);
    if (!(await readFile(ICON)).equals(desktopIcon())) {
      throw new Error("Model Proxy desktop icon is stale; run bun run model-proxy:desktop-build");
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
