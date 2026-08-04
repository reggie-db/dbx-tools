#!/usr/bin/env bun

import { resolve } from "node:path";

import {
  readJson,
  runTypeScriptFixture,
  type FixtureSuite,
  type ModuleRegistry,
} from "../src/harness.ts";

const registryPath = resolve(process.argv[2] ?? "fixtures/modules.json");
const fixturePath = resolve(process.argv[3] ?? "fixtures/core-identity.json");
const results = await runTypeScriptFixture(
  readJson<ModuleRegistry>(registryPath),
  readJson<FixtureSuite>(fixturePath),
);
process.stdout.write(`${JSON.stringify(results)}\n`);
