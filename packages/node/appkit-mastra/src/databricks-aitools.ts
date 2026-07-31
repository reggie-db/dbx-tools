/**
 * Startup provisioning of Databricks AI Tools skills for a Mastra workspace.
 *
 * Databricks AI Tools (`databricks aitools`) are Databricks-owned Agent-Skill
 * (`SKILL.md`) trees installed and kept up to date through the Databricks CLI.
 * {@link provisionDatabricksAITools} shells out to the CLI
 * (`databricks aitools install --path <dir>`) to materialize a resolved,
 * agent-agnostic skill set into a directory, then hands it to Mastra as an
 * extra LOCAL skill scan path - so an agent gets first-class Databricks skills
 * without anyone hand-copying `SKILL.md` files. It never reimplements the CLI's
 * sourcing; the CLI is the source of truth.
 *
 * The option is `false | true | "auto" | DatabricksAIToolsOptions`:
 *
 * - `false` (default) - off.
 * - `"auto"` - run the CLI when it's installed; if the `databricks` CLI isn't
 *   available, log and move on (never fails startup). The "on if the CLI is
 *   around" default.
 * - `true` (`"require"`) - require the CLI: fail startup (subject to
 *   `failOnError`) when it isn't available or produces nothing.
 * - an options bag for a specific `skills` subset, `experimental` skills, an
 *   explicit output `path`, or a custom `cli` path.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { exec } from "@dbx-tools/core";
import { localFS } from "@dbx-tools/fs";
import { error, log, string } from "@dbx-tools/shared-core";

const logger = log.logger("mastra/databricks-aitools");

/** The Databricks CLI binary name; resolved on `PATH`. */
const DATABRICKS_CLI = "databricks";

/** Stable temp directory the CLI's skill tree is rebuilt into each boot. */
const SKILLS_CACHE_DIR = "databricks-aitools";

/* -------------------------------- types -------------------------------- */

/** How aggressively to enable Databricks AI Tools skills. */
export type DatabricksAIToolsMode = "auto" | "require";

/** Options for {@link provisionDatabricksAITools}. */
export interface DatabricksAIToolsOptions {
  /**
   * `"auto"` (default) runs the CLI when installed and logs-and-continues when
   * it isn't; `"require"` fails startup when the CLI can't supply skills.
   */
  mode?: DatabricksAIToolsMode;
  /** Install only these skill names (comma/space list or array). */
  skills?: string | string[];
  /** Include experimental skills when the CLI has to fetch. */
  experimental?: boolean;
  /**
   * Explicit directory to materialize skills into with the CLI. Defaults to a
   * fresh {@link localFS.tmpFS} root.
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
  source?: "cli";
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

  try {
    // The `databricks` CLI is the source of truth. When it's resolvable, run
    // `databricks aitools install --path <dir>` to materialize a fresh,
    // agent-agnostic skill set into a dir Mastra can scan.
    const cliPath = await resolveCli(options.cli);
    if (cliPath) {
      const dir = await materializeViaCli(cliPath, options);
      if (dir) return { localSkillPaths: [dir], source: "cli" };
    }

    // CLI not installed (or produced nothing). "auto" logs and moves on;
    // "require" fails startup unless `failOnError: false`.
    if (failOnError) {
      throw new Error(
        `Databricks AI Tools required but the "${DATABRICKS_CLI}" CLI is not available. Install the Databricks CLI (\`databricks aitools install\`), or set databricksAITools: "auto".`,
      );
    }
    logger.info("databricks CLI not available; skipping AI Tools skills");
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

/** Resolve the `databricks` CLI, returning its invocation path or `undefined`. */
async function resolveCli(cli: string | undefined): Promise<string | undefined> {
  const command = string.trimToNull(cli) ?? DATABRICKS_CLI;
  try {
    const result = await exec.spawn(command, ["aitools", "version"], {
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
 * Run `databricks aitools install --path <dir>` to materialize a resolved,
 * agent-agnostic skill set into a directory (writes `<name>/SKILL.md` trees,
 * no agents, no state) Mastra can then scan.
 */
async function materializeViaCli(
  cli: string,
  options: DatabricksAIToolsOptions,
): Promise<string | undefined> {
  const explicit = string.trimToNull(options.path);
  let dir: string;

  if (explicit) {
    // An explicit path is the caller's to own - install straight into it.
    await installSkills(cli, options, explicit);
    dir = explicit;
  } else {
    // The resolved skill set is the same on almost every boot, so rebuild ONE
    // stable temp tree rather than leaving a fresh scratch dir behind each
    // time. The CLI writes into a throwaway root that only replaces the stable
    // one on success, so a failed install keeps the previous skills usable.
    const stable = await localFS.rebuildFS(SKILLS_CACHE_DIR, (scratch) =>
      installSkills(cli, options, scratch.root),
    );
    dir = stable.root;
  }

  if (!existsSync(dir)) return undefined;
  logger.debug("materialized aitools skills via CLI", {
    path: dir,
    skills: string.parseList(options.skills),
  });
  return dir;
}

/** Run `databricks aitools install --path <dir>`, failing loudly on a non-zero exit. */
async function installSkills(
  cli: string,
  options: DatabricksAIToolsOptions,
  dir: string,
): Promise<void> {
  const args = ["aitools", "install", "--path", dir];
  const skills = string.parseList(options.skills);
  if (skills.length > 0) args.push("--skills", skills.join(","));
  if (options.experimental) args.push("--experimental");

  const result = await exec.spawn(cli, args, {
    stdout: "capture",
    stderr: "capture",
    check: false,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `databricks aitools install failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}
