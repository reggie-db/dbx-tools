import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentToolDefinition } from "@databricks/appkit/beta";

import { entries, name } from "../src/toolkit-entries.ts";

const definitions: AgentToolDefinition[] = [
  {
    name: "read",
    description: "Read",
    parameters: { type: "object" },
    annotations: { effect: "read" },
  },
  {
    name: "write",
    description: "Write",
    parameters: { type: "object" },
    annotations: { effect: "write", destructive: true },
  },
];

describe("toolkit entry construction", () => {
  it("applies only and except before rename and prefix", () => {
    assert.equal(
      name("read", "records", {
        only: ["read"],
        except: ["write"],
        prefix: "db_",
        rename: { read: "lookup" },
      }),
      "lookup",
    );
    assert.equal(name("write", "records", { only: ["read"] }), null);
    assert.equal(name("write", "records", { except: ["write"] }), null);
    assert.equal(name("write", "records", { prefix: "db_" }), "db_write");
    assert.equal(name("write", "records"), "records.write");
  });

  it("preserves definitions and native annotations", () => {
    const toolkit = entries("records", definitions, {
      rename: { write: "save" },
    });

    assert.deepEqual(Object.keys(toolkit), ["records.read", "save"]);
    assert.equal(toolkit.save?.pluginName, "records");
    assert.equal(toolkit.save?.localName, "write");
    assert.equal(toolkit.save?.def.name, "save");
    assert.equal(toolkit.save?.annotations?.destructive, true);
  });
});
