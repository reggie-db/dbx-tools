/**
 * Append the explicit file extension Node ESM requires to every relative
 * specifier in a compiled tree.
 *
 * Sources are written for `moduleResolution: bundler`, so they import `"./http"`
 * with no extension, and `tsc` copies specifiers through untouched. Node's ESM
 * resolver does no extension probing, so that emitted output is unloadable -
 * which is the whole reason these packages used to publish source instead. The
 * alternative fix is to write `"./http.js"` at all 800-odd import sites and keep
 * writing it forever; this pass makes it a build detail instead.
 *
 * Deliberately filesystem-driven rather than clever: each specifier is resolved
 * against what `tsc` actually emitted, so a module that became a file and a
 * module that became a directory are told apart by looking, not by guessing.
 * Anything that does not resolve is left exactly as it was - a bare package
 * specifier, an asset, or a genuine mistake that should surface as itself.
 *
 * Usage: `tsx emit.ts <compiled-dir>` (relative to the package root).
 */
import { log } from "@dbx-tools/shared-core";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const logger = log.logger("projen:emit");

/**
 * The specifier of a static import/export or a dynamic `import()`.
 *
 * Anchored on the keyword that precedes it so a relative path appearing inside a
 * string literal or a comment is never touched.
 */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(\.\.?\/[^"']*)\2/g;

/** Extensions that are already explicit, whether JavaScript or an asset. */
const EXPLICIT = /\.(js|mjs|cjs|json|css|svg|png|jpg|jpeg|gif|webp)$/;

/** Files whose specifiers matter: the emitted JavaScript and its declarations. */
const EMITTED = /\.(js|mjs|cjs|d\.ts)$/;

/**
 * What a relative specifier must become, or `undefined` to leave it alone.
 *
 * Declarations resolve against the emitted `.js` too: inside a `.d.ts`,
 * TypeScript maps a `"./foo.js"` specifier onto the neighbouring `foo.d.ts`, so
 * both file kinds want the same suffix.
 */
function retarget(fileDir: string, specifier: string): string | undefined {
  if (EXPLICIT.test(specifier)) return undefined;
  const base = resolve(fileDir, specifier);
  if (existsSync(`${base}.js`)) return `${specifier}.js`;
  if (existsSync(join(base, "index.js"))) return `${specifier}/index.js`;
  return undefined;
}

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Rewrite one file in place; returns whether anything changed. */
function rewrite(file: string): boolean {
  const before = readFileSync(file, "utf8");
  const after = before.replace(SPECIFIER, (match, keyword, quote, specifier) => {
    const next = retarget(dirname(file), specifier as string);
    return next ? `${keyword}${quote}${next}${quote}` : match;
  });
  if (after === before) return false;
  writeFileSync(file, after);
  return true;
}

const target = resolve(process.argv[2] ?? "lib");
// A package whose compile produced nothing (no emit, or a tag that replaced the
// compile task) is not an error - there is simply nothing to fix up.
if (existsSync(target)) {
  const changed = walk(target)
    .filter((file) => EMITTED.test(file))
    .filter(rewrite).length;
  if (changed > 0) logger.debug(`emit: resolved specifiers in ${changed} files`);
}
