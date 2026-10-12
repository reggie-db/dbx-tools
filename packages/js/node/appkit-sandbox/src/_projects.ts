import { randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AddSshProjectRequest,
  SshMachineServiceKind,
} from "@dbx-tools/shared-databricks-sandbox";
import { stringify, type TomlTableWithoutBigInt } from "smol-toml";

const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const PROJECT_PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const GENERATED_PORT_MIN = 8_000;
const GENERATED_PORT_MAX = 49_151;
type ProjectConfig = NonNullable<AddSshProjectRequest["config"]>;
type ProjectConfigValue = ProjectConfig[string];

/** @internal */
export const MISE_INSTALL_SCRIPT = readPackageScript("install-mise.sh");
/** @internal */
export const PROJECT_SETUP_SCRIPT = readPackageScript("setup-project.sh");
/** @internal */
export const PROJECT_REMOVE_SCRIPT = readPackageScript("remove-project.sh");

/** @internal */
export interface ProjectEnvironment {
  name: string;
  path: string;
  port: number;
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
  serviceDependencies: readonly SshMachineServiceKind[] = [],
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
  injectServiceTasks(resolved, serviceDependencies);
  try {
    return `${stringify(resolved as TomlTableWithoutBigInt).trimEnd()}\n`;
  } catch (error) {
    throw new Error("Sandbox project config cannot be serialized to mise.toml", { cause: error });
  }
}

/** @internal */
export function projectDirectory(path: string): string {
  return `~/projects/${path}`;
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

function readPackageScript(name: string): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(moduleDirectory);
  const packageRoot = basename(parent) === "lib" ? dirname(parent) : parent;
  return readFileSync(join(packageRoot, "scripts", name), "utf8");
}

/** Add server-owned service dependency markers to one rendered mise configuration. */
function injectServiceTasks(
  config: ProjectConfig,
  serviceDependencies: readonly SshMachineServiceKind[],
): void {
  const kinds = [...new Set(serviceDependencies)];
  if (kinds.length === 0) return;
  const configuredTasks = config.tasks;
  if (configuredTasks !== undefined && !isConfigTable(configuredTasks)) {
    throw new Error("Sandbox project config.tasks must be an object");
  }
  const tasks = (configuredTasks ?? {}) as Record<string, ProjectConfigValue>;
  const dependencyTasks = kinds.map((kind) => `sandbox:${kind}`);
  for (const kind of kinds) {
    const taskName = `sandbox:${kind}`;
    if (tasks[taskName] !== undefined) {
      throw new Error(`Sandbox project config.tasks.${taskName} is reserved`);
    }
    tasks[taskName] = {
      hide: true,
      run: `cd "$HOME/projects/.sandbox-services/${kind}" && "$HOME/.local/bin/mise" run start`,
    };
  }
  const configuredStart = tasks.start;
  if (configuredStart !== undefined) {
    if (isConfigTable(configuredStart)) {
      const configuredDepends = configuredStart.depends;
      const depends =
        configuredDepends === undefined
          ? []
          : Array.isArray(configuredDepends)
            ? configuredDepends
            : [configuredDepends];
      tasks.start = {
        ...configuredStart,
        depends: [
          ...depends,
          ...dependencyTasks.filter((dependency) => !depends.includes(dependency)),
        ],
      };
    } else {
      tasks.start = { run: configuredStart, depends: dependencyTasks };
    }
  }
  config.tasks = tasks;
}

/** Return whether one JSON mise value can be handled as a TOML table. */
function isConfigTable(value: ProjectConfigValue): value is Record<string, ProjectConfigValue> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
