import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExplicitInterfaceReexports,
  makeDefaultedInterfaceParametersOptional,
} from "../src/uniffi.ts";

describe("UniFFI TypeScript binding repair", () => {
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
});
