#!/usr/bin/env bun

import { resolve } from "node:path";

import { readChannelCases, runTypeScriptChannelCases } from "../src/channel.ts";

const fixturePath = resolve(process.argv[2] ?? "fixtures/channel.json");
const results = runTypeScriptChannelCases(readChannelCases(fixturePath));
process.stdout.write(`${JSON.stringify(results)}\n`);
