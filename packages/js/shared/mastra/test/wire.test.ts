import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MessageStatusSchema } from "@dbx-tools/shared-genie";
import { z } from "zod";

import { AskGenieDoneEventSchema, GenieWriterEventSchema } from "../src/wire.ts";

const EVENT = {
  type: "ask_genie_done",
  spaceId: "space",
  statementIds: [],
  status: "COMPLETED",
};

describe("Genie completion event status", () => {
  it("validates the declared Genie status vocabulary through its owner", () => {
    for (const option of MessageStatusSchema.options) {
      const status = option.value;
      assert.equal(AskGenieDoneEventSchema.parse({ ...EVENT, status }).status, status);
    }
    for (const status of ["unknown", "", 42, null, undefined]) {
      assert.throws(() => AskGenieDoneEventSchema.parse({ ...EVENT, status }));
      assert.throws(() => GenieWriterEventSchema.parse({ ...EVENT, status }));
    }
  });

  it("can publish a JSON schema for the status instead of an opaque custom validator", () => {
    const schema = z.toJSONSchema(AskGenieDoneEventSchema);
    assert.deepEqual(schema.properties?.status, {
      anyOf: MessageStatusSchema.options.map((option) => ({
        type: "string",
        const: option.value,
      })),
      description: AskGenieDoneEventSchema.shape.status.description,
    });
  });
});
