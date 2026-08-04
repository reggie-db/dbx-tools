import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../../../../js/node/postgres/src/topic-bus.ts", import.meta.url),
  "utf8",
);

export const DEFAULT_CHANNEL = stringConstant("DEFAULT_CHANNEL");
export const MAX_CHANNEL_LENGTH = numberConstant("MAX_CHANNEL_LENGTH");
export const CHANNEL_HASH_LENGTH = numberConstant("CHANNEL_HASH_LENGTH");
export const CHANNEL_FALLBACK = stringConstant("CHANNEL_FALLBACK");
export const MAX_NOTIFY_BYTES = numberConstant("MAX_NOTIFY_BYTES");
export const MIN_RECONNECT_DELAY = numberConstant("MIN_RECONNECT_DELAY_MS") / 1_000;
export const MAX_RECONNECT_DELAY = numberConstant("MAX_RECONNECT_DELAY_MS") / 1_000;

function stringConstant(name: string): string {
  const match = source.match(new RegExp(`const ${name} = "([^"]+)";`));
  if (!match) throw new Error(`Missing string constant ${name} in topic-bus.ts`);
  return match[1]!;
}

function numberConstant(name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  if (!match) throw new Error(`Missing number constant ${name} in topic-bus.ts`);
  return Number(match[1]!.replaceAll("_", ""));
}
