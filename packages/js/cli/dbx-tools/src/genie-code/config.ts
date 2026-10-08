/**
 * Generate one persistent Genie Code home per exact profile-model pairing.
 *
 * @module
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { withFileLock } from "@dbx-tools/core/file-lock";
import { object } from "@dbx-tools/shared-core";
import {
  GenieCodeBaseConfigSchema,
  GenieCodeConfigSchema,
  GenieCodeProviderOverlaySchema,
  type GenieCodeBaseConfig,
  type GenieCodeConfig,
  type GenieCodeProviderOverlay,
} from "@dbx-tools/shared-genie-code/config";
import { genieCodePairingName } from "@dbx-tools/shared-genie-code/options";
import { parse, stringify } from "smol-toml";

/** Provider identifier written to the base and invocation overlay configurations. */
export const GENIE_CODE_GATEWAY_PROVIDER = "dbx_tools_model_gateway";

/** Inputs used to update a persistent home and create one invocation overlay. */
export interface WriteGenieCodeConfigOptions {
  bearerToken: string;
  gatewayBaseUrl: string;
  homeDirectory?: string;
  model: string;
  profile: string;
  projectDirectory: string;
}

/** Stable persistent home for one exact profile-model pairing. */
export interface GenieCodePairingHome {
  configPath: string;
  home: string;
  name: string;
}

/** Persistent pairing home and invocation-specific provider overlay. */
export interface GenieCodeHome extends GenieCodePairingHome {
  overlayName: string;
  overlayPath: string;
}

/** Derive the stable home for one exact profile-model pair. */
export function genieCodeHome(
  profile: string,
  model: string,
  homeDirectory: string = homedir(),
): GenieCodePairingHome {
  const digest = createHash("sha256")
    .update(JSON.stringify([profile, model]))
    .digest("hex")
    .slice(0, 12);
  const name = genieCodePairingName({ profile, model, digest });
  const home = join(homeDirectory, ".dbx-tools", "genie", "profiles", name);
  return { name, home, configPath: join(home, "config.toml") };
}

/** Render the persistent profile-model configuration. */
export function genieCodeBaseConfig(
  options: WriteGenieCodeConfigOptions,
  existingProjects: Readonly<Record<string, unknown>> = {},
): GenieCodeBaseConfig {
  const projects = Object.fromEntries(
    Object.entries(existingProjects).filter(
      ([, value]) => object.isRecord(value) && value.trust_level === "trusted",
    ),
  );
  return GenieCodeBaseConfigSchema.parse({
    model_provider: GENIE_CODE_GATEWAY_PROVIDER,
    model: options.model,
    databricks_profile: options.profile,
    projects: {
      ...projects,
      [resolve(options.projectDirectory)]: {
        trust_level: "trusted",
      },
    },
    tui: {
      model_availability_nux: {
        [options.model]: 1,
      },
    },
  });
}

/** Render the invocation-specific guarded provider configuration. */
export function genieCodeProviderOverlay(
  options: WriteGenieCodeConfigOptions,
): GenieCodeProviderOverlay {
  return GenieCodeProviderOverlaySchema.parse({
    model_providers: {
      [GENIE_CODE_GATEWAY_PROVIDER]: {
        name: "dbx-tools model gateway",
        base_url: options.gatewayBaseUrl,
        wire_api: "responses",
        requires_openai_auth: false,
        supports_websockets: false,
        http_headers: {
          Authorization: `Bearer ${options.bearerToken}`,
          Originator: "codex",
        },
      },
    },
  });
}

/** Render the merged configuration used by validation and tests. */
export function genieCodeConfig(options: WriteGenieCodeConfigOptions): GenieCodeConfig {
  return GenieCodeConfigSchema.parse({
    ...genieCodeBaseConfig(options),
    ...genieCodeProviderOverlay(options),
  });
}

async function existingProjects(path: string): Promise<Record<string, unknown>> {
  try {
    const value = parse(await readFile(path, "utf8"));
    return object.isRecord(value.projects) ? value.projects : {};
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writePrivateToml(path: string, value: unknown): Promise<void> {
  const staged = join(dirname(path), `.${randomUUID()}.toml`);
  try {
    await writeFile(staged, stringify(value), { mode: 0o600 });
    await chmod(staged, 0o600);
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

/** Update the persistent base config and write one private invocation overlay. */
export async function writeGenieCodeConfig(
  options: WriteGenieCodeConfigOptions,
): Promise<GenieCodeHome> {
  const base = genieCodeHome(options.profile, options.model, options.homeDirectory);
  const overlayName = `dbx-${randomUUID().replaceAll("-", "")}`;
  const destination = {
    ...base,
    overlayName,
    overlayPath: join(base.home, `${overlayName}.config.toml`),
  };
  await mkdir(destination.home, { recursive: true });
  await withFileLock(["genie-code-config", destination.configPath], async () => {
    const projects = await existingProjects(destination.configPath);
    await writePrivateToml(destination.configPath, genieCodeBaseConfig(options, projects));
  });
  await writePrivateToml(destination.overlayPath, genieCodeProviderOverlay(options));
  return destination;
}
