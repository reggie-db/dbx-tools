#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { header, makeReadonly, makeWritable } from "../src/generated.ts";

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    root: { type: "string" },
  },
});

const root = values.root
  ? resolve(values.root)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = join(root, "packages/js/node/auth/src/_python-bridge.ts");
const output = join(root, "packages/py/auth/src/dbx_tools/auth/_runtime.js");
const bun = (
  globalThis as typeof globalThis & {
    Bun?: {
      build(options: {
        entrypoints: string[];
        format: "cjs";
        target: "browser";
        write: false;
      }): Promise<{
        success: boolean;
        logs: unknown[];
        outputs: { text(): Promise<string> }[];
      }>;
    };
  }
).Bun;
if (!bun) throw new Error("python-auth-bridge must run with Bun");

const result = await bun.build({
  entrypoints: [entrypoint],
  format: "cjs",
  target: "browser",
  write: false,
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  throw new Error("Could not bundle the Python authentication runtime");
}
if (result.outputs.length !== 1) {
  throw new Error(`Expected one Python authentication bundle, received ${result.outputs.length}`);
}

const body = await result.outputs[0].text();
const generated = `${header({
  tool: "projen/tasks/python-auth-bridge.ts",
  source: "@dbx-tools/auth for PythonMonkey",
})}\n${body}`;
const destination = relative(root, output);

if (values.check) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== generated) {
    throw new Error(
      `Generated Python authentication runtime is stale: ${destination}. Run bun run auth:python-bridge.`,
    );
  }
  console.log(`verified ${destination}`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  makeWritable(output);
  writeFileSync(output, generated);
  makeReadonly(output);
  console.log(`generated ${destination}`);
}
