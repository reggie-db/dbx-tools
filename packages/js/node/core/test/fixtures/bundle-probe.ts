/**
 * Child fixture: resolve bundle-backed config in a process whose `PATH` points at
 * a stub `databricks` CLI.
 *
 * A child rather than an in-process test because mutating `process.env.PATH` does
 * not affect how this runtime resolves a spawned executable - only the `env`
 * handed to the spawn does. The parent supplies that env, so the stub is what
 * `bundleFile` actually runs.
 */
import { bundleFile, text } from "../../src/config-utils.ts";

const root = process.argv[2]!;
const keys = process.argv.slice(3);
const profile = process.env.PROBE_BUNDLE_PROFILE;
const originalCwd = process.cwd();
process.chdir(root);
try {
  process.stdout.write(
    `${JSON.stringify({
      file: bundleFile(null, profile) !== undefined,
      values: keys.map(
        (key, index) =>
          text(key, {
            cwd: index % 2 === 0 ? "" : process.cwd(),
            scope: [] as const,
            bundleProfile: profile,
          }) ?? null,
      ),
    })}\n`,
  );
} finally {
  process.chdir(originalCwd);
}
