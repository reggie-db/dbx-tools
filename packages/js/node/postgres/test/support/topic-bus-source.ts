import { readFileSync } from "node:fs";

const topicBusSource = readFileSync(new URL("../../src/topic-bus.ts", import.meta.url), "utf8");

export const topicBusConstants = {
  defaultChannel: stringConstant(topicBusSource, "DEFAULT_CHANNEL", "topic-bus.ts"),
  maxNotifyBytes: numberConstant(topicBusSource, "MAX_NOTIFY_BYTES", "topic-bus.ts"),
  minReconnectDelay:
    numberConstant(topicBusSource, "MIN_RECONNECT_DELAY_MS", "topic-bus.ts") / 1_000,
  maxReconnectDelay:
    numberConstant(topicBusSource, "MAX_RECONNECT_DELAY_MS", "topic-bus.ts") / 1_000,
};

function stringConstant(source: string, name: string, file: string): string {
  const match = source.match(new RegExp(`const ${name} = "([^"]+)";`));
  if (!match) throw new Error(`Missing string constant ${name} in ${file}`);
  return match[1]!;
}

function numberConstant(source: string, name: string, file: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  if (!match) throw new Error(`Missing number constant ${name} in ${file}`);
  return Number(match[1]!.replaceAll("_", ""));
}
