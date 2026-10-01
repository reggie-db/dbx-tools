import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse, stringify } from "smol-toml";
import {
  addExplicitInterfaceReexports,
  addTypeScriptExtensionsToBindingImports,
  makeDefaultedInterfaceParametersOptional,
  removeObsoleteInterfaceAliases,
} from "../src/uniffi.ts";
import {
  installPythonBindings,
  pythonBindingGeneratorArgs,
  pythonBindingGeneratorName,
  stampPythonProject,
} from "../tasks/uniffi-python.js";

describe("UniFFI binding repair", () => {
  it("makes implementation-defaulted interface parameters optional", () => {
    const source = `export interface AuthLike {
  token(login: boolean | undefined, asyncOpts_?: { signal: AbortSignal }): Promise<Token>;
}
export class Auth implements AuthLike {
  async token(login: boolean | undefined = undefined, asyncOpts_?: { signal: AbortSignal }): Promise<Token> {}
}`;

    assert.match(
      makeDefaultedInterfaceParametersOptional(source),
      /token\(login\?: boolean \| undefined, asyncOpts_\?:/,
    );
  });

  it("adds TypeScript extensions to generated relative binding imports", () => {
    const source = [
      "export * from './_bindings';",
      'import bindings from "./_bindings";',
      "import ffi from './_bindings-ffi';",
      "import existing from './_bindings.ts';",
    ].join("\n");

    assert.equal(
      addTypeScriptExtensionsToBindingImports(source),
      [
        "export * from './_bindings.ts';",
        'import bindings from "./_bindings.ts";',
        "import ffi from './_bindings-ffi.ts';",
        "import existing from './_bindings.ts';",
      ].join("\n"),
    );
  });

  it("removes obsolete generated interface aliases", () => {
    const source = `export interface AuthLike {}
/**
 * @deprecated Use \`AuthLike\` instead.
 */
export type AuthInterface = AuthLike;
export class Auth implements AuthLike {}`;
    assert.equal(
      removeObsoleteInterfaceAliases(source),
      "export interface AuthLike {}\nexport class Auth implements AuthLike {}",
    );
  });

  it("explicitly re-exports generated interfaces from the facade", () => {
    const facade = "export * from './_bindings';\n";
    const source = `export interface StorageAdapter {
  load(profile: string): Promise<string | undefined>;
}
export class StorageAdapterImpl implements StorageAdapter {}`;

    assert.equal(
      addExplicitInterfaceReexports(facade, [{ specifier: "./_bindings", source }]),
      "export * from './_bindings';\nexport type { StorageAdapter } from './_bindings';\n",
    );
  });

  it("uses identical local and release Python binding placement", () => {
    const root = mkdtempSync(join(tmpdir(), "uniffi-python-"));
    try {
      const crate = "fixture-core";
      const library = join(root, "fixture_core.dll");
      const targetDirectory = join(root, "target", "release");
      const generator = join(targetDirectory, pythonBindingGeneratorName(crate, "win32"));
      mkdirSync(targetDirectory, { recursive: true });
      writeFileSync(generator, "");
      writeFileSync(library, "native");

      const generate = (name: string, readonly: boolean) => {
        const packageRoot = join(root, name);
        const legacy = join(packageRoot, "src", "fixture", "core_rs", "_generated");
        mkdirSync(legacy, { recursive: true });
        writeFileSync(join(legacy, "old.py"), "old");
        const calls: Array<{ command: string; args: string[] }> = [];
        const result = installPythonBindings({
          crate,
          library,
          module: "fixture.core_rs",
          packageRoot,
          platform: "win32",
          readonly,
          run: (command, args) => {
            calls.push({ command, args });
            const output = args[args.indexOf("--out-dir") + 1]!;
            writeFileSync(join(output, "fixture_core.py"), "VALUE = 1\n");
          },
          targetDirectory,
        });
        return {
          bindings: readFileSync(result.bindings, "utf8"),
          init: readFileSync(result.init, "utf8"),
          library: readFileSync(result.library, "utf8"),
          readonly: (statSync(result.bindings).mode & 0o200) === 0,
          calls,
          legacyExists: existsSync(legacy),
        };
      };

      const local = generate("local", true);
      const release = generate("release", false);
      assert.equal(local.bindings, release.bindings);
      assert.equal(local.init, release.init);
      assert.equal(local.library, release.library);
      assert.equal(local.readonly, true);
      assert.equal(release.readonly, false);
      assert.equal(local.calls[0]?.command, generator);
      assert.deepEqual(
        local.calls[0]?.args,
        pythonBindingGeneratorArgs({
          crate,
          library,
          output: local.calls[0]!.args[local.calls[0]!.args.indexOf("--out-dir") + 1]!,
        }),
      );
      assert.equal(local.legacyExists, false);
      assert.equal(release.legacyExists, false);
    } finally {
      chmodSync(root, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one structured publication dependency mapping", () => {
    const source = [
      "# generated",
      "",
      "[project]",
      'name = "fixture-app"',
      'version = "0.0.0"',
      "dependencies = [",
      '  "fixture-core @ git+https://example.invalid/repo.git@main#subdirectory=python/core",',
      '  "external>=1",',
      "]",
      "",
    ].join("\n");
    const options = {
      packages: [{ name: "fixture-core", directory: "python/core" }],
      toml: { parse, stringify },
      version: "1.2.3",
    };
    const local = stampPythonProject(source, options);
    const release = stampPythonProject(source, options);
    assert.equal(local, release);
    assert.deepEqual(parse(local).project, {
      name: "fixture-app",
      version: "1.2.3",
      dependencies: ["fixture-core==1.2.3", "external>=1"],
    });
  });
});
