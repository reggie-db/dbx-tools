#!/usr/bin/env bun

import { resolve } from "node:path";

import { readFixture, runTypeScriptFixture } from "../src/harness.ts";

const fixturePath = resolve(process.argv[2] ?? "fixtures/core/fixture.json");
const results = await runTypeScriptFixture(readFixture(fixturePath));
process.stdout.write(`${JSON.stringify(results)}\n`);
