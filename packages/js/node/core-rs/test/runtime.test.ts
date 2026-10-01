import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { isDatabricksAppEnvironment } from "../index.ts";

interface Fixture {
  readonly name: string;
  readonly environment: Record<string, string>;
  readonly detected: boolean;
}

test("detects every shared Databricks App environment fixture", () => {
  const fixtures = JSON.parse(
    readFileSync(
      resolve(
        import.meta.dirname,
        "../../../../test/fixtures/config/databricks-app-environments.json",
      ),
      "utf8",
    ),
  ) as Fixture[];
  for (const fixture of fixtures) {
    assert.equal(
      isDatabricksAppEnvironment(new Map(Object.entries(fixture.environment))),
      fixture.detected,
      fixture.name,
    );
  }
});
