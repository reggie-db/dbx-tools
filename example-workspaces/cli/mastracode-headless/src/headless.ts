#!/usr/bin/env -S npx tsx
/**
 * Mastra Code headless runner: non-interactive `runMC` invocation for scripts/CI.
 *
 * Usage: `pnpm mc-headless -- "summarize src/"` (from this package directory)
 *
 * Interactive TUI: `pnpm mastracode`
 */
import { createMastraCode, runMC } from "mastracode";

export async function runHeadless(prompt: string): Promise<void> {
  const { controller, session } = await createMastraCode({
    settingsPath: ".mastracode",
  });
  const run = runMC({ controller, session, prompt });
  const result = await run.result;
  console.log(result.text);
  if (result.exitCode !== 0) {
    process.exit(result.exitCode);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const prompt = (argv[0] === "--" ? argv.slice(1) : argv).join(" ").trim();
  if (!prompt) {
    console.error("usage: mc-headless <prompt>");
    process.exit(1);
  }
  await runHeadless(prompt);
}
