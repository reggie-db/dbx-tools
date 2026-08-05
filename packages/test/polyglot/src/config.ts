import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "@dbx-tools/core";

type ConfigKey = string | readonly string[];
type ConfigSource = "config" | "env" | "dotenv" | "bundle" | "app";

interface ConfigOptions {
  scope?: string | readonly string[];
  prefix?: string | readonly string[];
  cwd?: string;
  data?: Record<string, string | readonly string[] | null | undefined>;
  sources?: ConfigSource | readonly ConfigSource[];
}

const CONFIG_BUNDLE_KEY = "DBX_TOOLS_CONFIG_BUNDLE";
const CONFIG_APP_KEY = "DBX_TOOLS_CONFIG_APP";
const CONFIG_DOTENV_KEY = "DBX_TOOLS_CONFIG_DOTENV";
const DATABRICKS_APP_ENV_KEY = "DBX_TOOLS_DATABRICKS_APP_ENV";

export function configName(input: ConfigKey, options: ConfigOptions = {}): string {
  return config.name(input, options);
}

export function environmentText(
  environment: Record<string, string>,
  input: ConfigKey,
  options: ConfigOptions = {},
): string | null {
  return withEnvironment(
    environment,
    () => config.text(input, { ...options, sources: "env" }) ?? null,
  );
}

export function configString(
  configured: unknown,
  environment: Record<string, string>,
  input: ConfigKey,
  options: ConfigOptions = {},
): string | null {
  return withEnvironment(
    environment,
    () => config.string(configured, input, { ...options, sources: "env" }) ?? null,
  );
}

export function configBoolean(configured: unknown): boolean | null {
  return config.boolean(configured, "POLYGLOT_UNUSED", config.ENV_ONLY) ?? null;
}

export function configPositiveNumber(configured: unknown, fallback: number): number {
  return config.positiveNumber(configured, "POLYGLOT_UNUSED", fallback, config.ENV_ONLY);
}

export function configPositiveInt(configured: unknown, fallback: number): number {
  return config.positiveInt(configured, "POLYGLOT_UNUSED", fallback, config.ENV_ONLY);
}

export function configList(configured: string | readonly string[] | null): string[] {
  return config.list(configured, "POLYGLOT_UNUSED", undefined, config.ENV_ONLY);
}

export function configDataValues(
  data: Record<string, string | readonly string[] | null>,
  environment: Record<string, string>,
  input: ConfigKey,
  sources?: ConfigSource[],
): string | null {
  return withEnvironment(
    environment,
    () => config.text(input, { data, scope: [], sources }) ?? null,
  );
}

export function isDatabricksAppEnv(source: Record<string, string | undefined>): boolean {
  return config.isDatabricksAppEnv(source);
}

export function dotenvValues(
  files: Record<string, string>,
  nodeEnv: string | null,
  cwd: string,
  inputs: ConfigKey[],
  options: ConfigOptions = {},
  projectRoot = true,
  environment: Record<string, string> = {},
): (string | undefined)[] {
  return withProject((root) => {
    if (projectRoot) writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    for (const [relativePath, contents] of Object.entries(files)) {
      writeFixtureFile(root, relativePath, contents);
    }
    const workingDirectory = join(root, cwd);
    mkdirSync(workingDirectory, { recursive: true });
    return withEnvironment({ ...fileSourceEnvironment(), NODE_ENV: nodeEnv, ...environment }, () =>
      inputs.map((input) =>
        config.text(input, { ...options, cwd: workingDirectory, sources: "dotenv" }),
      ),
    );
  });
}

export function dotenvCachedValue(initial: string, updated: string): (string | undefined)[] {
  return withProject((root) => {
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    const path = join(root, ".env");
    writeFileSync(path, `SAMPLE=${initial}\n`);
    return withEnvironment(fileSourceEnvironment(), () => {
      const first = config.text("SAMPLE", { cwd: root, scope: [], sources: "dotenv" });
      writeFileSync(path, `SAMPLE=${updated}\n`);
      const second = config.text("SAMPLE", { cwd: root, scope: [], sources: "dotenv" });
      return [first, second];
    });
  });
}

export function appValues(
  contents: string,
  inputs: ConfigKey[],
  options: ConfigOptions = {},
  environment: Record<string, string> = {},
): (string | undefined)[] {
  return withProject((root) => {
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, "app.yaml"), contents);
    return withEnvironment({ ...fileSourceEnvironment(), ...environment }, () =>
      inputs.map((input) => config.text(input, { ...options, cwd: root, sources: "app" })),
    );
  });
}

export function appCachedValue(initial: string, updated: string): (string | undefined)[] {
  return withProject((root) => {
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    const path = join(root, "app.yaml");
    writeFileSync(path, `env:\n  - name: SAMPLE\n    value: ${initial}\n`);
    return withEnvironment(fileSourceEnvironment(), () => {
      const first = config.text("SAMPLE", { cwd: root, scope: [], sources: "app" });
      writeFileSync(path, `env:\n  - name: SAMPLE\n    value: ${updated}\n`);
      const second = config.text("SAMPLE", { cwd: root, scope: [], sources: "app" });
      return [first, second];
    });
  });
}

export function bundleValues(
  payload: Record<string, unknown>,
  status: number,
  inputs: ConfigKey[],
  options: ConfigOptions = {},
  environment: Record<string, string> = {},
  currentWorkingDirectory = false,
): { values: (string | undefined)[]; calls: number } {
  return withProject((root) => {
    writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
    writeFileSync(join(root, "databricks.yml"), "bundle: {}\n");
    const output = join(root, ".polyglot-bundle-output");
    const counter = join(root, ".polyglot-bundle-calls");
    writeFileSync(output, JSON.stringify(payload));
    writeFileSync(join(root, ".polyglot-bundle-status"), String(status));
    return withEnvironment(
      {
        ...fileSourceEnvironment(),
        ...environment,
      },
      () => {
        const originalCwd = process.cwd();
        if (currentWorkingDirectory) process.chdir(root);
        try {
          const cwd = currentWorkingDirectory ? process.cwd() : root;
          const values = inputs.map((input) => config.text(input, { ...options, cwd }));
          return { values, calls: lineCount(counter) };
        } finally {
          process.chdir(originalCwd);
        }
      },
    );
  });
}

function fileSourceEnvironment(): Record<string, null> {
  return {
    [CONFIG_BUNDLE_KEY]: null,
    [CONFIG_APP_KEY]: null,
    [CONFIG_DOTENV_KEY]: null,
    [DATABRICKS_APP_ENV_KEY]: null,
    DATABRICKS_APP_NAME: null,
    DATABRICKS_APP_PORT: null,
    DATABRICKS_HOST: null,
  };
}

function withProject<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "dbx-tools-config-polyglot-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeFixtureFile(root: string, relativePath: string, contents: string): void {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function withEnvironment<T>(changes: Record<string, string | null>, callback: () => T): T {
  const original = new Map(Object.keys(changes).map((key) => [key, process.env[key]] as const));
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete process.env[key];
      else process.env[key] = value;
    }
    return callback();
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}
