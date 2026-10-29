/**
 * Registry-neutral Bun text lockfiles.
 *
 * Bun records each package's resolved tarball URL in `bun.lock`. When the
 * installing machine's npm registry is a private mirror, every URL names that
 * mirror, so a committed lockfile would leak it and fail on machines that cannot
 * reach it. Normalization detects the active registry the same way a package
 * manager does and, when it is not public npm, rewrites every tarball URL under
 * it in bulk. All other URLs are left as they are.
 *
 * Bun accepts both replacement forms under `--frozen-lockfile`: an empty tarball
 * field resolves through whichever registry the installing machine configures,
 * and a public npm URL pins npmjs explicitly. Integrity hashes are unchanged, so
 * frozen installs still verify the exact tarball content.
 *
 * Bun has no native setting for this as of 1.4.2: `[install.lockfile]` only
 * supports `save` and `print`, and Bun's own `BunLockFile` type marks the npm
 * registry field "TODO: remove if default". Replace this rewrite with that
 * native behavior once Bun ships it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { npmRegistry } from "@dbx-tools/core";
import { z } from "zod";

/** Bun's text lockfile at a workspace root. */
export const BUN_LOCKFILE = "bun.lock";

/** Public npm registry used by the `npmjs` replacement. */
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";

/** Registry tarball entry: `"key": ["name@version", "<tarball>", ...`. */
const TARBALL_ENTRY =
  /^(\s+"[^"\n]+": \[")((?:@[^/"\n]+\/)?[^@"\n]+)@([^"\n]+)(", )"(https?:\/\/[^"\n]*)"/gm;

/** How private registry tarball URLs are rewritten. */
export const BunLockfileReplacementSchema = z
  .enum(["empty", "npmjs"])
  .describe(
    "Replacement for private registry tarball URLs: empty resolves through the installing machine's registry; npmjs pins public npm",
  );

/** Options that control `bun.lock` normalization. */
export const BunLockfileOptionsSchema = z
  .object({
    mode: z
      .enum(["auto", "off"])
      .default("auto")
      .describe(
        "auto rewrites tarball URLs under the detected npm registry when it is not public npm; off leaves the lockfile unchanged",
      ),
    replacement: BunLockfileReplacementSchema.default("empty"),
    registries: z
      .array(z.string().trim().url())
      .default([])
      .describe("Additional registry URLs whose tarball URLs are rewritten"),
    check: z
      .boolean()
      .default(false)
      .describe("Fail instead of writing when the lockfile is not normalized"),
  })
  .describe("Keep bun.lock free of private npm registry URLs");

/** Parsed {@link BunLockfileOptionsSchema}. */
export type BunLockfileOptions = z.output<typeof BunLockfileOptionsSchema>;

/** Accepted input for {@link BunLockfileOptionsSchema}. */
export type BunLockfileOptionsInput = z.input<typeof BunLockfileOptionsSchema>;

/** Result of normalizing one lockfile body. */
export interface NormalizedBunLockfile {
  /** Lockfile text with private registry tarball URLs rewritten. */
  readonly content: string;
  /** Number of tarball URLs rewritten. */
  readonly rewritten: number;
  /** Registry prefixes that were rewritten. */
  readonly registries: readonly string[];
}

/** URL origin plus path prefix of a registry, without a trailing slash. */
function registryPrefix(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return undefined;
  }
}

/**
 * Registry URLs to rewrite for `cwd`.
 *
 * `auto` adds the active npm registry only when it is not public npm, so a
 * machine on npmjs leaves the lockfile untouched.
 */
export function bunLockfileRegistries(
  cwd: string,
  options: Pick<BunLockfileOptions, "mode" | "registries">,
): string[] {
  if (options.mode === "off") return [];
  const detected = npmRegistry(cwd, { overrideOnly: true })?.href;
  return [...(detected ? [detected] : []), ...options.registries];
}

/** Public npm tarball URL for one package version. */
function npmjsTarball(name: string, version: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  return `${PUBLIC_NPM_REGISTRY}/${name}/-/${base}-${version}.tgz`;
}

/** Rewrite tarball URLs under any of `registries`; leave every other URL as is. */
export function normalizeBunLockfile(
  content: string,
  registries: readonly string[],
  replacement: z.output<typeof BunLockfileReplacementSchema> = "empty",
): NormalizedBunLockfile {
  const prefixes = [...new Set(registries.flatMap((registry) => registryPrefix(registry) ?? []))];
  if (prefixes.length === 0) return { content, rewritten: 0, registries: prefixes };
  let rewritten = 0;
  const normalized = content.replace(
    TARBALL_ENTRY,
    (entry, head: string, name: string, version: string, separator: string, url: string) => {
      if (!prefixes.some((prefix) => url.startsWith(`${prefix}/`))) return entry;
      rewritten += 1;
      const tarball = replacement === "npmjs" ? npmjsTarball(name, version) : "";
      return `${head}${name}@${version}${separator}"${tarball}"`;
    },
  );
  return { content: normalized, rewritten, registries: prefixes };
}

/** Outcome of {@link normalizeBunLockfileAt}. */
export interface BunLockfileNormalization extends NormalizedBunLockfile {
  /** Absolute lockfile path. */
  readonly path: string;
  /** Whether the lockfile exists. */
  readonly exists: boolean;
  /** Whether the file content differs from its normalized form. */
  readonly changed: boolean;
}

/** Normalize `bun.lock` in `root`, writing it unless `check` is set. */
export function normalizeBunLockfileAt(
  root: string,
  input: BunLockfileOptionsInput = {},
): BunLockfileNormalization {
  const options = BunLockfileOptionsSchema.parse(input);
  const path = join(root, BUN_LOCKFILE);
  if (!existsSync(path)) {
    return { path, exists: false, changed: false, content: "", rewritten: 0, registries: [] };
  }
  const original = readFileSync(path, "utf8");
  const result = normalizeBunLockfile(
    original,
    bunLockfileRegistries(root, options),
    options.replacement,
  );
  const changed = result.content !== original;
  if (changed && !options.check) writeFileSync(path, result.content);
  return { ...result, path, exists: true, changed };
}
