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
import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { autosizeComposerTextarea, observeComposerWidth } from "./_composer-autosize.ts";
import { ModelSelector } from "./_model-selector.tsx";
import { ExportMenu } from "./export-menu.tsx";
import { SuggestionPills } from "./suggestion-pills.tsx";
import type { ChatViewProps } from "./types.ts";

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
  defaultModelId: ChatViewProps["defaultModelId"];
  defaultModelLoading: ChatViewProps["defaultModelLoading"];
  reasoningEffort: ChatViewProps["reasoningEffort"];
  onReasoningEffortChange: ChatViewProps["onReasoningEffortChange"];
  composerActions: ChatViewProps["composerActions"];
  modelSelectorActions: ChatViewProps["modelSelectorActions"];
  composerLeadingActions: ChatViewProps["composerLeadingActions"];
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
  defaultModelId,
  defaultModelLoading,
  reasoningEffort,
  onReasoningEffortChange,
  composerActions,
  modelSelectorActions,
  composerLeadingActions,
  isLoadingHistory,
  onClear,
  onExportConversation,
  onResumeFollow,
}: ChatComposerProps) => {
  const [input, setInput] = useState("");
  const inputId = useId();
  const inputGroupRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resizeTextarea = useCallback(() => {
    autosizeComposerTextarea(inputGroupRef.current, textareaRef.current);
  }, []);

  useLayoutEffect(() => {
    resizeTextarea();
  }, [input, isLoadingHistory, resizeTextarea]);

  useLayoutEffect(() => {
    const group = inputGroupRef.current;
    if (!group) return;
    return observeComposerWidth(group, resizeTextarea);
  }, [resizeTextarea]);

  const isRunning = status === "submitted" || status === "streaming";
  const submit = () => {
    const text = input.trim();
    if (!text || isLoadingHistory) return;
    sendMessage({ text });
    setInput("");
    onResumeFollow();
  };

  const modelChangeable = Boolean(models && models.length > 0);
  return (
    <>
      {isEmpty && !isLoadingHistory && (
        <SuggestionPills
          questions={suggestions}
          onSelect={(text) => sendMessage({ text })}
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
        <InputGroup
          ref={inputGroupRef}
          className="rounded-2xl border-border/80 shadow-sm transition-shadow focus-within:shadow-md"
        >
          <InputGroupTextarea
            id={`${inputId}-message`}
            name="message"
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            placeholder="Send a message..."
            rows={1}
            className="field-sizing-fixed min-h-10 max-h-64 w-full flex-none overflow-y-auto px-4 pb-2 pt-4 text-xs"
          />
          <InputGroupAddon
            align="block-end"
            className="flex w-full flex-row flex-wrap items-center justify-between gap-2 px-3 pb-3 pt-1"
          >
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
              {composerLeadingActions}
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
            <div className="ml-auto flex min-w-0 max-w-full items-center gap-1.5">
              {composerActions}
              {onModelChange &&
                (modelChangeable ? (
                  <ModelSelector
                    models={models ?? []}
                    model={model}
                    defaultModelName={defaultModelName}
                    defaultModelId={defaultModelId}
                    defaultModelLoading={defaultModelLoading}
                    reasoningEffort={reasoningEffort}
                    onReasoningEffortChange={onReasoningEffortChange}
                    onModelChange={onModelChange}
                    actions={modelSelectorActions}
                  />
                ) : (
                  <span className="flex max-w-[180px] items-center gap-1.5 truncate px-2 text-xs text-muted-foreground">
                    {defaultModelLoading ? (
                      <>
                        <Spinner className="size-3 shrink-0" />
                        <span className="sr-only">Loading default model</span>
                      </>
                    ) : (
                      defaultModelName || "Default"
                    )}
                  </span>
                ))}
              {isRunning && onStop && !input.trim() ? (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="default"
                  onClick={() => onStop()}
                  aria-label="Stop response"
                  className="shrink-0 rounded-full"
                >
                  <SquareIcon className="size-3 fill-current" />
                </InputGroupButton>
              ) : (
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  disabled={!input.trim() || isLoadingHistory}
                  aria-label={isRunning ? "Queue message" : "Send message"}
                  className="shrink-0 rounded-full"
                >
                  <SendIcon className="size-3" />
                </InputGroupButton>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
      </form>
    </>
  );
};
