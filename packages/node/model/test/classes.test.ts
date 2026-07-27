import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { model } from "@dbx-tools/shared-model";

import {
  CHAT_CLASS_ORDER,
  classesAtOrBelow,
  isChatClass,
  MODEL_CLASS_ORDER,
  parseModelClass,
} from "../src/classes";

const { ModelClass } = model;

describe("CHAT_CLASS_ORDER / MODEL_CLASS_ORDER", () => {
  it("orders chat bands most-capable first, embedding excluded from the ladder", () => {
    assert.deepEqual(CHAT_CLASS_ORDER, [
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    assert.deepEqual(MODEL_CLASS_ORDER, [
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
      ModelClass.Embedding,
    ]);
  });
});

describe("isChatClass", () => {
  it("is true for chat bands and false for embedding", () => {
    assert.equal(isChatClass(ModelClass.ChatThinking), true);
    assert.equal(isChatClass(ModelClass.ChatFast), true);
    assert.equal(isChatClass(ModelClass.Embedding), false);
  });
});

describe("classesAtOrBelow", () => {
  it("treats a chat band as a ceiling - the band and everything below it", () => {
    assert.deepEqual(classesAtOrBelow(ModelClass.ChatThinking), [
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    assert.deepEqual(classesAtOrBelow(ModelClass.ChatBalanced), [
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    assert.deepEqual(classesAtOrBelow(ModelClass.ChatFast), [ModelClass.ChatFast]);
  });

  it("keeps embedding to itself - it is not a rung on the chat ladder", () => {
    assert.deepEqual(classesAtOrBelow(ModelClass.Embedding), [ModelClass.Embedding]);
  });
});

describe("parseModelClass", () => {
  it("accepts full slugs and rejects junk", () => {
    assert.equal(parseModelClass("chat-thinking"), ModelClass.ChatThinking);
    assert.equal(parseModelClass("chat-balanced"), ModelClass.ChatBalanced);
    assert.equal(parseModelClass("chat-fast"), ModelClass.ChatFast);
    assert.equal(parseModelClass("embedding"), ModelClass.Embedding);
    assert.equal(parseModelClass("medium"), null);
    assert.equal(parseModelClass(undefined), null);
  });

  it("resolves a bare chat band via the chat- prefix shorthand", () => {
    assert.equal(parseModelClass("thinking"), ModelClass.ChatThinking);
    assert.equal(parseModelClass("balanced"), ModelClass.ChatBalanced);
    assert.equal(parseModelClass("fast"), ModelClass.ChatFast);
  });
});
