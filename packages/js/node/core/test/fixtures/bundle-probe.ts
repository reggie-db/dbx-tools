/**
 * Child fixture: resolve bundle-backed config in a process whose `PATH` points at
 * a stub `databricks` CLI.
 *
 * A child rather than an in-process test because mutating `process.env.PATH` does
 * not affect how this runtime resolves a spawned executable - only the `env`
 * handed to the spawn does. The parent supplies that env, so the stub is what
 * `bundleFile` actually runs.
 */
import { bundleFile, text } from "../../src/config.ts";

const root = process.argv[2]!;
const keys = process.argv.slice(3);
const options = { cwd: root, scope: [] as const, sources: "bundle" as const };
process.stdout.write(
  `${JSON.stringify({
    file: bundleFile(root) !== undefined,
    values: keys.map((key) => text(key, options) ?? null),
  })}\n`,
);
