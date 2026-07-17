/**
 * Glob pattern builders shared by ignore groups and matchers.
 */

/** Glob metacharacters; escaped so a directory or file name is matched literally. */
const ESCAPE_GLOB_REGEXP = /([*?[\]{}()!+@\\])/g;

/**
 * Returns a glob matching all descendants of directories named `name`.
 *
 * By default, glob metacharacters in `name` are escaped so it is treated
 * literally. Pass `false` for `escape` when `name` intentionally contains glob
 * syntax.
 *
 * @param name - Directory base name (e.g. `node_modules`).
 * @param escape - When `true` (default), escape glob metacharacters in `name`.
 */
export function directoryNamePattern(name: string, escape = true): string {
  return `**/${escape ? name.replace(ESCAPE_GLOB_REGEXP, "\\$1") : name}/**`;
}

/**
 * Returns a glob matching files with extension `extension` at any depth.
 *
 * @param extension - Extension with or without a leading dot (e.g. `log` or `.log`).
 * @param escape - When `true` (default), escape glob metacharacters in `extension`.
 */
export function fileExtensionPattern(extension: string, escape = true): string {
  const bare = extension.startsWith(".") ? extension.slice(1) : extension;
  return `**/*.${escape ? bare.replace(ESCAPE_GLOB_REGEXP, "\\$1") : bare}`;
}
