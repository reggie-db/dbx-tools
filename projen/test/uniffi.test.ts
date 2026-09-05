import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExplicitInterfaceReexports,
  addTypeScriptExtensionsToBindingImports,
  makeDefaultedInterfaceParametersOptional,
  mergePythonBindingExports,
} from "../src/uniffi.ts";

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

  it("exports generated Python bindings directly from the package root", () => {
    const result = mergePythonBindingExports("", '__all__ = ["token", "AuthClient"]\n', {
      crate: "fixture-auth",
      file: "fixture/__init__.py",
    });

    assert.match(result, /from \.bindings import \*/);
    assert.match(result, /__all__ = \[\n    "AuthClient",\n    "token",\n\]/);
    assert.equal(
      mergePythonBindingExports(result, '__all__ = ["token", "AuthClient"]\n', {
        crate: "fixture-auth",
        file: "fixture/__init__.py",
      }),
      result,
    );
  });

  it("rejects non-generated Python package exports", () => {
    const direct = 'from .runtime import Runtime\n\n__all__ = ["Runtime"]\n';
    assert.throws(
      () =>
        mergePythonBindingExports(direct, '__all__ = ["AuthClient"]\n', {
          crate: "fixture-auth",
          file: "fixture/__init__.py",
        }),
      /non-generated Python package exports/,
    );
  });

  it("requires a literal binding export list", () => {
    assert.throws(
      () =>
        mergePythonBindingExports("", "class AuthClient: ...\n", {
          crate: "fixture-auth",
          file: "fixture/__init__.py",
        }),
      /literal __all__/,
    );
  });
});
