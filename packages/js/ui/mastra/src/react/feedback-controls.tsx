import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";
import { MessageSquareTextIcon, ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useState } from "react";
import type { FeedbackSubmission, FeedbackValue } from "./types.ts";

// Per-message feedback action row: thumbs up/down that log immediately,
// plus a separate comment affordance that opens a modal for freeform
// text. Rendered inside the assistant bubble's action row when the host
// wires feedback (which only happens when MLflow logging is enabled and
// the turn has a captured trace id).

/** Render per-message rating and comment controls for an MLflow-backed trace. */
export const FeedbackControls = ({
  mode = "mlflow",
  request,
  value,
  onSubmit,
}: {
  /** Server-selected feedback destination. */
  mode?: "mlflow" | "genie";
  /** Original user request shown in Genie feedback. */
  request?: string;
  /** Last thumbs the user chose, so the active button stays highlighted. */
  value?: FeedbackValue;
  onSubmit: (submission: FeedbackSubmission) => void | Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [rating, setRating] = useState<FeedbackValue | undefined>(value);
  const [sending, setSending] = useState(false);

  const submitComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onSubmit({ comment: text });
      setComment("");
      setOpen(false);
    } finally {
      setSending(false);
    }
  };

  const submitGenieFeedback = async () => {
    if (!rating || !request?.trim() || sending) return;
    setSending(true);
    try {
      await onSubmit({
        value: rating,
        request: request.trim(),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setOpen(false);
    } finally {
      setSending(false);
    }
  };

  if (mode === "genie") {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Give feedback"
              >
                <MessageSquareTextIcon className="size-3" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Give feedback</TooltipContent>
        </Tooltip>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Feedback</DialogTitle>
            <DialogDescription>Send feedback directly to this Genie response.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Rating</legend>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={rating === "up" ? "default" : "outline"}
                  aria-pressed={rating === "up"}
                  onClick={() => setRating("up")}
                >
                  <ThumbsUpIcon className="size-4" />
                  Good
                </Button>
                <Button
                  type="button"
                  variant={rating === "down" ? "destructive" : "outline"}
                  aria-pressed={rating === "down"}
                  onClick={() => setRating("down")}
                >
                  <ThumbsDownIcon className="size-4" />
                  Bad
                </Button>
              </div>
            </fieldset>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Request</p>
              <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-foreground">
                {request}
              </p>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>Comment</span>
              <Textarea
                value={comment}
                maxLength={5_000}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Optional details"
                rows={4}
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!rating || !request?.trim() || sending}
              onClick={() => void submitGenieFeedback()}
            >
              {sending ? "Sending..." : "Send feedback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-7", value === "up" && "text-success")}
            aria-label="Good response"
            aria-pressed={value === "up"}
            onClick={() => void onSubmit({ value: "up" })}
          >
            <ThumbsUpIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Good response</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn("size-7", value === "down" && "text-destructive")}
            aria-label="Bad response"
            aria-pressed={value === "down"}
            onClick={() => void onSubmit({ value: "down" })}
          >
            <ThumbsDownIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Bad response</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Leave a comment"
              >
                <MessageSquareTextIcon className="size-3" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>Leave a comment</TooltipContent>
        </Tooltip>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share feedback</DialogTitle>
            <DialogDescription>
              Tell us what worked well or what could be improved.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submitComment();
              }
            }}
            placeholder="Add details about this response"
            rows={5}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!comment.trim() || sending}
              onClick={() => void submitComment()}
            >
              {sending ? "Sending..." : "Send feedback"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
