import { readFileSync } from "node:fs";

import { PostgresTopicBus } from "@dbx-tools/postgres";

export interface ChannelCase {
  name: string;
  input: unknown;
  expected: string;
}

export interface ChannelResult {
  name: string;
  result: string;
}

export function readChannelCases(path: string): ChannelCase[] {
  return JSON.parse(readFileSync(path, "utf8")) as ChannelCase[];
}

export function runTypeScriptChannelCases(cases: ChannelCase[]): ChannelResult[] {
  return cases.map(({ name, input }) => ({
    name,
    result: new PostgresTopicBus({} as never, { channel: input }).channelName,
  }));
}
