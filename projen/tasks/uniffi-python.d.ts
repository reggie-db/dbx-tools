export interface TomlCodec {
  parse(source: string): unknown;
  stringify(document: unknown): string;
}

export interface PythonPackageMapping {
  readonly directory: string;
  readonly name: string;
  readonly version: string;
  readonly uniffi: boolean;
}

export interface PythonProjectInfo {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly uniffi: boolean;
}

/** Read the project identity and publication flag from parsed TOML metadata. */
export function pythonProjectInfo(source: string, toml: TomlCodec): PythonProjectInfo;

/** Stamp a temporary publication version and exact sibling dependencies. */
export function stampPythonProject(
  source: string,
  options: {
    readonly packages: readonly PythonPackageMapping[];
    readonly rewriteDependencies?: boolean;
    readonly usePackageVersions?: boolean;
    readonly toml: TomlCodec;
    readonly version: string;
  },
): string;

/** Return the target-specific UniFFI generator executable name. */
export function pythonBindingGeneratorName(crate: string, platform: string): string;

/** Build the canonical UniFFI Python generator argument list. */
export function pythonBindingGeneratorArgs(options: {
  readonly crate: string;
  readonly library: string;
  readonly output: string;
}): string[];

export interface InstalledPythonBindings {
  readonly bindings: string;
  readonly init: string;
  readonly library: string;
}

/** Generate and place one Python binding module and its native library. */
export function installPythonBindings(options: {
  readonly crate: string;
  readonly library: string;
  readonly module: string;
  readonly packageRoot: string;
  readonly platform: string;
  readonly readonly?: boolean;
  readonly run: (command: string, args: string[]) => void;
  readonly targetDirectory: string;
}): InstalledPythonBindings;
