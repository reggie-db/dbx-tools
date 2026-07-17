/**
 * Unit tests for the pure event-detection layer (`event.ts`).
 *
 * Three concerns are covered, each in its own block:
 *
 *   1. The detector factory + every concrete detector. Detectors
 *      are pure functions of `(current, previous, location)` so the
 *      tests are straight value-in / value-out assertions; no I/O,
 *      no timers, no SDK mocks.
 *   2. The `eventsFromMessage` sync generator. Verifies dispatch
 *      order, multiple-attachment fan-out, and the prev-attachment
 *      match strategy (id-based when ids exist, positional for
 *      anonymous slots).
 *   3. The discriminated-union shape: every detector's output gets
 *      stamped with the matching `type` literal at yield time, and
 *      TypeScript narrows correctly on the `type` discriminator.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectAttachmentAdded,
  detectQuery,
  detectRows,
  detectStatement,
  detectStatus,
  detectSuggestedQuestions,
  detectText,
  detectThinking,
  eventDetector,
  eventsFromMessage,
} from "../src/event";
import type {
  AttachmentEvent,
  GenieAttachment,
  GenieChatEvent,
  GenieChatEventFields,
  GenieChatLocation,
  GenieMessage,
  GenieThought,
  ThinkingEvent,
} from "../src/genie-model";

/* ----------------------------- fixtures ---------------------------- */

const SPACE_ID = "space-1";
const CONV_ID = "conv-1";
const MSG_ID = "msg-1";

function makeLoc(over: Partial<GenieChatLocation> = {}): GenieChatLocation {
  return {
    space_id: SPACE_ID,
    conversation_id: CONV_ID,
    message_id: MSG_ID,
    ...over,
  };
}

function makeMessage(over: Partial<GenieMessage> = {}): GenieMessage {
  return {
    space_id: SPACE_ID,
    conversation_id: CONV_ID,
    message_id: MSG_ID,
    ...over,
  } as GenieMessage;
}

function thought(
  thought_type: GenieThought["thought_type"],
  content: string,
): GenieThought {
  return { thought_type, content };
}

/**
 * Assert that `actual` contains at least the key/value pairs in
 * `expected` (shallow, like Jest's `toMatchObject` for flat
 * payloads).
 */
function matchObject(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual && typeof actual === "object", "expected an object");
  const a = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    assert.deepEqual(a[k], v, `key ${k}`);
  }
}

/** Recursively drop `undefined`-valued keys so a present-but-undefined
 * optional (e.g. a detector's `title: undefined`) compares equal to an
 * omitted one - matching the intent of the original `toEqual` tests. */
function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(pruneUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = pruneUndefined(v);
    }
    return out as T;
  }
  return value;
}

/** Deep-equal that ignores `undefined`-valued keys on both sides. */
function equalPayload(actual: unknown, expected: unknown): void {
  assert.deepEqual(pruneUndefined(actual), pruneUndefined(expected));
}

/* -------------------------- eventDetector -------------------------- */

describe("eventDetector", () => {
  it("returns an EventDetector with the literal type and the detect fn", () => {
    const fn: Parameters<typeof eventDetector<"status">>[1] = (
      current,
      _previous,
      space_id,
    ) => ({
      status: current.status!,
      previous_status: undefined,
      space_id,
      conversation_id: current.conversation_id,
      message_id: current.message_id,
    });
    const d = eventDetector("status", fn);
    assert.equal(d.type, "status");
    assert.equal(d.detect, fn);
  });
});

/* ---------------------------- detectStatus -------------------------- */

describe("detectStatus", () => {
  it("emits with previous_status undefined on the first status seen", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "SUBMITTED" }),
      undefined,
      SPACE_ID,
    );
    equalPayload(out, {
      status: "SUBMITTED",
      previous_status: undefined,
      space_id: SPACE_ID,
      conversation_id: CONV_ID,
      message_id: MSG_ID,
    } satisfies GenieChatEventFields<"status">);
  });

  it("emits the transition when status differs from previous", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "COMPLETED" }),
      makeMessage({ status: "ASKING_AI" }),
      SPACE_ID,
    );
    matchObject(out, {
      status: "COMPLETED",
      previous_status: "ASKING_AI",
    });
  });

  it("does not emit when status is unchanged", () => {
    const out = detectStatus.detect(
      makeMessage({ status: "ASKING_AI" }),
      makeMessage({ status: "ASKING_AI" }),
      SPACE_ID,
    );
    assert.equal(out, undefined);
  });

  it("does not emit when current.status is undefined", () => {
    const out = detectStatus.detect(makeMessage(), undefined, SPACE_ID);
    assert.equal(out, undefined);
  });
});

/* ------------------------ detectAttachmentAdded --------------------- */

describe("detectAttachmentAdded", () => {
  it("emits on first sight (no previous) with the detected attachment_type", () => {
    const att: GenieAttachment = { attachment_id: "a1", text: { content: "hi" } };
    const out = detectAttachmentAdded.detect(
      att,
      undefined,
      makeLoc({ attachment_id: "a1" }),
      0,
    );
    equalPayload(out, {
      ...makeLoc({ attachment_id: "a1" }),
      index: 0,
      attachment_type: "text",
    } satisfies GenieChatEventFields<"attachment">);
  });

  it("does not emit when the slot already existed", () => {
    const att: GenieAttachment = { attachment_id: "a1", text: { content: "hi" } };
    assert.equal(
      detectAttachmentAdded.detect(att, att, makeLoc({ attachment_id: "a1" }), 0),
      undefined,
    );
  });

  it("reports the right attachment_type for query / suggested_questions attachments", () => {
    matchObject(
      detectAttachmentAdded.detect(
        { attachment_id: "q1", query: { query: "SELECT 1" } },
        undefined,
        makeLoc({ attachment_id: "q1" }),
        1,
      ),
      { index: 1, attachment_type: "query" },
    );

    matchObject(
      detectAttachmentAdded.detect(
        {
          attachment_id: "sq1",
          suggested_questions: { questions: ["Foo?", "Bar?"] },
        },
        undefined,
        makeLoc({ attachment_id: "sq1" }),
        2,
      ),
      { index: 2, attachment_type: "suggested_questions" },
    );
  });
});

/* ---------------------------- detectThinking ------------------------ */

describe("detectThinking", () => {
  it("returns undefined when the attachment has no thoughts", () => {
    const att: GenieAttachment = { attachment_id: "q1", query: { query: "SELECT 1" } };
    assert.equal(detectThinking.detect(att, undefined, makeLoc(), 0), undefined);
  });

  it("emits one event per thought on the first observation", () => {
    const att: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "what the user asked"),
          thought("THOUGHT_TYPE_STEPS", "step 1"),
        ],
      },
    };
    const out = detectThinking.detect(att, undefined, makeLoc(), 0);
    equalPayload(out, [
      {
        ...makeLoc(),
        text: "what the user asked",
        thought_type: "THOUGHT_TYPE_DESCRIPTION",
      },
      {
        ...makeLoc(),
        text: "step 1",
        thought_type: "THOUGHT_TYPE_STEPS",
      },
    ] satisfies GenieChatEventFields<"thinking">[]);
  });

  it("emits only the newly-added (type, content) tuples on a subsequent snapshot", () => {
    const prev: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [thought("THOUGHT_TYPE_DESCRIPTION", "first")],
      },
    };
    const curr: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "first"),
          thought("THOUGHT_TYPE_STEPS", "second"),
        ],
      },
    };
    const out = detectThinking.detect(curr, prev, makeLoc(), 0);
    equalPayload(out, [
      { ...makeLoc(), text: "second", thought_type: "THOUGHT_TYPE_STEPS" },
    ]);
  });

  it("uses a value-based set diff so re-typed / reordered thoughts only emit the new tuple", () => {
    // Genie can mutate index 0 in place (e.g. promote a DATA_SOURCING
    // thought to DESCRIPTION while re-appending the original at
    // index 1). A positional diff would mis-report the re-typed
    // slot as new and re-emit the moved one.
    const prev: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [thought("THOUGHT_TYPE_DATA_SOURCING", "tables...")],
      },
    };
    const curr: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_DESCRIPTION", "restatement"),
          thought("THOUGHT_TYPE_DATA_SOURCING", "tables..."),
        ],
      },
    };
    const out = detectThinking.detect(curr, prev, makeLoc(), 0);
    equalPayload(out, [
      {
        ...makeLoc(),
        text: "restatement",
        thought_type: "THOUGHT_TYPE_DESCRIPTION",
      },
    ]);
  });

  it("dedupes within a single snapshot if Genie ever ships the same tuple twice", () => {
    const att: GenieAttachment = {
      attachment_id: "q1",
      query: {
        thoughts: [
          thought("THOUGHT_TYPE_STEPS", "step"),
          thought("THOUGHT_TYPE_STEPS", "step"),
        ],
      },
    };
    const out = detectThinking.detect(att, undefined, makeLoc(), 0);
    equalPayload(out, [
      { ...makeLoc(), text: "step", thought_type: "THOUGHT_TYPE_STEPS" },
    ]);
  });
});

/* ----------------------------- detectText --------------------------- */

describe("detectText", () => {
  it("emits when text content first appears", () => {
    const out = detectText.detect(
      { attachment_id: "t1", text: { content: "hello" } },
      undefined,
      makeLoc({ attachment_id: "t1" }),
      0,
    );
    equalPayload(out, { ...makeLoc({ attachment_id: "t1" }), text: "hello" });
  });

  it("emits when text content changes", () => {
    const out = detectText.detect(
      { attachment_id: "t1", text: { content: "hello world" } },
      { attachment_id: "t1", text: { content: "hello" } },
      makeLoc({ attachment_id: "t1" }),
      0,
    );
    matchObject(out, { text: "hello world" });
  });

  it("does not emit when content is unchanged", () => {
    const same: GenieAttachment = { attachment_id: "t1", text: { content: "x" } };
    assert.equal(detectText.detect(same, same, makeLoc(), 0), undefined);
  });

  it("does not emit when text is undefined", () => {
    assert.equal(
      detectText.detect({ attachment_id: "x" }, undefined, makeLoc(), 0),
      undefined,
    );
  });
});

/* ----------------------------- detectQuery -------------------------- */

describe("detectQuery", () => {
  it("emits when SQL first appears", () => {
    const out = detectQuery.detect(
      { attachment_id: "q1", query: { query: "SELECT 1" } },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    equalPayload(out, { ...makeLoc({ attachment_id: "q1" }), sql: "SELECT 1" });
  });

  it("emits when SQL is rewritten", () => {
    const out = detectQuery.detect(
      { attachment_id: "q1", query: { query: "SELECT 2" } },
      { attachment_id: "q1", query: { query: "SELECT 1" } },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    matchObject(out, { sql: "SELECT 2" });
  });

  it("does not emit when SQL is unchanged or missing", () => {
    const same: GenieAttachment = {
      attachment_id: "q1",
      query: { query: "SELECT 1" },
    };
    assert.equal(detectQuery.detect(same, same, makeLoc(), 0), undefined);
    assert.equal(
      detectQuery.detect({ attachment_id: "q1", query: {} }, undefined, makeLoc(), 0),
      undefined,
    );
  });
});

/* ---------------------------- detectStatement ----------------------- */

describe("detectStatement", () => {
  it("emits when statement_id transitions undefined -> string", () => {
    const out = detectStatement.detect(
      { attachment_id: "q1", query: { statement_id: "stmt-1" } },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    equalPayload(out, {
      ...makeLoc({ attachment_id: "q1" }),
      statement_id: "stmt-1",
    });
  });

  it("does not emit when statement_id is unchanged", () => {
    const a: GenieAttachment = {
      attachment_id: "q1",
      query: { statement_id: "stmt-1" },
    };
    assert.equal(detectStatement.detect(a, a, makeLoc(), 0), undefined);
  });
});

/* ----------------------------- detectRows --------------------------- */

describe("detectRows", () => {
  it("emits on undefined -> 0 (initial observation)", () => {
    const out = detectRows.detect(
      {
        attachment_id: "q1",
        query: { query_result_metadata: { row_count: 0 } },
      },
      { attachment_id: "q1", query: {} },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    matchObject(out, { row_count: 0, previous_row_count: undefined });
  });

  it("emits on 0 -> N once warehouse execution completes", () => {
    const out = detectRows.detect(
      {
        attachment_id: "q1",
        query: {
          statement_id: "stmt-1",
          query_result_metadata: { row_count: 42 },
        },
      },
      {
        attachment_id: "q1",
        query: {
          statement_id: "stmt-1",
          query_result_metadata: { row_count: 0 },
        },
      },
      makeLoc({ attachment_id: "q1" }),
      0,
    );
    matchObject(out, {
      row_count: 42,
      previous_row_count: 0,
      statement_id: "stmt-1",
    });
  });

  it("does not emit when row_count is unchanged", () => {
    const a: GenieAttachment = {
      attachment_id: "q1",
      query: { query_result_metadata: { row_count: 5 } },
    };
    assert.equal(detectRows.detect(a, a, makeLoc(), 0), undefined);
  });
});

/* ----------------------- detectSuggestedQuestions ------------------- */

describe("detectSuggestedQuestions", () => {
  it("emits when questions first appear", () => {
    const out = detectSuggestedQuestions.detect(
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["Foo?", "Bar?"] },
      },
      undefined,
      makeLoc({ attachment_id: "sq1" }),
      0,
    );
    matchObject(out, { questions: ["Foo?", "Bar?"] });
  });

  it("emits when the questions list is rewritten (length-preserving)", () => {
    const out = detectSuggestedQuestions.detect(
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["A?", "B?"] },
      },
      {
        attachment_id: "sq1",
        suggested_questions: { questions: ["A?", "C?"] },
      },
      makeLoc({ attachment_id: "sq1" }),
      0,
    );
    matchObject(out, { questions: ["A?", "B?"] });
  });

  it("does not emit on an empty list", () => {
    assert.equal(
      detectSuggestedQuestions.detect(
        { attachment_id: "sq1", suggested_questions: { questions: [] } },
        undefined,
        makeLoc(),
        0,
      ),
      undefined,
    );
  });

  it("does not emit when the JSON-stringified list is unchanged", () => {
    const same: GenieAttachment = {
      attachment_id: "sq1",
      suggested_questions: { questions: ["Foo?", "Bar?"] },
    };
    assert.equal(detectSuggestedQuestions.detect(same, same, makeLoc(), 0), undefined);
  });
});

/* -------------------------- eventsFromMessage ----------------------- */

describe("eventsFromMessage", () => {
  // Drain the sync generator to an array. Every yield is a flat
  // `{type, ...fields}` object per the GenieChatEvent contract;
  // the discriminator narrows the rest of the fields per variant.
  function collect(
    current: GenieMessage,
    previous: GenieMessage | undefined,
    space_id: string = SPACE_ID,
  ): GenieChatEvent[] {
    return [...eventsFromMessage(current, previous, space_id)];
  }

  it("yields every event with the type discriminator stamped", () => {
    const curr = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(curr, undefined);
    // Each variant carries its discriminator.
    for (const e of events) {
      assert.equal(typeof e.type, "string");
    }
    assert.equal(events[0]?.type, "status");
  });

  it("dispatches status before any attachment events", () => {
    const curr = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(curr, undefined);
    assert.deepEqual(
      events.map((e) => e.type),
      ["status", "attachment", "query"],
    );
  });

  it("fans out per-attachment events with the correct index", () => {
    const curr = makeMessage({
      attachments: [
        { attachment_id: "t1", text: { content: "hi" } },
        { attachment_id: "q1", query: { query: "SELECT 1" } },
      ],
    });
    const events = collect(curr, undefined);

    const attachmentEvents = events.filter(
      (e): e is AttachmentEvent => e.type === "attachment",
    );
    assert.equal(attachmentEvents.length, 2);
    matchObject(attachmentEvents[0], {
      index: 0,
      attachment_type: "text",
      attachment_id: "t1",
    });
    matchObject(attachmentEvents[1], {
      index: 1,
      attachment_type: "query",
      attachment_id: "q1",
    });
  });

  it("matches an id'd attachment to the prev slot by id regardless of position", () => {
    const prev = makeMessage({
      attachments: [
        { attachment_id: "a", text: { content: "x" } },
        { attachment_id: "b", query: { query: "SELECT 1" } },
      ],
    });
    // Same attachments, swapped order. The query SQL is unchanged
    // and the text attachment is unchanged, so no `query` /
    // `text` events should fire even though positional matching
    // would think both are brand-new.
    const curr = makeMessage({
      attachments: [
        { attachment_id: "b", query: { query: "SELECT 1" } },
        { attachment_id: "a", text: { content: "x" } },
      ],
    });
    const events = collect(curr, prev);
    assert.equal(events.filter((e) => e.type === "attachment").length, 0);
    assert.equal(events.filter((e) => e.type === "query").length, 0);
    assert.equal(events.filter((e) => e.type === "text").length, 0);
  });

  it("matches anonymous attachments positionally and does not bind to an id'd predecessor", () => {
    const prev = makeMessage({
      attachments: [{ text: { content: "old" } }],
    });
    const curr = makeMessage({
      attachments: [{ text: { content: "new" } }],
    });
    const events = collect(curr, prev);

    const textEvents = events.filter((e) => e.type === "text");
    assert.equal(textEvents.length, 1);
    matchObject(textEvents[0], { text: "new" });
    assert.equal(events.filter((e) => e.type === "attachment").length, 0);
  });

  it("does not bind an id'd attachment to an anonymous predecessor at the same slot", () => {
    const prev = makeMessage({
      attachments: [{ text: { content: "x" } }],
    });
    const curr = makeMessage({
      attachments: [{ attachment_id: "a", text: { content: "x" } }],
    });
    const events = collect(curr, prev);
    const attachmentEvents = events.filter(
      (e): e is AttachmentEvent => e.type === "attachment",
    );
    assert.equal(attachmentEvents.length, 1);
    matchObject(attachmentEvents[0], {
      attachment_id: "a",
      attachment_type: "text",
    });
  });

  it("does NOT emit message or result (those are lifecycle, handled by the chat driver)", () => {
    // Even when the snapshot's status is terminal,
    // `eventsFromMessage` is pure-diff and shouldn't emit the
    // lifecycle envelope.
    const curr = makeMessage({ status: "COMPLETED" });
    const events = collect(curr, undefined);
    assert.equal(
      events.some((e) => e.type === "message"),
      false,
    );
    assert.equal(
      events.some((e) => e.type === "result"),
      false,
    );
  });

  it("no-ops on attachments[] when nothing changed", () => {
    const a = makeMessage({
      status: "ASKING_AI",
      attachments: [{ attachment_id: "q1", query: { query: "SELECT 1" } }],
    });
    const events = collect(a, a);
    assert.equal(events.length, 0);
  });

  it("yields multiple thinking events as separate flat events", () => {
    const curr = makeMessage({
      attachments: [
        {
          attachment_id: "q1",
          query: {
            thoughts: [
              thought("THOUGHT_TYPE_DESCRIPTION", "first"),
              thought("THOUGHT_TYPE_STEPS", "second"),
            ],
          },
        },
      ],
    });
    const events = collect(curr, undefined);
    const thinking = events.filter((e): e is ThinkingEvent => e.type === "thinking");
    assert.equal(thinking.length, 2);
    assert.equal(thinking[0]!.thought_type, "THOUGHT_TYPE_DESCRIPTION");
    assert.equal(thinking[1]!.thought_type, "THOUGHT_TYPE_STEPS");
  });
});
