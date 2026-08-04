#!/usr/bin/env bun

import { resolve } from "node:path";

import { readPgAddressCases, runTypeScriptPgAddressCases } from "../src/pgaddress.ts";

const fixturePath = resolve(process.argv[2] ?? "fixtures/pgaddress.json");
const results = runTypeScriptPgAddressCases(readPgAddressCases(fixturePath));
process.stdout.write(`${JSON.stringify(results)}\n`);
