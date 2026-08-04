import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { HistoryIcon, Loader2Icon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ThreadSidebar, type ThreadSidebarProps } from "./thread-sidebar.tsx";
import { threadTitle } from "../support/thread-labels.ts";

// Editor-style conversation tabs: the open conversations across the top of the
// chat, plus a "new chat" button and a history menu holding every other
// conversation. Used by the `top` thread placement, where a side panel would
// eat too much of a narrow chat.
//
// The history menu reuses `ThreadSidebar` verbatim inside a popover rather than
// reimplementing a list, so rename / delete / cancel / streaming behave exactly
// as they do in the docked placements.

/** Props for {@link ThreadTabs}. */
export interface ThreadTabsProps extends Omit<ThreadSidebarProps, "onHide" | "side"> {
  /**
   * Ids of the conversations open as tabs, left to right. Ids without a
   * matching {@link ThreadSidebarProps.threads} entry still render (a
   * brand-new conversation isn't in the server list yet).
   */
  openThreadIds: string[];
  /**
   * Take a conversation off the strip. The conversation itself is kept - use
   * {@link ThreadSidebarProps.onDelete} to remove it. Per-tab close
   * affordance hidden when omitted.
   */
  onCloseTab?: (threadId: string) => void;
}

/**
 * Tab strip for the `top` thread placement. Each open conversation is a tab
 * showing its title, a spinner while it streams in the background, and a close
 * affordance; a trailing `+` starts a fresh conversation and a history button
 * opens the full conversation list (a {@link ThreadSidebar} in a popover) so
 * anything not currently tabbed is one click away. The active tab is scrolled
 * into view when the selection changes, so switching from history never leaves
 * the current conversation off-screen.
 */
export const ThreadTabs = ({ openThreadIds, onCloseTab, className, ...list }: ThreadTabsProps) => {
  const { threads, activeThreadId, streamingThreadIds = [], onSelect, onNew } = list;
  // Controlled so picking a conversation (or starting one) dismisses the menu
  // instead of leaving it open over the transcript.
  const [historyOpen, setHistoryOpen] = useState(false);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId]);

  return (
    // The divider spans the whole chat width while the strip's contents stay
    // in the same centered column as the transcript and composer.
    <div className={cn("w-full border-b border-border text-xs", className)}>
      <div className="mx-auto flex w-full max-w-4xl items-center gap-1 px-2 py-1 md:px-4">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {openThreadIds.map((id) => {
            const thread = threads.find((t) => t.id === id) ?? { id };
            const isActive = id === activeThreadId;
            const isStreaming = streamingThreadIds.includes(id);
            const title = threadTitle(thread);
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <div
                    ref={isActive ? activeTabRef : undefined}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    onClick={() => onSelect(id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onSelect(id);
                      }
                    }}
                    className={cn(
                      "group flex max-w-[12rem] shrink-0 cursor-pointer items-center gap-1.5",
                      "rounded-md border border-transparent px-2 py-1",
                      "hover:bg-accent hover:text-accent-foreground",
                      isActive && "border-border bg-accent text-accent-foreground",
                    )}
                  >
                    {isStreaming && (
                      <Loader2Icon
                        aria-label="Streaming"
                        className="size-3 shrink-0 animate-spin text-primary"
                      />
                    )}
                    <span className="truncate">{title}</span>
                    {onCloseTab && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloseTab(id);
                        }}
                        aria-label="Close tab"
                        className={cn(
                          "size-4 shrink-0",
                          // The active tab always shows its close button; the
                          // rest reveal one on hover / keyboard focus so the
                          // strip stays quiet.
                          !isActive &&
                            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                        )}
                      >
                        <XIcon className="size-3" />
                      </Button>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>{title}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        {onNew && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onNew}
                aria-label="New chat"
                className="size-7 shrink-0"
              >
                <PlusIcon className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
        )}
        <Popover open={historyOpen} onOpenChange={setHistoryOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Conversation history"
                  className="size-7 shrink-0"
                >
                  <HistoryIcon className="size-4" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>Conversation history</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-72 p-0">
            {/*
             * The same list the docked placements render, just framed as a menu:
             * selecting (or starting) a conversation opens it as a tab and
             * dismisses the popover, while rename / delete / cancel work in
             * place.
             */}
            <ThreadSidebar
              {...list}
              onSelect={(id) => {
                onSelect(id);
                setHistoryOpen(false);
              }}
              {...(onNew
                ? {
                    onNew: () => {
                      onNew();
                      setHistoryOpen(false);
                    },
                  }
                : {})}
              className="h-96 w-full border-none"
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};
