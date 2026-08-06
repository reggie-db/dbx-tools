import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../../src/topic-bus.ts", import.meta.url), "utf8");

export const topicBusConstants = {
  defaultChannel: stringConstant("DEFAULT_CHANNEL"),
  maxChannelLength: numberConstant("MAX_CHANNEL_LENGTH"),
  channelHashLength: numberConstant("CHANNEL_HASH_LENGTH"),
  channelFallback: stringConstant("CHANNEL_FALLBACK"),
  maxNotifyBytes: numberConstant("MAX_NOTIFY_BYTES"),
  minReconnectDelay: numberConstant("MIN_RECONNECT_DELAY_MS") / 1_000,
  maxReconnectDelay: numberConstant("MAX_RECONNECT_DELAY_MS") / 1_000,
};

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
