import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EmailPreview } from "../src/email/react/email-approval-card.tsx";

describe("EmailPreview", () => {
  it("renders the configured brand image in the sender chrome and message card", () => {
    const logoUrl = "https://example.com/icon.png";
    const html = renderToStaticMarkup(
      createElement(EmailPreview, {
        email: {
          to: ["builder@example.com"],
          subject: "Workspace update",
          body: "All systems are healthy.",
        },
        brand: {
          accent: "#1B3139",
          fontFamily: "sans-serif",
          name: "dbx tools",
          logoUrl,
        },
      }),
    );

    assert.equal(html.match(new RegExp(`src="${logoUrl}"`, "g"))?.length, 2);
    assert.match(html, /alt="dbx tools icon"/);
    assert.match(html, /<td[^>]*style="[^"]*padding:22px 30px/);
    assert.match(html, /<td[^>]*style="[^"]*padding:34px 34px 24px/);
  });
});
