import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { type ArtifactTools, writeOpenapiArtifacts } from "../src/artifacts.ts";
import type { ArtifactPlan } from "../src/types.ts";

const TOOLS: ArtifactTools = {
  validate: () => undefined,
  optimize: () => undefined,
};

function document(title: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: { title, version: "1.0.0" },
    paths: {},
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {},
    },
  };
}

function plan(root: string, output: string): ArtifactPlan {
  return {
    output,
    document: document(output),
    rustSpecPath: join(root, "rust", output, "openapi.json"),
  };
}

function seedOldArtifacts(value: ArtifactPlan): void {
  mkdirSync(join(value.rustSpecPath, ".."), { recursive: true });
  writeFileSync(value.rustSpecPath, "old-rust");
}

test("preserves all existing outputs when a staged build fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "databricks-openapi-preserve-"));
  try {
    const first = plan(root, "first");
    const second = plan(root, "second");
    const rustClientPath = join(root, "rust", "src", "openapi.rs");
    seedOldArtifacts(first);
    seedOldArtifacts(second);
    mkdirSync(join(rustClientPath, ".."), { recursive: true });
    writeFileSync(rustClientPath, "old-client");
    let optimized = 0;

    await assert.rejects(
      writeOpenapiArtifacts([first, second], rustClientPath, {
        ...TOOLS,
        optimize: () => {
          optimized += 1;
          if (optimized === 2) throw new Error("spec optimization failed");
        },
      }),
      /spec optimization failed/,
    );

    assert.equal(readFileSync(first.rustSpecPath, "utf8"), "old-rust");
    assert.equal(readFileSync(second.rustSpecPath, "utf8"), "old-rust");
    assert.equal(readFileSync(rustClientPath, "utf8"), "old-client");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repeated generation produces byte-identical JSON and Rust artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "databricks-openapi-repeat-"));
  try {
    const value = plan(root, "widgets");
    const rustClientPath = join(root, "rust", "src", "openapi.rs");
    await writeOpenapiArtifacts([value], rustClientPath, TOOLS);
    const first = [readFileSync(value.rustSpecPath), readFileSync(rustClientPath)];

    await writeOpenapiArtifacts([value], rustClientPath, TOOLS);
    const second = [readFileSync(value.rustSpecPath), readFileSync(rustClientPath)];

    assert.equal(first.length, second.length);
    first.forEach((bytes, index) => assert.deepEqual(bytes, second[index]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
