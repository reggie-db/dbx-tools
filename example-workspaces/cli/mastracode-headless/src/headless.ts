#!/usr/bin/env -S npx tsx
/**
 * Mastra Code headless runner: non-interactive `runMC` invocation for scripts/CI.
 *
 * Usage: `pnpm mc-headless "summarize src/"`
 */
import { createMastraCode, runMC } from "mastracode";

export async function runHeadless(prompt: string): Promise<void> {
  const { controller, session } = await createMastraCode({
    settingsPath: ".mastracode",
  });
  const run = runMC({ controller, session, prompt });
  const result = await run.result;
  console.log(result.text ?? result);
}

if (import.meta.main) {
  const prompt = process.argv[2];
  if (!prompt) {
    console.error("usage: mc-headless <prompt>");
    process.exit(1);
  }
  await runHeadless(prompt);
}
