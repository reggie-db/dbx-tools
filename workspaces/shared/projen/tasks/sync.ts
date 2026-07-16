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
  // Watch: projen's own watcher owns re-synth (re-runs `.projenrc.ts` on any tree
  // change; touch it to force one), running alongside the focused barrels + openapi
  // watchers under `concurrently`. `projen --watch` does the initial synth on start,
  // so there is no separate pre-synth here.
  const { result } = concurrently(
    [
      { command: "pnpm exec projen --watch", name: "projen", prefixColor: "magenta" },
      { command: `tsx "${taskPath("barrels.ts")}" --watch`, name: "barrels", prefixColor: "cyan" },
      { command: `tsx "${taskPath("openapi.ts")}" --watch`, name: "openapi", prefixColor: "green" },
    ],
    { prefix: "name", killOthersOn: ["failure"] },
  );
  await result.catch(() => process.exit(1));
}
