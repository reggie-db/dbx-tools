import { randomBytes, randomInt } from "node:crypto";
import type { AddSshProjectRequest } from "@dbx-tools/shared-databricks-sandbox";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";
import { readPackageResource } from "./_package.ts";
import { SANDBOX_PROJECTS_ROOT } from "./_sandbox-user.ts";

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROJECT_PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const GENERATED_PORT_MIN = 8_000;
const GENERATED_PORT_MAX = 49_151;
type ProjectConfigInput = NonNullable<AddSshProjectRequest["config"]>;
type ProjectConfig = Exclude<ProjectConfigInput, string>;
type ProjectConfigValue = ProjectConfig[string];

/** @internal */
export const LOCAL_BIN_PATH_SCRIPT = readPackageResource("scripts", "setup-local-bin-path.sh");
/** @internal */
export const PKGX_INSTALL_SCRIPT = readPackageResource("scripts", "install-pkgx.sh");
/** @internal */
export const BREW_INSTALL_SCRIPT = readPackageResource("scripts", "install-brew.sh");
/** @internal */
export const MISE_INSTALL_SCRIPT = `${LOCAL_BIN_PATH_SCRIPT.trimEnd()}\n\n${readPackageResource(
  "scripts",
  "install-mise.sh",
)}`;
/** @internal */
export const PROJECT_SETUP_SCRIPT = readPackageResource("scripts", "setup-project.sh");
/** @internal */
export const PROJECT_REMOVE_SCRIPT = readPackageResource("scripts", "remove-project.sh");

/** @internal */
export interface ProjectEnvironment {
  name: string;
  path: string;
  port: number;
}

/** @internal */
export function mergeProjectMiseConfig(
  config: ProjectConfigInput | undefined,
  options: Pick<AddSshProjectRequest, "tools" | "env" | "postinstall" | "uninstall">,
): ProjectConfig {
  const resolved = parseProjectMiseConfig(config);
  if (options.tools) {
    const configuredTools = objectTable(resolved.tools, "config.tools");
    resolved.tools = { ...configuredTools, ...structuredClone(options.tools) };
  }
  if (options.env) {
    const configuredEnv = objectTable(resolved.env, "config.env");
    resolved.env = { ...configuredEnv, ...options.env };
  }
  if (options.postinstall) {
    const hooks = objectTable(resolved.hooks, "config.hooks");
    resolved.hooks = { ...hooks, postinstall: options.postinstall };
  }
  if (options.uninstall) {
    const tasks = objectTable(resolved.tasks, "config.tasks");
    resolved.tasks = {
      ...tasks,
      uninstall: { run: options.uninstall },
    };
  }
  assertNonCredentialEnv(objectTable(resolved.env, "config.env"));
  return resolved;
}

/** @internal Parse a JSON object or TOML document into persisted mise configuration. */
export function parseProjectMiseConfig(config: ProjectConfigInput | undefined): ProjectConfig {
  if (config === undefined) return {};
  if (typeof config !== "string") return structuredClone(config);

  try {
    const parsedJson: unknown = JSON.parse(config);
    if (isConfigObject(parsedJson)) return parsedJson as ProjectConfig;
  } catch {
    // The TOML parse below owns the final diagnostic for non-JSON strings.
  }

  let parsedToml: unknown;
  try {
    parsedToml = parse(config);
  } catch (error) {
    throw new Error("Sandbox project config string must contain a JSON object or valid TOML", {
      cause: error,
    });
  }
  if (!isConfigObject(parsedToml)) {
    throw new Error("Sandbox project config must have an object root");
  }
  try {
    return JSON.parse(JSON.stringify(parsedToml)) as ProjectConfig;
  } catch (error) {
    throw new Error("Sandbox project TOML config must contain JSON-compatible values", {
      cause: error,
    });
  }
}

/** @internal */
export function normalizeProjectName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PROJECT_NAME_PATTERN.test(normalized)) {
    throw new Error(
      "Sandbox project name must start with a lowercase letter or digit and contain only lowercase letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

/** @internal */
export function generateProjectName(usedNames: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const candidate = `project-${randomBytes(3).toString("hex")}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  throw new Error("Could not generate a unique Sandbox project name");
}

/** @internal */
export function normalizeProjectPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.includes("?") ||
    normalized.includes("#") ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || !PROJECT_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new Error(
      "Sandbox project path must contain lowercase path segments made from letters, digits, dots, underscores, or hyphens",
    );
  }
  return normalized;
}

/** @internal */
export function generateProjectPort(usedPorts: ReadonlySet<number>): number {
  for (let attempt = 0; attempt < 256; attempt += 1) {
    const candidate = randomInt(GENERATED_PORT_MIN, GENERATED_PORT_MAX + 1);
    if (!usedPorts.has(candidate)) return candidate;
  }
  for (let candidate = GENERATED_PORT_MIN; candidate <= GENERATED_PORT_MAX; candidate += 1) {
    if (!usedPorts.has(candidate)) return candidate;
  }
  throw new Error("No unused Sandbox project ports are available");
}

/** @internal */
export function normalizeProjectOpenPath(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) {
    throw new Error("Sandbox project openPath must be a project-relative URL");
  }
  const normalized = trimmed.replace(/^\/+/, "");
  const pathname = normalized.split(/[?#]/, 1)[0] ?? "";
  if (!pathname || pathname.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new Error("Sandbox project openPath cannot traverse parent directories");
  }
  return normalized;
}

/** @internal */
export function renderProjectMiseConfig(
  config: ProjectConfig | undefined,
  environment: ProjectEnvironment,
): string {
  const resolved = structuredClone(config ?? {}) as ProjectConfig;
  const configuredEnvironment = resolved.env;
  if (
    configuredEnvironment !== undefined &&
    (configuredEnvironment === null ||
      Array.isArray(configuredEnvironment) ||
      typeof configuredEnvironment !== "object")
  ) {
    throw new Error("Sandbox project config.env must be an object");
  }
  const env = (configuredEnvironment ?? {}) as Record<string, ProjectConfigValue>;
  const reserved = {
    PROJECT_NAME: environment.name,
    PROJECT_PATH: environment.path,
    PROJECT_PORT: String(environment.port),
  } as const;
  for (const [name, expected] of Object.entries(reserved)) {
    const configured = env[name];
    if (configured !== undefined && String(configured) !== expected) {
      throw new Error(`Sandbox project config.env.${name} must equal ${JSON.stringify(expected)}`);
    }
    env[name] = expected;
  }
  resolved.env = env;
  try {
    return `${stringify(resolved as TomlTableWithoutBigInt).trimEnd()}\n`;
  } catch (error) {
    throw new Error("Sandbox project config cannot be serialized to mise.toml", { cause: error });
  }
}

/** @internal */
export function projectDirectory(path: string): string {
  return `${SANDBOX_PROJECTS_ROOT}/${path}`;
}

/** @internal */
export function projectOpenUrl(path: string, openPath: string | undefined): string {
  return openPath ? `${path.replace(/\/+$/, "")}/${openPath}` : path;
}

/** @internal */
export function packageScriptCommand(script: string, args: readonly string[]): string {
  const encodedScript = Buffer.from(script).toString("base64");
  return `printf %s ${shellQuote(encodedScript)} | base64 -d | sh -s -- ${args.map(shellQuote).join(" ")}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function objectTable(
  value: ProjectConfigValue | undefined,
  field: string,
): Record<string, ProjectConfigValue> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Sandbox project ${field} must be an object`);
  }
  return value as Record<string, ProjectConfigValue>;
}

function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNonCredentialEnv(env: Record<string, ProjectConfigValue>): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("DATABRICKS_") || name === "SSH_AUTH_SOCK") {
      throw new Error(
        "Sandbox project env cannot restore Databricks or SSH agent credentials; use a dedicated app-mediated OBO capability.",
      );
    }
  }
}
