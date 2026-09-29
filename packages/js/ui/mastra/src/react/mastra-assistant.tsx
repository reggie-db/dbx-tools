import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui-appkit/react";
import { BotIcon, MessageCircleIcon, XIcon } from "lucide-react";
import {
  createContext,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChatView } from "./chat-view.tsx";
import { useMastraChat, type UseMastraChatOptions } from "./mastra-chat.tsx";
import { ThreadActions } from "./thread-tabs.tsx";
import type { MastraRequestContextInput } from "../support/request-context.ts";

/** Outer assistant placement behavior. */
export type MastraAssistantMode = "dock" | "overlay";
/** Edge from which the assistant opens. */
export type MastraAssistantSide = "top" | "right" | "bottom" | "left";
/** Viewport corner used by the built-in launcher. */
export type MastraAssistantLauncherPosition =
  "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Optional panel resizing and persistence. Sizes are CSS pixels. */
export interface MastraAssistantResizeOptions {
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  keyboardStep?: number;
  storageKey?: string;
}

/** Built-in floating launcher configuration. */
export interface MastraAssistantLauncherOptions {
  position?: MastraAssistantLauncherPosition;
  icon?: ReactNode;
  label?: string;
  className?: string;
}

/** Controller exposed to descendants through {@link useMastraAssistant}. */
export interface MastraAssistantController<TValues extends Record<string, unknown>> {
  open: (requestContext?: MastraRequestContextInput<TValues>) => void;
  close: () => void;
  toggle: () => void;
  setRequestContext: (requestContext?: MastraRequestContextInput<TValues>) => void;
  isOpen: boolean;
  requestContext: MastraRequestContextInput<TValues> | undefined;
}

/** Props for the persistent Mastra assistant application shell. */
export interface MastraAssistantProps<TValues extends Record<string, unknown>> extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  children: ReactNode;
  chat?: Omit<UseMastraChatOptions<TValues>, "requestContext">;
  requestContext?: MastraRequestContextInput<TValues>;
  mode?: MastraAssistantMode;
  side?: MastraAssistantSide;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  available?: boolean;
  resizable?: boolean | MastraAssistantResizeOptions;
  mobileBreakpoint?: number;
  launcher?: false | MastraAssistantLauncherOptions;
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  header?: boolean;
  closeIcon?: ReactNode;
  newConversationIcon?: ReactNode;
  historyIcon?: ReactNode;
  contentClassName?: string;
  panelClassName?: string;
  headerClassName?: string;
  chatClassName?: string;
}

const AssistantContext = createContext<MastraAssistantController<Record<string, unknown>> | null>(
  null,
);

/** Access the nearest persistent assistant from any descendant button or page. */
export function useMastraAssistant<
  TValues extends Record<string, unknown> = Record<string, unknown>,
>(): MastraAssistantController<TValues> {
  const context = useContext(AssistantContext);
  if (!context) {
    throw new Error("useMastraAssistant must be used within MastraAssistant");
  }
  return context as MastraAssistantController<TValues>;
}

const launcherPositionClasses: Record<MastraAssistantLauncherPosition, string> = {
  "top-left": "left-6 top-6",
  "top-right": "right-6 top-6",
  "bottom-left": "bottom-6 left-6",
  "bottom-right": "bottom-6 right-6",
};

const sideIsVertical = (side: MastraAssistantSide): boolean => side === "top" || side === "bottom";

const clampPanelSize = (
  size: number,
  available: number,
  options: MastraAssistantResizeOptions,
  vertical: boolean,
): number => {
  const { minimum, maximum } = panelSizeBounds(available, options, vertical);
  return Math.min(maximum, Math.max(minimum, size));
};

const panelSizeBounds = (
  available: number,
  options: MastraAssistantResizeOptions,
  vertical: boolean,
): { minimum: number; maximum: number } => {
  const minimum = options.minSize ?? (vertical ? 240 : 320);
  const maximum = Math.min(options.maxSize ?? available * 0.7, Math.max(minimum, available - 48));
  return { minimum, maximum };
};

const readStoredSize = (key: string | undefined): number | undefined => {
  if (!key || typeof window === "undefined") return undefined;
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
};

const panelPositionClasses: Record<MastraAssistantSide, string> = {
  top: "inset-x-0 top-0 border-b",
  right: "inset-y-0 right-0 border-l",
  bottom: "inset-x-0 bottom-0 border-t",
  left: "inset-y-0 left-0 border-r",
};

const panelClosedClasses: Record<MastraAssistantSide, string> = {
  top: "-translate-y-full",
  right: "translate-x-full",
  bottom: "translate-y-full",
  left: "-translate-x-full",
};

const resizeHandleClasses: Record<MastraAssistantSide, string> = {
  top: "-bottom-1 inset-x-0 h-2 cursor-row-resize",
  right: "-left-1 inset-y-0 w-2 cursor-col-resize",
  bottom: "-top-1 inset-x-0 h-2 cursor-row-resize",
  left: "-right-1 inset-y-0 w-2 cursor-col-resize",
};

type ResizeState = {
  pointer: number;
  size: number;
} | null;

/**
 * Persistent chat shell. Keep this above the route outlet so page navigation
 * replaces application content without remounting the chat driver.
 */
export function MastraAssistant<TValues extends Record<string, unknown> = Record<string, unknown>>({
  children,
  chat = {},
  requestContext: requestContextProp,
  mode = "overlay",
  side = "right",
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  available = true,
  resizable = true,
  mobileBreakpoint = 640,
  launcher = {},
  title = "Assistant",
  description,
  icon,
  header = true,
  closeIcon,
  newConversationIcon,
  historyIcon,
  className,
  contentClassName,
  panelClassName,
  headerClassName,
  chatClassName,
  ...rootProps
}: MastraAssistantProps<TValues>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = available && (openProp ?? internalOpen);
  const [launchContext, setLaunchContext] = useState<
    MastraRequestContextInput<TValues> | undefined
  >();
  const requestContext = launchContext ?? requestContextProp;
  const resizeOptions = useMemo(() => (resizable === true ? {} : resizable || {}), [resizable]);
  const vertical = sideIsVertical(side);
  const defaultSize = resizeOptions.defaultSize ?? (vertical ? 360 : 432);
  const [panelSize, setPanelSize] = useState(
    () => readStoredSize(resizeOptions.storageKey) ?? defaultSize,
  );
  const [availableSize, setAvailableSize] = useState(0);
  const [isNarrow, setIsNarrow] = useState(false);
  const resizeState = useRef<ResizeState>(null);

  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );
  const open = useCallback(
    (nextContext?: MastraRequestContextInput<TValues>) => {
      if (nextContext !== undefined) setLaunchContext(nextContext);
      setOpen(true);
    },
    [setOpen],
  );
  const close = useCallback(() => setOpen(false), [setOpen]);
  const toggle = useCallback(() => setOpen(!isOpen), [isOpen, setOpen]);

  const controller = useMemo<MastraAssistantController<TValues>>(
    () => ({
      open,
      close,
      toggle,
      setRequestContext: setLaunchContext,
      isOpen,
      requestContext,
    }),
    [close, isOpen, open, requestContext, toggle],
  );

  const chatView = useMastraChat<TValues>({
    ...chat,
    threadPlacement: chat.threadPlacement ?? "top",
    requestContext,
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const bounds = entries[0]?.contentRect;
      const width = bounds?.width ?? root.clientWidth;
      const height = bounds?.height ?? root.clientHeight;
      if (width <= 0 || height <= 0) return;
      setAvailableSize(vertical ? height : width);
      setIsNarrow(width < mobileBreakpoint);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [mobileBreakpoint, vertical]);

  useEffect(() => {
    if (!resizeOptions.storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(resizeOptions.storageKey, String(panelSize));
    } catch {
      // Size persistence is best-effort; the panel remains usable without storage.
    }
  }, [panelSize, resizeOptions.storageKey]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const current = resizeState.current;
      if (!current || availableSize <= 0) return;
      const pointer = vertical ? event.clientY : event.clientX;
      const direction = side === "right" || side === "bottom" ? -1 : 1;
      setPanelSize(
        clampPanelSize(
          current.size + (pointer - current.pointer) * direction,
          availableSize,
          resizeOptions,
          vertical,
        ),
      );
    };
    const finish = () => {
      resizeState.current = null;
      document.body.style.removeProperty("user-select");
      document.body.style.removeProperty("cursor");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      finish();
    };
  }, [availableSize, resizeOptions, side, vertical]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!resizable || isNarrow) return;
    event.preventDefault();
    event.currentTarget.focus();
    resizeState.current = {
      pointer: vertical ? event.clientY : event.clientX,
      size: panelSize,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = vertical ? "row-resize" : "col-resize";
  };

  const resizeByKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!resizable || isNarrow || availableSize <= 0) return;
    const step = resizeOptions.keyboardStep ?? 24;
    const decrease =
      (side === "right" && event.key === "ArrowRight") ||
      (side === "left" && event.key === "ArrowLeft") ||
      (side === "top" && event.key === "ArrowUp") ||
      (side === "bottom" && event.key === "ArrowDown");
    const increase =
      (side === "right" && event.key === "ArrowLeft") ||
      (side === "left" && event.key === "ArrowRight") ||
      (side === "top" && event.key === "ArrowDown") ||
      (side === "bottom" && event.key === "ArrowUp");
    if (!decrease && !increase) return;
    event.preventDefault();
    setPanelSize((current) =>
      clampPanelSize(current + (increase ? step : -step), availableSize, resizeOptions, vertical),
    );
  };

  const effectiveMode: MastraAssistantMode = isNarrow ? "overlay" : mode;
  const effectiveSize =
    availableSize > 0
      ? clampPanelSize(panelSize, availableSize, resizeOptions, vertical)
      : panelSize;
  const sizeBounds =
    availableSize > 0
      ? panelSizeBounds(availableSize, resizeOptions, vertical)
      : {
          minimum: resizeOptions.minSize ?? (vertical ? 240 : 320),
          maximum: resizeOptions.maxSize ?? panelSize,
        };
  const panelStyle: CSSProperties = isNarrow
    ? {}
    : vertical
      ? { height: effectiveSize }
      : { width: effectiveSize };

  const resizeHandle =
    resizable && !isNarrow ? (
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize assistant"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuemin={Math.round(sizeBounds.minimum)}
        aria-valuemax={Math.round(sizeBounds.maximum)}
        aria-valuenow={Math.round(effectiveSize)}
        onPointerDown={beginResize}
        onKeyDown={resizeByKeyboard}
        className={cn(
          "absolute z-20 touch-none outline-none",
          "after:absolute after:bg-transparent after:transition-colors hover:after:bg-primary/30 focus-visible:after:bg-primary/40",
          vertical
            ? "after:inset-x-0 after:top-1/2 after:h-px"
            : "after:inset-y-0 after:left-1/2 after:w-px",
          resizeHandleClasses[side],
        )}
      />
    ) : null;

  const closeAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7" onClick={close}>
          {closeIcon ?? <XIcon className="size-4" />}
          <span className="sr-only">Close assistant</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Close assistant</TooltipContent>
    </Tooltip>
  );

  const headerActions =
    chatView.threads && chatView.onSelectThread ? (
      <ThreadActions
        threads={chatView.threads}
        activeThreadId={chatView.activeThreadId}
        streamingThreadIds={chatView.streamingThreadIds}
        isLoading={chatView.isLoadingThreads}
        onSelect={chatView.onSelectThread}
        onNew={chatView.onNewThread}
        onDelete={chatView.onDeleteThread}
        onRename={chatView.onRenameThread}
        onCancel={chatView.onCancelThread}
        newIcon={newConversationIcon}
        historyIcon={historyIcon}
        actions={closeAction}
      />
    ) : (
      closeAction
    );

  const panel = (
    <aside
      aria-label={typeof title === "string" ? title : "Assistant"}
      aria-hidden={!isOpen}
      inert={!isOpen ? true : undefined}
      style={panelStyle}
      className={cn(
        "relative z-40 flex min-h-0 min-w-0 flex-col bg-background text-foreground shadow-xl",
        "transition-[transform,visibility] duration-200 ease-out",
        (effectiveMode === "overlay" || !isOpen) && "fixed",
        (effectiveMode === "overlay" || !isOpen) && !isNarrow && panelPositionClasses[side],
        isNarrow && "fixed inset-0",
        effectiveMode === "dock" && vertical && "w-full",
        effectiveMode === "dock" && !vertical && "h-full",
        !isOpen && panelClosedClasses[side],
        !isOpen && "invisible pointer-events-none",
        panelClassName,
      )}
    >
      <TooltipProvider delayDuration={200}>
        {resizeHandle}
        {header ? (
          <div
            className={cn(
              "flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-4 py-2",
              headerClassName,
            )}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
              {icon ?? <BotIcon className="size-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{title}</div>
              {description ? (
                <div className="truncate text-xs text-muted-foreground">{description}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">{headerActions}</div>
          </div>
        ) : null}
        <ChatView
          {...chatView}
          showThreadBarActions={!header}
          threadBarActions={!header ? closeAction : undefined}
          threadNewIcon={newConversationIcon}
          threadHistoryIcon={historyIcon}
          className={cn("min-h-0 flex-1", chatClassName)}
        />
        {!header && chatView.threadPlacement !== "top" ? (
          <div className="absolute right-3 top-3 z-30">{closeAction}</div>
        ) : null}
      </TooltipProvider>
    </aside>
  );

  const launcherOptions = launcher === false ? null : launcher;
  const launchButton =
    available && !isOpen && launcherOptions ? (
      <Button
        type="button"
        size="icon"
        aria-label={launcherOptions.label ?? "Open assistant"}
        title={launcherOptions.label ?? "Open assistant"}
        onClick={() => open()}
        className={cn(
          "fixed z-30 size-14 rounded-full shadow-lg",
          launcherPositionClasses[launcherOptions.position ?? "bottom-right"],
          launcherOptions.className,
        )}
      >
        {launcherOptions.icon ?? <MessageCircleIcon className="size-6" />}
      </Button>
    ) : null;

  const content = <div className={cn("min-h-0 min-w-0 flex-1", contentClassName)}>{children}</div>;
  const docked = effectiveMode === "dock" && isOpen;
  const rootDirection = vertical ? "flex-col" : "flex-row";
  const panelFirst = side === "top" || side === "left";

  return (
    <AssistantContext.Provider
      value={controller as MastraAssistantController<Record<string, unknown>>}
    >
      <div
        ref={rootRef}
        className={cn(
          "relative h-full min-h-0 w-full min-w-0",
          docked && "flex",
          rootDirection,
          className,
        )}
        {...rootProps}
      >
        {panelFirst ? panel : null}
        {content}
        {!panelFirst ? panel : null}
        {launchButton}
      </div>
    </AssistantContext.Provider>
  );
}
