#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { header, makeReadonly, makeWritable } from "../src/generated.ts";

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    entry: { type: "string" },
    output: { type: "string" },
    root: { type: "string" },
    source: { type: "string" },
  },
});
if (!values.entry || !values.output || !values.source) {
  throw new Error("Expected --entry, --output, and --source");
}

const root = values.root
  ? resolve(values.root)
  : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const entrypoint = resolve(root, values.entry);
const output = resolve(root, values.output);
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
if (!bun) throw new Error("python-node-bindings must run with Bun");

const result = await bun.build({
  entrypoints: [entrypoint],
  format: "cjs",
  target: "browser",
  write: false,
});
if (!result.success) {
  for (const message of result.logs) console.error(message);
  throw new Error(`Could not bundle ${values.source}`);
}
if (result.outputs.length !== 1) {
  throw new Error(`Expected one JavaScript bundle, received ${result.outputs.length}`);
}

const body = await result.outputs[0].text();
const generated = `${header({
  tool: "projen/tasks/python-node-bindings.ts",
  source: values.source,
})}\n${body}`;
const destination = relative(root, output);

if (values.check) {
  if (!existsSync(output) || readFileSync(output, "utf8") !== generated) {
    throw new Error(`Generated JavaScript runtime is stale: ${destination}`);
  }
  console.log(`verified ${destination}`);
} else {
  mkdirSync(dirname(output), { recursive: true });
  makeWritable(output);
  writeFileSync(output, generated);
  makeReadonly(output);
  console.log(`generated ${destination}`);
}
