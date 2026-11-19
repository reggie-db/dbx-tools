import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { centeredThreadTabScrollLeft } from "../src/react/_thread-tab-scroll.ts";
import { ChatThreadLayout } from "../src/react/chat-thread-layout.tsx";

describe("chat thread layout", () => {
  it("allows the frame to shrink inside narrow host panes", () => {
    const html = renderToStaticMarkup(
      createElement(ChatThreadLayout, {
        children: createElement("div", null, "Transcript"),
        className: "flex-1",
        threads: undefined,
        threadPlacement: "disabled",
        threadBarActions: undefined,
        threadHistoryLeadingActions: undefined,
        threadSidebarHeaderActions: undefined,
        showThreadBarActions: true,
        threadNewIcon: undefined,
        threadHistoryIcon: undefined,
        activeThreadId: undefined,
        streamingThreadIds: [],
        isLoadingThreads: false,
        onSelectThread: undefined,
        onNewThread: undefined,
        onDeleteThread: undefined,
        onRenameThread: undefined,
        onCancelThread: undefined,
        sidebarOpen: undefined,
        onToggleSidebar: undefined,
      }),
    );

    assert.match(html, /data-slot="aui_thread-frame"[^>]*class="[^"]*min-w-0/);
  });

  it("centers a selected conversation within the available tab viewport", () => {
    assert.equal(
      centeredThreadTabScrollLeft({
        currentScrollLeft: 120,
        viewportWidth: 400,
        scrollWidth: 1000,
        tabLeft: 280,
        tabWidth: 160,
      }),
      280,
    );
  });

  it("clamps centered conversation tabs at both strip edges", () => {
    assert.equal(
      centeredThreadTabScrollLeft({
        currentScrollLeft: 0,
        viewportWidth: 400,
        scrollWidth: 1000,
        tabLeft: 20,
        tabWidth: 160,
      }),
      0,
    );
    assert.equal(
      centeredThreadTabScrollLeft({
        currentScrollLeft: 580,
        viewportWidth: 400,
        scrollWidth: 1000,
        tabLeft: 300,
        tabWidth: 160,
      }),
      600,
    );
  });
});
