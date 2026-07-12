/**
 * Scaffold helpers.
 *
 * Discovery happens in `configureProjen` at synth time (it finds every
 * `packages/<scope>/<name>/src` folder). These helpers let the one-shot
 * `dbxtools sync` decide, without any in-memory state, whether the package set
 * changed since the last synth - by comparing disk to the projen-owned
 * `projenrc/discovered.json` record - and re-synth only then.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DISCOVERED_FILE } from "./discovered";
import { discoverPackagesOnDisk, repoRoot } from "./workspace";

/** Sorted `packages/<scope>/<name>` dirs that currently have source on disk. */
export function packageDirs(): string[] {
  return discoverPackagesOnDisk()
    .map((p) => `packages/${p.scope}/${p.name}`)
    .sort();
}

/** The package dirs recorded by the last synth (from projenrc/discovered.json). */
function recordedDirs(): string[] {
  try {
    const doc = JSON.parse(readFileSync(join(repoRoot, DISCOVERED_FILE), "utf8"));
    const rows: { scope: string; name: string }[] = doc.packages ?? [];
    return rows.map((r) => `packages/${r.scope}/${r.name}`).sort();
  } catch {
    return [];
  }
}

/** True if the set of package folders differs from the last synth's record. */
export function packageSetChanged(): boolean {
  const now = packageDirs();
  const then = recordedDirs();
  return now.length !== then.length || now.some((d, i) => d !== then[i]);
}

/**
 * Re-run projen synth. `node --import tsx` runs the projenrc without projen's
 * network re-exec; PROJEN_DISABLE_POST skips the post-synth `pnpm install`.
 */
export function runSynth(): void {
  execFileSync(process.execPath, ["--import", "tsx", join(repoRoot, ".projenrc.ts")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PROJEN_DISABLE_POST: "true" },
  });
}
