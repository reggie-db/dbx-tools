import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { UserBubble } from "../src/react/bubbles.tsx";
import { SuggestionPills } from "../src/react/suggestion-pills.tsx";

describe("chat prompt typography", () => {
  it("keeps suggestions and their selected user messages at the same text size", () => {
    const question = "Which transformations are easiest to migrate?";
    const suggestionHtml = renderToStaticMarkup(
      createElement(SuggestionPills, {
        questions: [question],
        onSelect: () => undefined,
      }),
    );
    const message: UIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: question }],
    };
    const messageHtml = renderToStaticMarkup(createElement(UserBubble, { message }));

    for (const html of [suggestionHtml, messageHtml]) {
      assert.match(html, /text-sm/);
      assert.match(html, /leading-snug/);
      assert.match(html, /sm:leading-normal/);
    }
    assert.doesNotMatch(suggestionHtml, /text-xs/);
  });
});
