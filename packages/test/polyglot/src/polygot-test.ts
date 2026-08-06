/**
 * Typed cross-runtime test registration for matching TypeScript and Python APIs.
 *
 * Generated package barrels export `PACKAGE_IDENTIFIER`, so the common form
 * needs only a loader, checked implementation key, and shared test callback.
 *
 * @example
 * await polygotTest(
 *   () => import("@dbx-tools/shared-core"),
 *   "object",
 *   (implementation, language) => {
 *     describe(`object.toStableKey (${language})`, () => {
 *       it("canonicalizes objects", () => {
 *         assert.equal(implementation.toStableKey({ b: 2 }), "expected");
 *       });
 *     });
 *   },
 * );
 *
 * A loader without generated metadata can instead provide
 * `{ packageIdentifier, loader }`. An explicit
 * `options.identifiers[Language.Python]` module bypasses package inference.
 *
 * @module
 */
import { findModule } from "./python-test.ts";

/** Runtime label passed to every shared test-definition callback. */
export enum Language {
  TS = "ts",
  Python = "python",
}

type ImplementationLanguage = Exclude<Language, Language.TS>;
type ModuleLoader = () => Promise<Record<PropertyKey, unknown>>;

/** Metadata passed to Python discovery when no explicit identifier is configured. */
export interface PolyglotTarget<TModule, TKey extends keyof TModule> {
  moduleSpecifier: string;
  implementationName: TKey;
}

/** A typed loader paired with an explicit package identifier. */
export interface ModuleReference<TName extends string, TLoader extends ModuleLoader> {
  packageIdentifier: TName;
  loader: TLoader;
}

/** Optional language-specific overrides and future test orchestration settings. */
export interface PolyglotOptions {
  identifiers?: Partial<Record<ImplementationLanguage, string>>;
}

/** Create an explicit package-identifier and loader pair. */
export function moduleRef<const TName extends string, TLoader extends ModuleLoader>(
  packageIdentifier: TName,
  loader: TLoader,
): ModuleReference<TName, TLoader> {
  return { packageIdentifier, loader };
}

export function polygotTest<
  TLoader extends ModuleLoader,
  TModule extends Awaited<ReturnType<TLoader>>,
  const TKey extends keyof TModule & string,
>(
  loader: TLoader,
  implementationName: TKey,
  tests: (implementation: TModule[TKey], language: Language) => void,
  options?: PolyglotOptions,
): Promise<void>;
export function polygotTest<
  const TPackageIdentifier extends string,
  TLoader extends ModuleLoader,
  TModule extends Awaited<ReturnType<TLoader>>,
  const TKey extends keyof TModule & string,
>(
  reference: ModuleReference<TPackageIdentifier, TLoader>,
  implementationName: TKey,
  tests: (implementation: TModule[TKey], language: Language) => void,
  options?: PolyglotOptions,
): Promise<void>;

/**
 * Run one synchronous test-definition callback against TypeScript and Python.
 *
 * `PACKAGE_IDENTIFIER` is read only when Python inference needs it. An explicit
 * Python identifier bypasses that lookup. An explicit {@link ModuleReference}
 * supplies identity for loaders without generated barrel metadata.
 */
export async function polygotTest(
  source: ModuleLoader | ModuleReference<string, ModuleLoader>,
  implementationName: PropertyKey,
  tests: (implementation: unknown, language: Language) => void,
  options: PolyglotOptions = {},
): Promise<void> {
  let reference: ModuleReference<string, ModuleLoader> | undefined;
  let loader: ModuleLoader;
  if (typeof source === "function") {
    loader = source;
  } else {
    reference = source;
    loader = source.loader;
  }
  const module = await loader();
  if (!(implementationName in module)) {
    throw new Error(`TypeScript module does not export ${String(implementationName)}`);
  }

  tests(module[implementationName], Language.TS);
  const identifier = options.identifiers?.[Language.Python];
  const pythonImplementation = identifier
    ? findModule(identifier)
    : findModule({
        moduleSpecifier: reference?.packageIdentifier ?? packageIdentifier(module),
        implementationName,
      });
  tests(pythonImplementation, Language.Python);
}

function packageIdentifier(module: Record<PropertyKey, unknown>): string {
  const identifier = module.PACKAGE_IDENTIFIER;
  if (typeof identifier !== "string" || !identifier) {
    throw new Error(
      "Loaded module does not export string PACKAGE_IDENTIFIER; pass { packageIdentifier, loader } instead",
    );
  }
  return identifier;
}
