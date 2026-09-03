import { exec } from "@dbx-tools/core";
import { json, object, string } from "@dbx-tools/shared-core";

const PROFILE_ENV = "DATABRICKS_CONFIG_PROFILE";
const HOST_ENV = "DATABRICKS_HOST";

interface ResolveProfileOptions {
  host?: string;
  environ?: NodeJS.ProcessEnv;
}

export function resolveDatabricksProfile(
  explicit?: string,
  options: ResolveProfileOptions = {},
): string | undefined {
  const environ = options.environ ?? process.env;
  const configured = string.trimToNull(explicit) ?? string.trimToNull(environ[PROFILE_ENV]);
  if (configured) return configured;
  if (string.trimToNull(options.host) || string.trimToNull(environ[HOST_ENV])) return undefined;
  return defaultCliProfile();
}

export function selectDatabricksProfile(payload: unknown): string | undefined {
  const profiles = object.isRecord(payload) ? payload.profiles : undefined;
  if (!Array.isArray(profiles)) return undefined;
  const entries = profiles.flatMap((profile) => {
    if (!object.isRecord(profile)) return [];
    const name = string.trimToNull(profile.name);
    return name ? [{ name, markedDefault: profile.default === true }] : [];
  });
  return (
    entries.find((entry) => entry.markedDefault)?.name ??
    entries.find((entry) => entry.name === "DEFAULT")?.name ??
    (entries.length === 1 ? entries[0]?.name : undefined)
  );
}

function defaultCliProfile(): string {
  const result = exec.spawnSync(
    "databricks",
    ["auth", "profiles", "--output", "json", "--skip-validate"],
    {
      stdin: "ignore",
      stdout: "capture",
      stderr: "capture",
    },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr || result.stdout;
    throw new Error(`Could not read Databricks CLI profiles${detail ? `: ${detail}` : ""}`);
  }
  const selected = selectDatabricksProfile(json.parse(result.stdout));
  if (selected) return selected;
  throw new Error(
    "No Databricks profile was selected and the CLI has no marked default, " +
      "DEFAULT profile, or single configured profile",
  );
}
