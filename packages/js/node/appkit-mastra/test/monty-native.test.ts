import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";

import { COMMAND_NOT_FOUND_EXIT_CODE } from "@dbx-tools/core";

import {
  ensureMontyNativeBinding,
  montyNativeBindingPackage,
} from "../src/monty-native.ts";

const requireFromHere = createRequire(import.meta.url);

describe("montyNativeBindingPackage", () => {
  it("maps Monty optionalDependencies triples", () => {
    assert.equal(montyNativeBindingPackage("darwin", "arm64"), "@pydantic/monty-darwin-arm64");
    assert.equal(montyNativeBindingPackage("darwin", "x64"), "@pydantic/monty-darwin-x64");
    assert.equal(montyNativeBindingPackage("linux", "x64"), "@pydantic/monty-linux-x64-gnu");
    assert.equal(montyNativeBindingPackage("linux", "arm64"), "@pydantic/monty-linux-arm64-gnu");
    assert.equal(montyNativeBindingPackage("win32", "x64"), "@pydantic/monty-win32-x64-msvc");
    assert.equal(montyNativeBindingPackage("linux", "ia32"), undefined);
  });
});

describe("ensureMontyNativeBinding", () => {
  it("does not install when the platform package already resolves", async () => {
    let installed = 0;

    await ensureMontyNativeBinding({
      install: async () => {
        installed += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    assert.equal(installed, 0);
  });

  it("installs the matching platform package with npm --no-save", async () => {
    const pkg = montyNativeBindingPackage();
    assert.ok(pkg);
    const missing = new Set([`${pkg}/package.json`]);
    const commands: string[][] = [];

    await ensureMontyNativeBinding({
      resolve: (specifier) => {
        if (missing.has(specifier)) throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
        return requireFromHere.resolve(specifier);
      },
      install: async (command, args, options) => {
        commands.push([command, ...args, options.cwd]);
        missing.clear();
        return { exitCode: 0, stdout: "added 1 package", stderr: "" };
      },
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.[0], "npm");
    assert.equal(commands[0]?.[1], "install");
    assert.match(commands[0]?.[2] ?? "", new RegExp(`^${pkg}@\\d`));
    assert.deepEqual(commands[0]?.slice(3, 5), ["--no-save", "--no-package-lock"]);
  });

  it("falls back to bun add when npm is missing", async () => {
    const pkg = montyNativeBindingPackage();
    assert.ok(pkg);
    const missing = new Set([`${pkg}/package.json`]);
    const commands: string[] = [];

    await ensureMontyNativeBinding({
      resolve: (specifier) => {
        if (missing.has(specifier)) throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
        return requireFromHere.resolve(specifier);
      },
      install: async (command, args) => {
        commands.push(command);
        if (command === "npm") {
          return { exitCode: COMMAND_NOT_FOUND_EXIT_CODE, stdout: "", stderr: "npm not found" };
        }
        missing.clear();
        assert.deepEqual([...args], ["add", `${pkg}@${montyVersion()}`, "--no-save"]);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    assert.deepEqual(commands, ["npm", "bun"]);
  });

  it("does not hide an npm install failure behind bun", async () => {
    const pkg = montyNativeBindingPackage();
    assert.ok(pkg);

    await assert.rejects(
      () =>
        ensureMontyNativeBinding({
          resolve: (specifier) => {
            if (specifier === `${pkg}/package.json`) {
              throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
            }
            return requireFromHere.resolve(specifier);
          },
          install: async () => ({ exitCode: 1, stdout: "", stderr: "EACCES" }),
        }),
      /EACCES/,
    );
  });
});

function montyVersion(): string {
  return (requireFromHere("@pydantic/monty/package.json") as { version: string }).version;
}
