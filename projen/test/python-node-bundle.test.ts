import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Project } from "projen";

import { publicFunctionExports } from "../src/module-exports.ts";
import { PythonNodeBundle } from "../src/python-node-bundle.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PythonNodeBundle", () => {
  it("generates convention-based build and check tasks", () => {
    const project = new Project({ name: "fixture" });
    const bundle = new PythonNodeBundle(project, {
      name: "auth",
      projectDirectory: "packages/py/auth",
    });

    assert.deepEqual(bundle.buildTask.steps[0]?.execArgs, [
      "bun",
      "node_modules/@dbx-tools/projen/tasks/python-node-bindings.ts",
      "--project",
      "packages/py/auth",
    ]);
    assert.deepEqual(bundle.checkTask.steps[0]?.execArgs, [
      ...bundle.buildTask.steps[0]!.execArgs!,
      "--check",
    ]);
    assert.ok(project.testTask.steps.some((step) => step.spawn === bundle.checkTask.name));
  });

  it("discovers re-exported functions and generates Python wrappers", () => {
    const directory = temporaryDirectory();
    const targetDirectory = packageDirectory(directory, "fixture-target");
    writeFileSync(
      join(targetDirectory, "index.ts"),
      [
        'import { basename } from "node:path";',
        'export const preserved = "original";',
        "export function fileName(value: string): string { return basename(value); }",
        'export function replaced(): string { return "original"; }',
        'export async function createSession(): Promise<string> { return "session"; }',
        "export async function token(login?: boolean): Promise<string> { return String(login); }",
        "export interface RetryOptions { attempts?: number; }",
        "export interface SessionOptions { host?: string; workspaceId?: string; scopes?: string[]; headers?: Record<string, string>; retry?: RetryOptions; }",
        "export interface SessionResult { class: string; workspaceId?: string; }",
        'export const SessionOptions = { defaults: () => ({ scopes: ["default"] }) };',
        "export function createConfigured(options: SessionOptions = {}): SessionOptions { return options; }",
        'export function sessionResult(): SessionResult { return { class: "chat-fast" }; }',
      ].join("\n"),
    );
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(join(entryDirectory, "index.ts"), 'export * from "fixture-target";\n');
    writeFileSync(
      join(directory, "handler.ts"),
      'export function replacement(): string { return "override"; }\n',
    );
    writeFixturePyproject(directory, [
      'package = "fixture-entry"',
      "",
      "[[tool.dbx_tools.node_bindings.function_overrides]]",
      'module = "fixture-target"',
      'export = "replaced"',
      'handler = "handler.ts"',
      'handler_export = "replacement"',
    ]);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());

    const nodeBindings = join(directory, "python/src/fixture/runtime/_generated/node");
    const generated = join(nodeBindings, "fixture_entry");
    const runtimePath = join(nodeBindings, "_runtime.js");
    const runtimeLoaderPath = join(nodeBindings, "_runtime.py");
    const bindingsPath = join(generated, "index.py");
    const packagePath = join(generated, "__init__.py");
    assert.match(readFileSync(runtimePath, "utf8"), /override/);

    const bindings = readFileSync(bindingsPath, "utf8");
    assert.match(bindings, /async def create_session\(\) -> str:/);
    assert.doesNotMatch(bindings, /pm\.eval|json\.loads/);
    assert.match(bindings, /async def token\(\n    login: bool \| object = _MISSING,\n\) -> str:/);
    assert.match(bindings, /class SessionOptions:/);
    assert.match(bindings, /workspace_id: str \| None/);
    assert.match(bindings, /headers: dict\[str, str\] \| None/);
    assert.match(bindings, /retry: RetryOptions \| None/);
    assert.match(
      bindings,
      /scopes: list\[str\] \| None = field\(\n        default_factory=lambda: \["default"\]/,
    );
    assert.match(bindings, /def create_configured\(/);
    assert.match(bindings, /\) -> SessionOptionsResponse:/);
    assert.match(bindings, /class SessionOptionsResponse\(TypedDict\):/);
    assert.match(bindings, /SessionResultResponse = TypedDict\(/);
    assert.match(bindings, /"class": str,/);
    assert.doesNotMatch(bindings, /\*\*kwargs/);
    assert.match(bindings, /def replaced\(\) -> str:/);
    assert.match(
      bindings,
      /await _invoke_positioned\("fixture_entry", "createSession", arguments\)/,
    );
    assert.match(readFileSync(runtimeLoaderPath, "utf8"), /class _NodeObject:/);
    assert.match(
      readFileSync(runtimePath, "utf8"),
      /Reflect\.apply\(target\[name\], target, args\)/,
    );
    assert.doesNotMatch(bindings, /preserved/);
    assert.equal(existsSync(packagePath), false);

    const check = runBindingTask(directory, "--check");
    assert.equal(check.exitCode, 0, check.stderr.toString());
  });

  it("always generates bindings beneath the Python package generated tree", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      "export function createSession(): { token(): string } { return { token: () => 'token' }; }\n",
    );
    writeFixturePyproject(directory, ['package = "fixture-entry"']);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());

    const nodeBindings = join(directory, "python/src/fixture/runtime/_generated/node");
    const generatedPackageDirectory = join(nodeBindings, "fixture_entry");
    assert.ok(readFileSync(join(nodeBindings, "_runtime.js"), "utf8").length > 0);
    assert.match(
      readFileSync(join(generatedPackageDirectory, "index.py"), "utf8"),
      /class CreateSessionReturnResult\(Protocol\):[\s\S]*async def token\([\s\S]*\) -> str:/,
    );
    assert.equal(existsSync(join(generatedPackageDirectory, "__init__.py")), false);
  });

  it("binds a portable package subpath while retaining the owning package", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "package.json"),
      JSON.stringify({
        name: "fixture-entry",
        type: "module",
        exports: { ".": "./index.ts", "./python": "./python.ts" },
      }),
    );
    writeFileSync(
      join(entryDirectory, "index.ts"),
      "export function browserOnly(): string { return 'browser'; }\n",
    );
    writeFileSync(
      join(entryDirectory, "python.ts"),
      "export function portable(): string { return 'portable'; }\n",
    );
    writeFixturePyproject(directory, [
      'package = "fixture-entry"',
      'entrypoint = "fixture-entry/python"',
    ]);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());

    const bindings = readFileSync(
      join(directory, "python/src/fixture/runtime/_generated/node/fixture_entry/index.py"),
      "utf8",
    );
    assert.match(bindings, /Regenerated from fixture-entry\/python/);
    assert.match(bindings, /def portable\(\) -> str:/);
    assert.doesNotMatch(bindings, /browser_only/);
  });

  it("binds multiple automatically generated package modules independently", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      ['export * as identity from "./identity.ts";', 'export * as config from "./config.ts";'].join(
        "\n",
      ),
    );
    writeFileSync(
      join(entryDirectory, "identity.ts"),
      "export function lockId(value: string): string { return value; }\n",
    );
    writeFileSync(
      join(entryDirectory, "config.ts"),
      "export async function loadConfig(): Promise<string> { return 'config'; }\n",
    );
    writeFixturePyproject(directory, [
      'package = "fixture-entry"',
      'modules = [ "identity", "config" ]',
    ]);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    const nodeBindings = join(directory, "python/src/fixture/runtime/_generated/node");
    const generated = join(nodeBindings, "fixture_entry");
    assert.match(readFileSync(join(generated, "identity.py"), "utf8"), /def lock_id\(/);
    assert.match(readFileSync(join(generated, "config.py"), "utf8"), /async def load_config\(/);
    assert.ok(readFileSync(join(nodeBindings, "_runtime.js"), "utf8").length > 0);
    assert.equal(existsSync(join(generated, "__init__.py")), false);

    const stale = join(generated, "removed.py");
    writeFileSync(stale, "stale = True\n");
    const staleCheck = runBindingTask(directory, "--check");
    assert.notEqual(staleCheck.exitCode, 0);
    assert.match(staleCheck.stderr.toString(), /removed\.py/);
    assert.equal(runBindingTask(directory).exitCode, 0);
    assert.equal(existsSync(stale), false);
  });

  it("accepts an array of binding tables for multiple Node packages", () => {
    const directory = temporaryDirectory();
    const first = packageDirectory(directory, "fixture-first");
    writeFileSync(
      join(first, "index.ts"),
      [
        'export * as constants from "./constants.ts";',
        'export * as identity from "./identity.ts";',
      ].join("\n"),
    );
    writeFileSync(join(first, "constants.ts"), "export const value = 1;\n");
    writeFileSync(
      join(first, "identity.ts"),
      "export function lockId(value: string): string { return value; }\n",
    );
    const second = packageDirectory(directory, "fixture-second");
    writeFileSync(join(second, "index.ts"), 'export * as config from "./config.ts";\n');
    writeFileSync(
      join(second, "config.ts"),
      "export async function loadConfig(): Promise<string> { return 'config'; }\n",
    );
    writeFixturePyprojectSource(
      directory,
      [
        "[[tool.dbx_tools.node_bindings]]",
        'package = "fixture-first"',
        "",
        "[[tool.dbx_tools.node_bindings]]",
        'package = "fixture-second"',
        'modules = [ "config" ]',
      ].join("\n"),
    );

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    const generated = join(directory, "python/src/fixture/runtime/_generated/node");
    assert.match(
      readFileSync(join(generated, "fixture_first/identity.py"), "utf8"),
      /def lock_id\(/,
    );
    assert.match(
      readFileSync(join(generated, "fixture_second/config.py"), "utf8"),
      /async def load_config\(/,
    );
    assert.equal(existsSync(join(generated, "fixture_first/constants.py")), false);
    assert.ok(readFileSync(join(generated, "_runtime.py"), "utf8").includes("_LOCK = Lock()"));
    assert.ok(readFileSync(join(generated, "_runtime.js"), "utf8").length > 0);
    assert.equal(existsSync(join(generated, "fixture_first/_runtime.js")), false);
    assert.equal(existsSync(join(generated, "fixture_second/_runtime.js")), false);
    assert.equal(existsSync(join(generated, "fixture_first/__init__.py")), false);
  });

  it("does not generate namespace package initializers", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      "export function value(): number { return 1; }\n",
    );
    writeFixturePyproject(directory, ['package = "fixture-entry"']);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(
      existsSync(
        join(directory, "python/src/fixture/runtime/_generated/node/fixture_entry/__init__.py"),
      ),
      false,
    );
  });

  it("fails fast for unsupported option property types", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      "export interface LoadOptions { value?: bigint; }\nexport function load(options: LoadOptions): void { void options; }\n",
    );
    writeFixturePyproject(directory, ['package = "fixture-entry"']);

    const result = runBindingTask(directory);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /load\.options\.value uses unsupported TypeScript type/);
  });

  it("generates records from Zod-inferred option types", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    symlinkSync(
      join(import.meta.dirname, "../../node_modules/zod"),
      join(directory, "node_modules/zod"),
      "dir",
    );
    writeFileSync(
      join(entryDirectory, "index.ts"),
      [
        'import { z } from "zod";',
        "export const LoadOptionsSchema = z.object({ profile: z.string().optional(), port: z.number().int().optional() });",
        "export type LoadOptions = z.input<typeof LoadOptionsSchema>;",
        "export type DashboardView = z.infer<typeof LoadOptionsSchema>;",
        "export function load(options: LoadOptions = {}): DashboardView { return LoadOptionsSchema.parse(options); }",
      ].join("\n"),
    );
    writeFixturePyproject(directory, ['package = "fixture-entry"']);

    const result = runBindingTask(directory);
    assert.equal(result.exitCode, 0, result.stderr.toString());

    const bindings = readFileSync(
      join(directory, "python/src/fixture/runtime/_generated/node/fixture_entry/index.py"),
      "utf8",
    );
    assert.match(bindings, /class LoadOptions:/);
    assert.match(bindings, /class DashboardViewResponse\(TypedDict\):/);
    assert.match(bindings, /profile: str \| None/);
    assert.match(bindings, /port: int \| float \| None/);

    const runtime = readFileSync(
      join(directory, "python/src/fixture/runtime/_generated/node/_runtime.js"),
      "utf8",
    );
    assert.doesNotMatch(runtime, /clone\(util\.mergeDefs\(/);
  });

  it("fails when JavaScript exports collide in Python", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      ["export function loadValue(): void {}", "export function load_value(): void {}"].join("\n"),
    );
    writeFixturePyproject(directory, ['package = "fixture-entry"']);

    const result = runBindingTask(directory);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /Python function name collision/);
  });

  it("fails fast for unsupported exported function shapes", () => {
    for (const [source, message] of [
      ["export function* values(): Generator<number> { yield 1; }", /Generator export values/],
      ["export declare function values(): void;", /Declaration-only function export values/],
    ] as const) {
      const directory = temporaryDirectory();
      const entryDirectory = packageDirectory(directory, "fixture-entry");
      writeFileSync(join(entryDirectory, "index.ts"), `${source}\n`);
      assert.throws(() => publicFunctionExports(join(entryDirectory, "index.ts")), message);
    }
  });

  it("rejects duplicate function overrides from pyproject", () => {
    const directory = temporaryDirectory();
    const entryDirectory = packageDirectory(directory, "fixture-entry");
    writeFileSync(
      join(entryDirectory, "index.ts"),
      "export function value(): number { return 1; }\n",
    );
    writeFileSync(join(directory, "handler.ts"), "export function value(): number { return 2; }\n");
    writeFixturePyproject(directory, [
      'package = "fixture-entry"',
      "",
      "[[tool.dbx_tools.node_bindings.function_overrides]]",
      'module = "fixture-target"',
      'export = "value"',
      'handler = "handler.ts"',
      "",
      "[[tool.dbx_tools.node_bindings.function_overrides]]",
      'module = "fixture-target"',
      'export = "value"',
      'handler = "handler.ts"',
    ]);

    const result = runBindingTask(directory);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /Duplicate function override/);
  });
});

function packageDirectory(root: string, name: string): string {
  const directory = join(root, "node_modules", name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, type: "module", exports: "./index.ts" }),
  );
  return directory;
}

function writeFixturePyproject(
  root: string,
  nodeBindings: readonly string[],
  options: { readonly moduleRoot?: string } = {},
): void {
  writeFixturePyprojectSource(
    root,
    ["[tool.dbx_tools.node_bindings]", ...nodeBindings].join("\n"),
    options,
  );
}

function writeFixturePyprojectSource(
  root: string,
  nodeBindings: string,
  options: { readonly moduleRoot?: string } = {},
): void {
  const directory = join(root, "python");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "pyproject.toml"),
    [
      "[tool.uv.build-backend]",
      'module-name = "fixture.runtime"',
      `module-root = ${JSON.stringify(options.moduleRoot ?? "src")}`,
      "",
      nodeBindings,
      "",
    ].join("\n"),
  );
}

function runBindingTask(
  root: string,
  ...args: string[]
): { exitCode: number; stderr: Buffer; stdout: Buffer } {
  const result = spawnSync(
    "bun",
    [
      join(import.meta.dirname, "../tasks/python-node-bindings.ts"),
      "--root",
      root,
      "--project",
      "python",
      ...args,
    ],
    { encoding: "buffer" },
  );
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? Buffer.alloc(0),
    stdout: result.stdout ?? Buffer.alloc(0),
  };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "python-node-bundle-"));
  temporaryDirectories.push(directory);
  return directory;
}
