#!/usr/bin/env -S npx tsx
import { fileURLToPath } from "node:url";
import concurrently from "concurrently";
import { logger } from "../src/log";
import { runSynth } from "../src/scaffold";

const log = logger.withTag("projen:sync");

/** Absolute path to a sibling task script, so `concurrently`'s cwd doesn't matter. */
function taskPath(script: string): string {
  return fileURLToPath(new URL(`./${script}`, import.meta.url));
}

if (!process.argv.includes("--watch")) {
  // One-shot: full synth (+install + barrels via the post-synth component).
  log.start("synthesizing");
  runSynth({ post: true });
  log.success("synced");
} else {
  // Watch: one initial full synth to bring the tree up to date, then three focused
  // watchers under `concurrently`. The projenrc watcher is the intelligent stand-in
  // for stock `projen --watch` - it re-synths (+install) ONLY when `.projenrc.ts`
  // changes, while barrels/openapi keep generated OUTPUT fresh on source edits with
  // no full synth. Touch `.projenrc.ts` to force a re-synth.
  log.start("initial sync");
  runSynth({ post: true });
  log.success("synced - watching (Ctrl-C to stop)");
  const { result } = concurrently(
    [
      { command: `tsx "${taskPath("projenrc.ts")}"`, name: "projenrc", prefixColor: "magenta" },
      { command: `tsx "${taskPath("barrels.ts")}" --watch`, name: "barrels", prefixColor: "cyan" },
      { command: `tsx "${taskPath("openapi.ts")}" --watch`, name: "openapi", prefixColor: "green" },
    ],
    { prefix: "name", killOthersOn: ["failure"] },
  );
  await result.catch(() => process.exit(1));
}
