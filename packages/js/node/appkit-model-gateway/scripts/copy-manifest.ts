import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy the canonical AppKit manifest into the package discovery layout.
 *
 * @module
 */

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDirectory, "../src/manifest.json");
const destination = resolve(scriptDirectory, "../dist/plugins/model-gateway/manifest.json");

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
