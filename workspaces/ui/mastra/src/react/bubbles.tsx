import {
  Avatar,
  AvatarFallback,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Item,
  ItemContent,
  ItemMedia,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@dbx-tools/ui-appkit/react";
import type { UIMessage } from "ai";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MessageSquareIcon,
  RefreshCcwIcon,
  SparklesIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import { MarkdownWithEmbeds } from "./embed-slots";
import { ToolMarkdown } from "./markdown";
import { ExportMenu } from "./export-menu";
import { FeedbackControls } from "./feedback-controls";
import { SuggestionPills } from "./suggestion-pills";
import { collectSuggestions } from "./suggestions";
import { ToolSessionPill, humanizeToolName } from "./tool-pill";
import type {
  ApprovalDecision,
  ChatStatus,
  ExportFormat,
  FeedbackSubmission,
  FeedbackValue,
  PendingApproval,
  ToolEvent,
} from "./types";

// User / assistant message bubbles plus the inline approval card and
// the helpers that surface approval-gated tool calls out of a message's
// parts.

/**
 * Copy `text` to the clipboard, resolving `true` on success. Prefers the
 * async Clipboard API, but that is only available in a secure context
 * (HTTPS / localhost) - over plain HTTP (e.g. a LAN / ZeroTier IP) it is
 * `undefined`, which is why a tap on mobile could silently do nothing. Falls
 * back to a hidden `<textarea>` + `document.execCommand("copy")` so copy works
 * off a non-secure origin too.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the execCommand path.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

const getReasoningText = (parts: UIMessage["parts"]): string =>
  parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("\n\n");

const RoleAvatar = ({ role }: { role: UIMessage["role"] }) => (
  <Avatar className="size-7">
    <AvatarFallback>
      {role === "assistant" ? (
        <SparklesIcon className="size-4" />
      ) : (
        <UserIcon className="size-4" />
      )}
    </AvatarFallback>
  </Avatar>
);

/** A tool-call input shaped like an outbound email (the `send_email` tool). */
type EmailApprovalInput = {
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  body?: string;
};

/** Comma-join one-or-many addresses; empty string when none. */
const joinAddresses = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value : value ? [value] : []).filter(Boolean).join(", ");

/**
 * Recognize an approval input that is an email draft (the `send_email` tool),
 * so its card can render a formatted preview instead of raw JSON. Structural,
 * not name-based, so a renamed email tool still previews.
 */
const asEmailInput = (input: unknown): EmailApprovalInput | null => {
  if (!input || typeof input !== "object") return null;
  const e = input as EmailApprovalInput;
  const hasBody = typeof e.body === "string";
  const hasSubject = typeof e.subject === "string";
  const hasTo = typeof e.to === "string" || Array.isArray(e.to);
  return hasBody && (hasSubject || hasTo) ? e : null;
};

/**
 * Labeled To / Cc / Subject / Body preview of an email awaiting approval, with
 * the body rendered as Markdown (headings, tables, lists) rather than the raw
 * source. Mirrors `ui-email`'s `EmailPreview` without a dependency on that
 * optional package, so the `send_email` approval card reads like an email
 * instead of a JSON blob.
 */
const EmailApprovalPreview = ({ email }: { email: EmailApprovalInput }) => {
  const to = joinAddresses(email.to);
  const cc = joinAddresses(email.cc);
  return (
    <dl className="space-y-1 rounded bg-background/40 p-2 text-[11px]">
      {to && (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">To</dt>
          <dd className="min-w-0 flex-1 truncate">{to}</dd>
        </div>
      )}
      {cc && (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Cc</dt>
          <dd className="min-w-0 flex-1 truncate">{cc}</dd>
        </div>
      )}
      {email.subject && (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Subject</dt>
          <dd className="min-w-0 flex-1 truncate font-medium">{email.subject}</dd>
        </div>
      )}
      {email.body && (
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 text-muted-foreground">Body</dt>
          <dd className="min-w-0 flex-1 break-words">
            <ToolMarkdown>{email.body}</ToolMarkdown>
          </dd>
        </div>
      )}
    </dl>
  );
};

/**
 * Inline approval prompt rendered when a `requireApproval: true` tool is
 * paused in the agent loop. Approve / deny flows through
 * {@link ApprovalDecision} to the parent resume handler.
 */
const ToolApprovalCard = ({
  toolName,
  toolCallId,
  runId,
  input,
  onResolve,
  disabled,
}: {
  toolName: string;
  toolCallId: string;
  runId?: string;
  input: unknown;
  onResolve?: (decision: ApprovalDecision) => void | Promise<void>;
  disabled?: boolean;
}) => {
  const [pending, setPending] = useState(false);
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);
  const [expired, setExpired] = useState(false);
  const handle = (approved: boolean) => {
    if (!onResolve || pending || decision) return;
    setPending(true);
    setDecision(approved ? "approved" : "denied");
    Promise.resolve(
      approved
        ? onResolve({ approved: true, toolName, toolCallId, runId, input })
        : onResolve({
            approved: false,
            toolName,
            toolCallId,
            runId,
            input,
            reason: "User denied the request from the chat UI.",
          }),
    )
      .catch(() => setExpired(true))
      .finally(() => setPending(false));
  };

  return (
    <div className="not-prose my-2 rounded-md border border-warning/40 bg-warning/5 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-warning">
        <MessageSquareIcon className="size-3.5" />
        <span>Approval needed: {humanizeToolName(toolName)}</span>
      </div>
      {asEmailInput(input) ? (
        <EmailApprovalPreview email={asEmailInput(input)!} />
      ) : (
        <pre className="overflow-x-auto rounded bg-background/40 p-2 text-[11px]">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
      {expired ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquareIcon className="size-3.5" />
          <span>This approval is no longer available.</span>
        </div>
      ) : decision ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          {decision === "approved" ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <XIcon className="size-3.5 text-destructive" />
          )}
          <span>
            {decision === "approved"
              ? pending
                ? "Approving…"
                : "Approved"
              : pending
                ? "Denying…"
                : "Denied"}
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={disabled || pending || !onResolve}
            onClick={() => handle(true)}
          >
            <CheckIcon className="size-3" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || pending || !onResolve}
            onClick={() => handle(false)}
          >
            <XIcon className="size-3" />
            Deny
          </Button>
          {!onResolve && (
            <span className="ml-1 text-[11px] text-muted-foreground">
              (approval handler not wired on this page)
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Pull every approval-pending tool call out of an assistant message's
 * `data-tool-call-approval` parts.
 */
const collectPendingApprovals = (parts: UIMessage["parts"]): PendingApproval[] => {
  const resolvedToolCallIds = new Set<string>();
  for (const part of parts ?? []) {
    const p = part as { toolCallId?: unknown; state?: unknown };
    if (typeof p.toolCallId !== "string") continue;
    if (p.state === "output-available" || p.state === "output-error") {
      resolvedToolCallIds.add(p.toolCallId);
    }
  }

  const out: PendingApproval[] = [];
  for (const part of parts ?? []) {
    const type = (part as { type?: unknown }).type;
    if (type !== "data-tool-call-approval") continue;
    const data = (part as { data?: unknown }).data;
    if (!data || typeof data !== "object") continue;
    const d = data as {
      toolName?: unknown;
      toolCallId?: unknown;
      runId?: unknown;
      args?: unknown;
    };
    if (typeof d.toolName !== "string") continue;
    if (typeof d.toolCallId !== "string") continue;
    if (resolvedToolCallIds.has(d.toolCallId)) continue;
    out.push({
      toolName: d.toolName,
      toolCallId: d.toolCallId,
      runId: typeof d.runId === "string" ? d.runId : undefined,
      input: d.args,
    });
  }
  return out;
};

/**
 * Merge inline approvals (from `message.parts`) with out-of-band
 * approvals supplied by the parent (used by the `/stream` page,
 * which doesn't store approvals as data parts). De-dupes by
 * `toolCallId` so a card never appears twice.
 */
const mergePendingApprovals = (
  fromParts: PendingApproval[],
  fromExternal: PendingApproval[] | undefined,
): PendingApproval[] => {
  if (!fromExternal || fromExternal.length === 0) return fromParts;
  const seen = new Set(fromParts.map((a) => a.toolCallId));
  return [...fromParts, ...fromExternal.filter((a) => !seen.has(a.toolCallId))];
};

type AssistantBubbleProps = {
  message: UIMessage;
  isLast: boolean;
  status: ChatStatus;
  events?: ToolEvent[];
  regenerate?: () => void;
  /** Click handler for tool-suggested follow-up questions. */
  onSuggestionClick?: (question: string) => void;
  /** Approve / deny handler for inline {@link ToolApprovalCard}s. */
  onResolveToolApproval?: (decision: ApprovalDecision) => void | Promise<void>;
  /**
   * Out-of-band approvals for this specific message (Stream page).
   * Merged with inline `data-tool-call-approval` parts.
   */
  externalApprovals?: PendingApproval[];
  /**
   * Export this message in the chosen format. When set, the bubble's
   * action row shows a per-message export menu (charts / tables inlined).
   */
  onExport?: (format: ExportFormat) => void;
  /**
   * Submit thumbs / comment feedback for this message. When set, the
   * action row shows the feedback controls; only wired by the parent
   * when MLflow logging is enabled and the turn has a captured trace id.
   */
  onFeedback?: (submission: FeedbackSubmission) => void | Promise<void>;
  /** Last thumbs the user left on this message, for highlighting. */
  feedbackValue?: FeedbackValue;
};

export const AssistantBubble = ({
  message,
  isLast,
  status,
  events,
  regenerate,
  onSuggestionClick,
  onResolveToolApproval,
  externalApprovals,
  onExport,
  onFeedback,
  feedbackValue,
}: AssistantBubbleProps) => {
  const reasoning = getReasoningText(message.parts);
  const isReasoningStreaming =
    isLast && status === "streaming" && message.parts.at(-1)?.type === "reasoning";
  const textParts = message.parts.filter(
    (p): p is { type: "text"; text: string } => p.type === "text",
  );
  const fullText = textParts.map((p) => p.text).join("");
  const hasText = fullText.length > 0;
  // Brief "copied" acknowledgement on the copy button (swaps the icon to a
  // check for ~1.5s), so a tap gives visible feedback on touch where there's
  // no hover/tooltip.
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void copyText(fullText).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  // Suggestions are deferred until the turn is settled so they don't
  // pop in mid-stream. A bubble is "settled" if it isn't the active
  // streaming target - either the agent has returned to `ready` /
  // `error`, or a newer message has taken over the `isLast` slot.
  const isStreamingThisBubble =
    isLast && (status === "streaming" || status === "submitted");
  const suggestions = isStreamingThisBubble ? [] : collectSuggestions(events);
  // Charts and tables are placed at inline marker positions in
  // the assistant's prose. `prepare_chart` / `render_data` mint
  // a `chartId` and the model embeds `[chart:<chartId>]`; for raw
  // data the model embeds `[data:<statement_id>]` and the host UI fetches the
  // rows on its own. {@link MarkdownWithEmbeds} splits the text
  // on both markers and renders {@link ChartSlot} /
  // {@link DataSlot} inline; unknown / expired ids resolve as
  // nothing so the prose flows unaffected. Suggested questions
  // stay gated on settle to avoid pop-in mid-stream.
  const pendingApprovals = mergePendingApprovals(
    collectPendingApprovals(message.parts),
    externalApprovals,
  );

  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="assistant" />
      </ItemMedia>
      {/*
       * `min-w-0` is required so wide content (markdown tables, long
       * code blocks) can shrink to fit instead of pushing the whole
       * bubble past the chat's `max-w-4xl`. Flex children default to
       * `min-width: auto`, which sizes to content and overflows.
       */}
      <ItemContent className="min-w-0 gap-2">
        {/*
         * Tool session pill leads the message. Charts and tables are
         * embedded inline in the prose (via `[chart:<id>]` / `[data:<id>]`
         * markers rendered by {@link MarkdownWithEmbeds}), so keeping the
         * pill above the text parts guarantees the "what the agent did"
         * summary always sits before its resulting charts and answer.
         */}
        {events && events.length > 0 && <ToolSessionPill events={events} />}
        {reasoning && (
          <Collapsible defaultOpen={isReasoningStreaming}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDownIcon className="size-3" />
              <span>{isReasoningStreaming ? "Thinking..." : "Thoughts"}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 border-l-2 border-border/60 pl-3 text-xs text-muted-foreground whitespace-pre-wrap">
                {reasoning}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {/*
         * Render each text part as its own block. A multi-step turn
         * carries one text part per step (see Stream.tsx segmentation),
         * so this keeps each step's preamble visually separate instead
         * of concatenating them into a single run of prose.
         */}
        {textParts.map((part, i) =>
          part.text.trim().length > 0 ? (
            <MarkdownWithEmbeds
              key={`text-${i}`}
              text={part.text}
              streaming={isStreamingThisBubble}
            />
          ) : null,
        )}
        {pendingApprovals.map((p) => (
          <ToolApprovalCard
            key={p.toolCallId}
            toolName={p.toolName}
            toolCallId={p.toolCallId}
            runId={p.runId}
            input={p.input}
            onResolve={onResolveToolApproval}
          />
        ))}
        {hasText && (isLast || onExport || onFeedback) && (
          <div className="flex items-center gap-1">
            {isLast && regenerate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => regenerate()}
                  >
                    <RefreshCcwIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Retry</TooltipContent>
              </Tooltip>
            )}
            {isLast && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={handleCopy}
                    aria-label={copied ? "Copied" : "Copy"}
                  >
                    {copied ? (
                      <CheckIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
              </Tooltip>
            )}
            {onExport && (
              <ExportMenu onExport={onExport} iconOnly tooltip="Export message" />
            )}
            {onFeedback && (
              <FeedbackControls
                onSubmit={onFeedback}
                {...(feedbackValue ? { value: feedbackValue } : {})}
              />
            )}
          </div>
        )}
        <SuggestionPills
          questions={suggestions}
          onSelect={onSuggestionClick}
          className="mt-1"
        />
      </ItemContent>
    </Item>
  );
};

export const UserBubble = ({ message }: { message: UIMessage }) => {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="user" />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <div className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {text}
        </div>
      </ItemContent>
    </Item>
  );
};
