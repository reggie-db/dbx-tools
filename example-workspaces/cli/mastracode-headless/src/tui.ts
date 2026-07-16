#!/usr/bin/env -S npx tsx
/**
 * Interactive Mastra Code TUI for this workspace example.
 *
 * Usage from this package: `pnpm mastracode`
 * Headless (scripts/CI): `pnpm mc-headless -- "summarize src/"`
 */
import { bootLocalAgentController } from "mastracode";
import { MastraTUI } from "mastracode/tui";

export async function runTui(): Promise<void> {
  const { controller, session } = await bootLocalAgentController({
    settingsPath: ".mastracode",
  });
  const tui = new MastraTUI({ controller, session });
  await tui.run();
}

if (import.meta.main) {
  await runTui();
}
