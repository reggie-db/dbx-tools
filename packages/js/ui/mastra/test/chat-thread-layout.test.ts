import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

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

    assert.match(
      html,
      /data-slot="aui_thread-frame"[^>]*class="[^"]*min-w-0/,
    );
  });
});
