import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { PanelLeftIcon, PanelRightIcon } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { ThreadSidebar, type ThreadSidebarProps } from "./thread-sidebar.tsx";
import { ThreadTabs } from "./thread-tabs.tsx";
import type { ChatViewProps } from "./types.ts";
import { closeThreadTab, nextActiveThreadTab, syncThreadTabs } from "../support/thread-tabs.ts";

const SIDE_PANEL_MIN_WIDTH_PX = 768;

const useIsNarrow = (ref: React.RefObject<HTMLElement | null>): boolean => {
  const [isNarrow, setIsNarrow] = useState(() =>
    typeof window === "undefined" ? false : window.innerWidth < SIDE_PANEL_MIN_WIDTH_PX,
  );
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth;
      if (width > 0) setIsNarrow(width < SIDE_PANEL_MIN_WIDTH_PX);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return isNarrow;
};

type ChatThreadLayoutProps = {
  children: React.ReactNode;
  className: ChatViewProps["className"];
  threads: ChatViewProps["threads"];
  threadPlacement: NonNullable<ChatViewProps["threadPlacement"]>;
  activeThreadId: ChatViewProps["activeThreadId"];
  streamingThreadIds: NonNullable<ChatViewProps["streamingThreadIds"]>;
  isLoadingThreads: NonNullable<ChatViewProps["isLoadingThreads"]>;
  onSelectThread: ChatViewProps["onSelectThread"];
  onNewThread: ChatViewProps["onNewThread"];
  onDeleteThread: ChatViewProps["onDeleteThread"];
  onRenameThread: ChatViewProps["onRenameThread"];
  onCancelThread: ChatViewProps["onCancelThread"];
  sidebarOpen: ChatViewProps["sidebarOpen"];
  onToggleSidebar: ChatViewProps["onToggleSidebar"];
};

type ThreadDrawerProps = {
  list: Omit<ThreadSidebarProps, "onHide" | "side" | "className">;
  side: "left" | "right";
  onClose: () => void;
  onSelectThread: NonNullable<ChatViewProps["onSelectThread"]>;
  onNewThread: ChatViewProps["onNewThread"];
};

const ThreadDrawer = ({ list, side, onClose, onSelectThread, onNewThread }: ThreadDrawerProps) => (
  <div className={cn("fixed inset-0 z-40 flex", side === "right" && "justify-end")}>
    <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
    <ThreadSidebar
      {...list}
      onHide={onClose}
      side={side}
      onSelect={(id) => {
        onSelectThread(id);
        onClose();
      }}
      {...(onNewThread
        ? {
            onNew: () => {
              onNewThread();
              onClose();
            },
          }
        : {})}
      className="relative z-10 w-[85vw] max-w-xs shadow-xl"
    />
  </div>
);

/** Internal responsive shell that owns conversation navigation surfaces. */
export const ChatThreadLayout = ({
  children,
  className,
  threads,
  threadPlacement,
  activeThreadId,
  streamingThreadIds,
  isLoadingThreads,
  onSelectThread,
  onNewThread,
  onDeleteThread,
  onRenameThread,
  onCancelThread,
  sidebarOpen: sidebarOpenProp,
  onToggleSidebar,
}: ChatThreadLayoutProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const isNarrow = useIsNarrow(rootRef);
  const showThreads = Boolean(threads && onSelectThread) && threadPlacement !== "disabled";
  const placement = threadPlacement === "auto" ? (isNarrow ? "top" : "left") : threadPlacement;
  const tabbedThreads = showThreads && placement === "top";
  const dockedSide = placement === "right" ? "right" : "left";
  const dockedThreads = showThreads && (placement === "left" || placement === "right");

  const [internalSidebarOpen, setInternalSidebarOpen] = useState(true);
  const inlineSidebarOpen = sidebarOpenProp ?? internalSidebarOpen;
  const toggleInlineSidebar = () => {
    if (onToggleSidebar) onToggleSidebar();
    else setInternalSidebarOpen((open) => !open);
  };

  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (!isNarrow) setDrawerOpen(false);
  }, [isNarrow]);

  const sidebarOpen = isNarrow ? drawerOpen : inlineSidebarOpen;
  const toggleSidebar = () => {
    if (isNarrow) setDrawerOpen((open) => !open);
    else toggleInlineSidebar();
  };
  const showSidebarToggle = dockedThreads && (isNarrow || !inlineSidebarOpen);
  const SidebarToggleIcon = dockedSide === "right" ? PanelRightIcon : PanelLeftIcon;

  const threadListProps: Omit<ThreadSidebarProps, "onHide" | "side" | "className"> = {
    threads: threads ?? [],
    ...(activeThreadId ? { activeThreadId } : {}),
    streamingThreadIds,
    isLoading: isLoadingThreads,
    onSelect: (id) => onSelectThread?.(id),
    ...(onNewThread ? { onNew: onNewThread } : {}),
    ...(onDeleteThread ? { onDelete: onDeleteThread } : {}),
    ...(onRenameThread ? { onRename: onRenameThread } : {}),
    ...(onCancelThread ? { onCancel: onCancelThread } : {}),
  };

  const [openTabIds, setOpenTabIds] = useState<string[]>([]);
  useEffect(() => {
    if (!tabbedThreads) return;
    setOpenTabIds((previous) => syncThreadTabs(previous, threads ?? [], activeThreadId));
  }, [tabbedThreads, threads, activeThreadId]);

  const closeTab = (threadId: string) => {
    const fallback = nextActiveThreadTab(openTabIds, threadId);
    setOpenTabIds((previous) => closeThreadTab(previous, threadId));
    if (threadId !== activeThreadId) return;
    if (fallback) onSelectThread?.(fallback);
    else onNewThread?.();
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div
        ref={rootRef}
        className={cn(
          "flex h-full min-h-0",
          dockedThreads && dockedSide === "right" && "flex-row-reverse",
          className,
        )}
      >
        {dockedThreads &&
          (isNarrow
            ? drawerOpen &&
              onSelectThread && (
                <ThreadDrawer
                  list={threadListProps}
                  side={dockedSide}
                  onClose={toggleSidebar}
                  onSelectThread={onSelectThread}
                  onNewThread={onNewThread}
                />
              )
            : inlineSidebarOpen && (
                <ThreadSidebar {...threadListProps} onHide={toggleSidebar} side={dockedSide} />
              ))}
        <div className="flex h-full min-w-0 flex-1 flex-col">
          {tabbedThreads && (
            <ThreadTabs {...threadListProps} openThreadIds={openTabIds} onCloseTab={closeTab} />
          )}
          {showSidebarToggle && (
            <div
              className={cn(
                "mx-auto flex w-full max-w-4xl items-center gap-2 px-3 pb-2 pt-1 text-xs text-muted-foreground md:gap-3 md:px-6",
                dockedSide === "right" && "justify-end",
              )}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={toggleSidebar}
                    aria-label={sidebarOpen ? "Hide conversations" : "Show conversations"}
                  >
                    <SidebarToggleIcon className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {sidebarOpen ? "Hide conversations" : "Show conversations"}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
          {children}
        </div>
      </div>
    </TooltipProvider>
  );
};
