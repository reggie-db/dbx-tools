#!/usr/bin/env -S bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { BunPlugin } from "bun";
import stdLibBrowser from "node-stdlib-browser";
import { header, makeReadonly, makeWritable } from "../src/generated.ts";

interface FunctionOverride {
  readonly handlerExport: string;
  readonly handlerFile: string;
  readonly targetExport: string;
  readonly targetModule: string;
}

const { values } = parseArgs({
  options: {
    check: { type: "boolean" },
    entry: { type: "string" },
    "function-override": { type: "string", multiple: true },
    output: { type: "string" },
    root: { type: "string" },
    "shim-root": { type: "string" },
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
const shimRoot = values["shim-root"] ? resolve(root, values["shim-root"]) : undefined;
const functionOverrides = (values["function-override"] ?? []).map(parseFunctionOverride);
const overridesByModule = groupOverrides(functionOverrides);
const shimEntry = "dbx-tools:python-entry";
const functionOverrideNamespace = "dbx-tools-function-override";
const shimAliases = shimRoot
  ? new Map([
      ["child_process", resolve(shimRoot, "child-process.ts")],
      ["crypto", resolve(shimRoot, "crypto.ts")],
      ["fs", resolve(shimRoot, "fs.ts")],
      ["fs/promises", resolve(shimRoot, "fs-promises.ts")],
      ["os", resolve(shimRoot, "os.ts")],
      ["path", resolve(shimRoot, "path.ts")],
      ["process", resolve(shimRoot, "process.ts")],
      ["readline", resolve(shimRoot, "readline.ts")],
      ["stream/promises", resolve(shimRoot, "stream-promises.ts")],
      ["url", resolve(shimRoot, "url.ts")],
    ])
  : undefined;
const standardAliases = stdLibBrowser as Record<string, string | undefined>;
const runtimePlugin: BunPlugin | undefined =
  shimAliases || functionOverrides.length > 0
    ? {
        name: "python-node-runtime",
        setup(build) {
          if (shimRoot) {
            build.onResolve({ filter: /^dbx-tools:python-entry$/ }, () => ({
              path: shimEntry,
              namespace: "dbx-tools-python",
            }));
            build.onLoad({ filter: /.*/, namespace: "dbx-tools-python" }, () => ({
              contents: [
                `import ${JSON.stringify(resolve(shimRoot, "bootstrap.ts"))};`,
                `export * from ${JSON.stringify(entrypoint)};`,
              ].join("\n"),
              loader: "ts",
            }));
          }
          build.onLoad({ filter: /.*/, namespace: functionOverrideNamespace }, ({ path }) => {
            const overrides = overridesByModule.get(path);
            if (!overrides) throw new Error(`Missing function overrides for ${path}`);
            const realModule = Bun.resolveSync(path, dirname(entrypoint));
            return {
              contents: [
                `export * from ${JSON.stringify(realModule)};`,
                ...overrides.map(
                  (override) =>
                    `export { ${override.handlerExport} as ${override.targetExport} } from ${JSON.stringify(override.handlerFile)};`,
                ),
              ].join("\n"),
              loader: "ts",
            };
          });
          build.onResolve({ filter: /.*/ }, ({ path }) => {
            if (overridesByModule.has(path)) {
              return { path, namespace: functionOverrideNamespace };
            }
            if (!shimAliases) return undefined;
            const moduleName = path.replace(/^node:/, "");
            const shim = shimAliases.get(moduleName) ?? shimAliases.get(path);
            if (shim) return { path: shim };
            const standard = standardAliases[moduleName];
            return standard
              ? { path: Bun.resolveSync(standard, dirname(fileURLToPath(import.meta.url))) }
              : undefined;
          });
        },
      }
    : undefined;
const bun = (
  globalThis as typeof globalThis & {
    Bun?: {
      build(options: {
        entrypoints: string[];
        format: "cjs";
        plugins?: BunPlugin[];
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
  entrypoints: [shimRoot ? shimEntry : entrypoint],
  format: "cjs",
  ...(runtimePlugin ? { plugins: [runtimePlugin] } : {}),
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

function parseFunctionOverride(value: string): FunctionOverride {
  const equals = value.indexOf("=");
  if (equals <= 0 || equals === value.length - 1) {
    throw new Error(
      `Invalid --function-override ${JSON.stringify(value)}; expected <module>#<export>=<file>#<export>`,
    );
  }
  const [targetModule, targetExport] = parseFunctionReference(value.slice(0, equals), "target");
  const [handlerFile, handlerExport] = parseFunctionReference(value.slice(equals + 1), "handler");
  return {
    targetModule,
    targetExport,
    handlerFile: resolve(root, handlerFile),
    handlerExport,
  };
}

function groupOverrides(
  overrides: readonly FunctionOverride[],
): ReadonlyMap<string, readonly FunctionOverride[]> {
  const grouped = new Map<string, FunctionOverride[]>();
  for (const override of overrides) {
    const current = grouped.get(override.targetModule) ?? [];
    if (current.some((candidate) => candidate.targetExport === override.targetExport)) {
      throw new Error(
        `Duplicate function override for ${override.targetModule}#${override.targetExport}`,
      );
    }
    current.push(override);
    grouped.set(override.targetModule, current);
  }
  return grouped;
}

function parseFunctionReference(value: string, side: string): [string, string] {
  const hash = value.lastIndexOf("#");
  const source = value.slice(0, hash);
  const exported = value.slice(hash + 1);
  if (hash <= 0 || !source || !/^[$A-Z_a-z][$\w]*$/.test(exported)) {
    throw new Error(
      `Invalid ${side} function reference ${JSON.stringify(value)}; expected <source>#<export>`,
    );
  }
  return [source, exported];
}
