/**
 * Load heavy generator tools only when code generation has work to do.
 *
 * Code generation drives a large toolchain only when a package declares inputs,
 * so those tools are not imported at module scope. This helper identifies a
 * broken engine installation instead of exposing a bare MODULE_NOT_FOUND from a
 * lazy require.
 */

/**
 * `require` an engine-owned generator dependency only when codegen needs it.
 *
 * @param require - a `createRequire(import.meta.url)` bound to the calling module,
 *   so the resolution walk starts at the engine and reaches the consumer's install.
 * @param name - bare package specifier of the tool.
 * @param reason - what the tool is needed for, named in the error.
 */
export function lazyRequire<T>(require: NodeJS.Require, name: string, reason: string): T {
  try {
    return require(name) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code !== "MODULE_NOT_FOUND") throw cause;
    throw new Error(
      `${reason} requires the \`${name}\` dependency shipped by @dbx-tools/projen; reinstall workspace dependencies and re-run`,
      { cause },
    );
  }
}
