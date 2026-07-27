/**
 * Loading heavy generator tools out of the CONSUMING workspace.
 *
 * The generators (`openapi.ts`, `codegen.ts`) each drive a large toolchain that
 * only matters when that generator actually has work to do, so none of them are
 * imported at module scope and several are not engine dependencies at all. Node
 * resolves a bare specifier from the engine's own location by walking up, and under
 * pnpm that walk passes through `node_modules/.pnpm/node_modules` - the hidden
 * directory holding every package installed ANYWHERE in the workspace. So a tool
 * declared by some member package (`tsoa`, via the `server` tag) or by the root
 * (`typescript`) resolves fine from here without the engine shipping its own copy.
 *
 * The failure mode is a consumer whose workspace never installed the tool, which
 * surfaces as a bare MODULE_NOT_FOUND naming a package they never asked for. The
 * helper below turns that into the install command instead.
 */

/** How to obtain each lazily-loaded tool, for the error message. */
const INSTALL_HINTS: Record<string, string> = {
  tsoa: "pnpm add tsoa",
  typescript: "pnpm add -D typescript",
  "ts-to-zod": "pnpm add -D ts-to-zod",
};

/**
 * `require` a generator tool from the workspace, reporting a missing one as an
 * actionable error rather than a raw MODULE_NOT_FOUND.
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
    const hint = INSTALL_HINTS[name] ?? `pnpm add -D ${name}`;
    throw new Error(
      `${reason} needs the \`${name}\` package, which is not installed in this workspace. ` +
        `Add it to the package that needs it (\`${hint}\`) and re-run.`,
      { cause },
    );
  }
}
