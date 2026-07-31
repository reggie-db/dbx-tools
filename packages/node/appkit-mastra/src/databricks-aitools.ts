/**
 * Startup provisioning of Databricks AI Tools skills for a Mastra workspace.
 *
 * Databricks AI Tools (`databricks aitools`) are Databricks-owned Agent-Skill
 * (`SKILL.md`) trees installed and kept up to date through the Databricks CLI.
 * The CLI installs them globally under `~/.databricks/aitools/skills/<name>/`
 * (with a `.state.json` manifest) and can also write a resolved, agent-agnostic
 * copy to any directory with `databricks aitools install --path <dir>
 * --skills-only`.
 *
 * {@link provisionDatabricksAITools} folds those skills into a Mastra workspace
 * as extra LOCAL skill scan paths so an agent can use them without anyone
 * hand-copying `SKILL.md` files. It never reimplements the CLI's sourcing: it
 * either points Mastra at the already-installed global tree, or shells out to
 * the CLI to materialize a curated subset into a temp dir.
 *
 * The option is `false | true | "auto" | DatabricksAIToolsOptions`:
 *
 * - `false` (default) - off.
 * - `"auto"` - enable only when the global tree already exists OR the
 *   `databricks` CLI is resolvable; otherwise silently no-op. The "on if the
 *   CLI is around" default.
 * - `true` - required: fail startup (subject to `failOnError`) when neither the
 *   installed tree nor the CLI can supply skills.
 * - an options bag for a specific `skills` subset, `experimental` skills, a
 *   `refresh` that re-runs the CLI even when a tree exists, or an explicit
 *   `path`.
 *
 * @module
 */

import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "@dbx-tools/core";
import { error, log, string } from "@dbx-tools/shared-core";

const logger = log.logger("mastra/databricks-aitools");

/** Global skills tree the `databricks aitools` CLI installs into. */
const GLOBAL_AITOOLS_SKILLS_PATH = join(homedir(), ".databricks", "aitools", "skills");

/** The Databricks CLI binary name; resolved on `PATH`. */
const DATABRICKS_CLI = "databricks";

/* -------------------------------- types -------------------------------- */

/** How aggressively to enable Databricks AI Tools skills. */
export type DatabricksAIToolsMode = "auto" | "require";

/** Options for {@link provisionDatabricksAITools}. */
export interface DatabricksAIToolsOptions {
  /**
   * `"auto"` (default) enables only when the installed tree exists or the CLI
   * is resolvable; `"require"` fails startup when neither can supply skills.
   */
  mode?: DatabricksAIToolsMode;
  /** Install only these skill names (comma/space list or array). */
  skills?: string | string[];
  /** Include experimental skills when the CLI has to fetch. */
  experimental?: boolean;
  /**
   * Re-run the CLI to (re)materialize skills into a fresh dir even when the
   * global tree already exists. Defaults to `false` (reuse the installed tree).
   */
  refresh?: boolean;
  /**
   * Explicit directory to materialize skills into with the CLI. Defaults to a
   * temp dir. Ignored when the installed global tree is used as-is.
   */
  path?: string;
  /** Absolute path to the `databricks` CLI. Defaults to `databricks` on PATH. */
  cli?: string;
  /**
   * Fail app startup when required skills can't be provisioned. Defaults to
   * `true` for `mode: "require"` and `false` for `"auto"`.
   */
  failOnError?: boolean;
}

/** The `databricksAITools` config option: a toggle, `"auto"`, or an options bag. */
export type DatabricksAIToolsOption = boolean | "auto" | DatabricksAIToolsOptions;

/** What {@link provisionDatabricksAITools} resolved. */
export interface ProvisionedDatabricksAITools {
  /** Extra LOCAL skill scan paths to hand Mastra. Empty when disabled/unresolved. */
  localSkillPaths: string[];
  /** How the skills were sourced, for logging. */
  source?: "installed" | "cli";
}

/* ------------------------------- helpers ------------------------------- */

/** Normalize the `databricksAITools` option into a flat options bag, or `undefined` when off. */
export function normalizeDatabricksAIToolsOption(
  option: DatabricksAIToolsOption | undefined,
): DatabricksAIToolsOptions | undefined {
  if (option === undefined || option === false) return undefined;
  if (option === true) return { mode: "require" };
  if (option === "auto") return { mode: "auto" };
  return { mode: option.mode ?? "auto", ...option };
}

/**
 * Materialize Databricks AI Tools skills at app startup and return them as
 * extra local skill scan paths.
 *
 * Resolution: reuse the installed global tree when present (no CLI call) unless
 * `refresh`/`skills`/`path` ask for a fresh CLI materialization; otherwise run
 * `databricks aitools install --path <dir> --skills-only` when the CLI resolves.
 * A `"require"` provision that yields nothing fails startup unless
 * `failOnError: false`.
 */
export async function provisionDatabricksAITools(
  option: DatabricksAIToolsOption | undefined,
): Promise<ProvisionedDatabricksAITools> {
  const options = normalizeDatabricksAIToolsOption(option);
  const empty: ProvisionedDatabricksAITools = { localSkillPaths: [] };
  if (!options) return empty;

  const mode = options.mode ?? "auto";
  const failOnError = options.failOnError ?? mode === "require";
  const wantsCliFetch =
    options.refresh === true ||
    options.path !== undefined ||
    string.parseList(options.skills).length > 0 ||
    options.experimental === true;

  try {
    // Fast path: reuse the already-installed global tree, no CLI call.
    if (!wantsCliFetch && installedTreeExists()) {
      logger.debug("using installed aitools tree", { path: GLOBAL_AITOOLS_SKILLS_PATH });
      return { localSkillPaths: [GLOBAL_AITOOLS_SKILLS_PATH], source: "installed" };
    }

    const cliPath = await resolveCli(options.cli);
    if (cliPath) {
      const dir = await materializeViaCli(cliPath, options);
      if (dir) return { localSkillPaths: [dir], source: "cli" };
    }

    // Nothing fetched. Fall back to the installed tree if it's there.
    if (installedTreeExists()) {
      return { localSkillPaths: [GLOBAL_AITOOLS_SKILLS_PATH], source: "installed" };
    }

    if (failOnError) {
      throw new Error(
        `Databricks AI Tools requested but no installed skills tree at "${GLOBAL_AITOOLS_SKILLS_PATH}" and the "${DATABRICKS_CLI}" CLI is not resolvable. Install with \`databricks aitools install\`, or set databricksAITools: "auto".`,
      );
    }
    logger.debug("databricks aitools unavailable; skipping");
    return empty;
  } catch (err) {
    if (failOnError) {
      throw new Error(
        `failed to provision Databricks AI Tools skills: ${error.errorMessage(err)}`,
        { cause: error.toError(err) },
      );
    }
    logger.warn("skipped", { error: error.errorMessage(err) });
    return empty;
  }
}

/** Whether the CLI's global skills tree exists and holds at least one skill. */
function installedTreeExists(): boolean {
  return existsSync(GLOBAL_AITOOLS_SKILLS_PATH);
}

/** Resolve the `databricks` CLI, returning its invocation path or `undefined`. */
async function resolveCli(cli: string | undefined): Promise<string | undefined> {
  const command = string.trimToNull(cli) ?? DATABRICKS_CLI;
  try {
    const result = await spawn(command, ["aitools", "version"], {
      stdout: "capture",
      stderr: "capture",
      check: false,
    });
    if (result.exitCode === 0) return command;
  } catch {
    // CLI absent or `aitools` unsupported - caller falls back / fails.
  }
  return undefined;
}

/**
 * Run `databricks aitools install --path <dir> --skills-only` to materialize a
 * resolved, agent-agnostic skill set into a directory (no agents, no state).
 */
async function materializeViaCli(
  cli: string,
  options: DatabricksAIToolsOptions,
): Promise<string | undefined> {
  const dir =
    string.trimToNull(options.path) ?? (await mkdtemp(join(tmpdir(), "databricks-aitools-")));
  const args = ["aitools", "install", "--path", dir, "--skills-only"];
  const skills = string.parseList(options.skills);
  if (skills.length > 0) args.push("--skills", skills.join(","));
  if (options.experimental) args.push("--experimental");

  const result = await spawn(cli, args, {
    stdout: "capture",
    stderr: "capture",
    check: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `databricks aitools install failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
  if (!existsSync(dir)) return undefined;
  logger.debug("materialized aitools skills via CLI", { path: dir, skills });
  return dir;
}
