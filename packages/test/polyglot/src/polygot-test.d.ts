export enum Language {
  TS = "ts",
  Python = "python",
}

type ImplementationLanguage = Exclude<Language, Language.TS>;
type ModuleLoader = () => Promise<Record<PropertyKey, unknown>>;

export interface PolyglotTarget<TModule, TKey extends keyof TModule> {
  moduleSpecifier: string;
  implementationName: TKey;
}

export interface ModuleReference<TName extends string, TLoader extends ModuleLoader> {
  packageIdentifier: TName;
  loader: TLoader;
}

export interface PolyglotOptions {
  identifiers?: Partial<Record<ImplementationLanguage, string>>;
}

export function moduleRef<const TName extends string, TLoader extends ModuleLoader>(
  packageIdentifier: TName,
  loader: TLoader,
): ModuleReference<TName, TLoader>;

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
