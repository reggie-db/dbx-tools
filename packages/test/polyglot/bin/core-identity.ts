#!/usr/bin/env bun

import { resolve } from "node:path";

import { readCoreIdentityCases, runTypeScriptCoreIdentityCases } from "../src/core-identity.ts";

const fixturePath = resolve(process.argv[2] ?? "fixtures/core-identity.json");
const results = runTypeScriptCoreIdentityCases(readCoreIdentityCases(fixturePath));
process.stdout.write(`${JSON.stringify(results)}\n`);
