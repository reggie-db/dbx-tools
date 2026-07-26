/**
 * Generated `bin/<name>.mjs` launchers for a CLI package's TypeScript entries.
 *
 * A CLI's real entry is a `.ts` file, which Node cannot run on its own, so something
 * has to register tsx first. A `#!/usr/bin/env -S npx tsx` shebang does that only for
 * a WORKSPACE checkout: `npx` resolves tsx from the current working directory, and a
 * globally installed CLI (`npm i -g @dbx-tools/cli`) has no relationship to whatever
 * directory the user happens to be in - so every first invocation stalls to fetch tsx
 * from the network, or fails outright when offline.
 *
 * {@link CliBinLauncher} emits a tiny `.mjs` sibling that npm points its bin symlink
 * at. Because the launcher reaches tsx through a bare `import` specifier, NODE
 * resolves it relative to the launcher's own location - i.e. the CLI package's own
 * `node_modules` - which is exactly where the `cli` tag's runtime tsx dependency
 * installs it. The `.ts` entry stays the source of truth; the launcher only registers
 * the loader and hands off.
 *
 * {@link addCliBinLaunchers} discovers the entries by scanning the package's `bin/`
 * directory at synth, so a new CLI just needs its `.ts` file plus a `package.json`
 * bin pointing at the matching `.mjs`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type Project, TextFile } from "projen";
import { header } from "./generated";

/** Directory (package-relative) holding a CLI's executable entries. */
const BIN_DIR = "bin";

/** Render the launcher source for a `.ts` entry sitting beside it. */
function renderLauncher(entryFileName: string): string {
  return `#!/usr/bin/env node
${header({
  tool: "projen synth (cli tag)",
  source: `./${entryFileName}`,
})}
// Resolved as a bare specifier so Node looks in THIS file's package rather than the
// caller's cwd - the only way a globally installed CLI finds its own tsx.
import { register } from "tsx/esm/api";

register();
await import(new URL(${JSON.stringify(`./${entryFileName}`)}, import.meta.url).href);
`;
}

/**
 * A projen-owned, read-only `.mjs` launcher that registers tsx and defers to the
 * `.ts` entry beside it.
 */
export class CliBinLauncher extends TextFile {
  constructor(project: Project, entryFileName: string) {
    super(project, join(BIN_DIR, entryFileName.replace(/\.ts$/, ".mjs")), {
      readonly: true,
      executable: true,
      lines: renderLauncher(entryFileName).split("\n"),
    });
  }
}

/**
 * Emit a {@link CliBinLauncher} for every `.ts` entry in the package's `bin/`
 * directory. A package with no `bin/` directory is left alone.
 */
export function addCliBinLaunchers(project: Project): void {
  const binDir = join(project.outdir, BIN_DIR);
  if (!existsSync(binDir)) return;

  for (const entry of readdirSync(binDir).sort()) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
    new CliBinLauncher(project, entry);
  }
}
