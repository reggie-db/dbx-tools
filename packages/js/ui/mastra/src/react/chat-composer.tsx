import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@dbx-tools/ui-appkit/react";
import {
  GripVerticalIcon,
  SendHorizontalIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ExportMenu } from "./export-menu.tsx";
import { SuggestionPills } from "./suggestion-pills.tsx";
import type { ChatViewProps } from "./types.ts";

const DEFAULT_MODEL_VALUE = "__default__";

type QueuedSteerListProps = {
  queuedSteers: NonNullable<ChatViewProps["queuedSteers"]>;
  onSendSteerNow: ChatViewProps["onSendSteerNow"];
  onRemoveSteer: ChatViewProps["onRemoveSteer"];
  onReorderSteers: ChatViewProps["onReorderSteers"];
};

const QueuedSteerList = ({
  queuedSteers,
  onSendSteerNow,
  onRemoveSteer,
  onReorderSteers,
}: QueuedSteerListProps) => {
  const [draggingSteerId, setDraggingSteerId] = useState<string | null>(null);
  const steerChipRefs = useRef(new Map<string, HTMLDivElement>());
  const draggingIdRef = useRef<string | null>(null);
  const queuedSteersRef = useRef(queuedSteers);
  queuedSteersRef.current = queuedSteers;

  const reorderSteersByPointer = useCallback(
    (draggingId: string, pointerY: number) => {
      if (!onReorderSteers) return;
      const order = queuedSteersRef.current.map((steer) => steer.id);
      const rest = order.filter((id) => id !== draggingId);
      let insertAt = rest.length;
      for (let index = 0; index < rest.length; index += 1) {
        const chip = steerChipRefs.current.get(rest[index]);
        if (!chip) continue;
        const bounds = chip.getBoundingClientRect();
        if (pointerY < bounds.top + bounds.height / 2) {
          insertAt = index;
          break;
        }
      }
      const next = [...rest];
      next.splice(insertAt, 0, draggingId);
      if (next.length === order.length && next.every((id, index) => id === order[index])) return;
      onReorderSteers(next);
    },
    [onReorderSteers],
  );

  if (queuedSteers.length === 0) return null;

  return (
    <div className="mb-2 flex flex-col gap-1">
      {queuedSteers.map((steer) => {
        const reorderable = Boolean(onReorderSteers);
        return (
          <div
            key={steer.id}
            ref={(element) => {
              if (element) steerChipRefs.current.set(steer.id, element);
              else steerChipRefs.current.delete(steer.id);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border border-border/70 bg-muted/40 px-2 py-1 text-xs",
              draggingSteerId === steer.id && "opacity-50",
            )}
          >
            {reorderable && (
              <span
                role="button"
                tabIndex={-1}
                aria-label="Drag to reorder"
                className="-m-1 shrink-0 cursor-grab touch-none p-1 text-muted-foreground active:cursor-grabbing"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  draggingIdRef.current = steer.id;
                  setDraggingSteerId(steer.id);
                }}
                onPointerMove={(event) => {
                  if (draggingIdRef.current !== steer.id) return;
                  reorderSteersByPointer(steer.id, event.clientY);
                }}
                onPointerUp={(event) => {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  draggingIdRef.current = null;
                  setDraggingSteerId(null);
                }}
                onPointerCancel={() => {
                  draggingIdRef.current = null;
                  setDraggingSteerId(null);
                }}
              >
                <GripVerticalIcon className="size-3" aria-hidden="true" />
              </span>
            )}
            <span className="text-muted-foreground">Queued</span>
            <span className="min-w-0 flex-1 truncate">{steer.text}</span>
            {onSendSteerNow && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    onClick={() => onSendSteerNow(steer.id)}
                    aria-label="Send now (interrupts current turn)"
                  >
                    <SendHorizontalIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send now - interrupts</TooltipContent>
              </Tooltip>
            )}
            {onRemoveSteer && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    onClick={() => onRemoveSteer(steer.id)}
                    aria-label="Remove queued message"
                  >
                    <XIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove</TooltipContent>
              </Tooltip>
            )}
          </div>
        );
      })}
    </div>
  );
};

type ClearConversationActionProps = {
  onClear: NonNullable<ChatViewProps["onClear"]>;
  isLoadingHistory: NonNullable<ChatViewProps["isLoadingHistory"]>;
};

const ClearConversationAction = ({ onClear, isLoadingHistory }: ClearConversationActionProps) => {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleConfirm = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      await onClear();
      setOpen(false);
    } finally {
      setClearing(false);
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(true)}
            disabled={isLoadingHistory}
            className="h-7 gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3"
          >
            <Trash2Icon className="size-3" />
            Clear
          </Button>
        </TooltipTrigger>
        <TooltipContent>Clear chat history for this thread</TooltipContent>
      </Tooltip>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the chat history for this thread. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={clearing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleConfirm();
              }}
              disabled={clearing}
            >
              {clearing ? <Spinner className="size-3" /> : null}
              {clearing ? "Clearing..." : "Clear"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

type ChatComposerProps = {
  isEmpty: boolean;
  status: ChatViewProps["status"];
  sendMessage: ChatViewProps["sendMessage"];
  queuedSteers: NonNullable<ChatViewProps["queuedSteers"]>;
  onSendSteerNow: ChatViewProps["onSendSteerNow"];
  onRemoveSteer: ChatViewProps["onRemoveSteer"];
  onReorderSteers: ChatViewProps["onReorderSteers"];
  onStop: ChatViewProps["onStop"];
  suggestions: NonNullable<ChatViewProps["suggestions"]>;
  models: ChatViewProps["models"];
  model: ChatViewProps["model"];
  onModelChange: ChatViewProps["onModelChange"];
  defaultModelName: ChatViewProps["defaultModelName"];
  isLoadingHistory: NonNullable<ChatViewProps["isLoadingHistory"]>;
  onClear: ChatViewProps["onClear"];
  onExportConversation: ChatViewProps["onExportConversation"];
  onResumeFollow: () => void;
};

/** Internal message composer with queued steers and conversation actions. */
export const ChatComposer = ({
  isEmpty,
  status,
  sendMessage,
  queuedSteers,
  onSendSteerNow,
  onRemoveSteer,
  onReorderSteers,
  onStop,
  suggestions,
  models,
  model,
  onModelChange,
  defaultModelName,
  isLoadingHistory,
  onClear,
  onExportConversation,
  onResumeFollow,
}: ChatComposerProps) => {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [input]);

  const isRunning = status === "submitted" || status === "streaming";
  const submit = () => {
    const text = input.trim();
    if (!text || isLoadingHistory) return;
    sendMessage({ text });
    setInput("");
    onResumeFollow();
  };

  const showModelDisplay = Boolean(onModelChange);
  const modelChangeable = Boolean(models && models.length > 0);
  const defaultOptionLabel = defaultModelName || "Default";
  const currentModelLabel =
    (model ? models?.find((option) => option.name === model)?.displayName : undefined) ||
    defaultOptionLabel;
  const sortedModels = [...(models ?? [])].sort((left, right) =>
    (left.displayName || left.name).localeCompare(right.displayName || right.name, undefined, {
      sensitivity: "base",
    }),
  );
  const showToolbar = showModelDisplay || Boolean(onExportConversation) || Boolean(onClear);

  return (
    <>
      {isEmpty && (
        <SuggestionPills
          questions={suggestions}
          onSelect={(text) => sendMessage({ text })}
          disabled={isLoadingHistory}
          className="mx-auto w-full max-w-4xl px-4 pb-2 md:px-6"
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="mx-auto w-full max-w-4xl px-3 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-6"
      >
        <QueuedSteerList
          queuedSteers={queuedSteers}
          onSendSteerNow={onSendSteerNow}
          onRemoveSteer={onRemoveSteer}
          onReorderSteers={onReorderSteers}
        />
        <InputGroup className="rounded-2xl border-border/80 shadow-sm transition-shadow focus-within:shadow-md">
          <InputGroupTextarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder={isLoadingHistory ? "Loading history..." : "Send a message..."}
            rows={1}
            disabled={isLoadingHistory}
            className="max-h-48 text-base md:text-sm"
          />
          <InputGroupAddon align="inline-end">
            {isRunning && onStop && !input.trim() ? (
              <InputGroupButton
                type="button"
                size="icon-sm"
                variant="default"
                onClick={() => onStop()}
                aria-label="Stop response"
              >
                <SquareIcon className="size-3 fill-current" />
              </InputGroupButton>
            ) : (
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                disabled={!input.trim() || isLoadingHistory}
                aria-label={isRunning ? "Send now (interrupts)" : "Send message"}
              >
                <SendIcon className="size-3" />
              </InputGroupButton>
            )}
          </InputGroupAddon>
        </InputGroup>
        {showToolbar && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            {showModelDisplay &&
              (modelChangeable ? (
                <Select
                  value={model ? model : DEFAULT_MODEL_VALUE}
                  onValueChange={(value) =>
                    onModelChange?.(value === DEFAULT_MODEL_VALUE ? "" : value)
                  }
                  disabled={isLoadingHistory}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-7 w-auto max-w-[200px] gap-1 rounded-full px-2.5 text-xs [&_svg]:size-3"
                  >
                    <SelectValue placeholder={defaultOptionLabel} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL_VALUE}>{defaultOptionLabel}</SelectItem>
                    {sortedModels.map((option) => (
                      <SelectItem key={option.name} value={option.name}>
                        {option.displayName || option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <span className="max-w-[200px] truncate px-2.5 text-xs text-muted-foreground">
                  {currentModelLabel}
                </span>
              ))}
            {onExportConversation && (
              <ExportMenu
                onExport={(format) => void onExportConversation(format)}
                tooltip="Export conversation"
                disabled={isLoadingHistory}
              />
            )}
            {onClear && (
              <ClearConversationAction onClear={onClear} isLoadingHistory={isLoadingHistory} />
            )}
          </div>
        )}
      </form>
    </>
  );
};
