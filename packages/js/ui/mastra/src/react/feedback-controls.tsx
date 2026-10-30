import {
  Button,
  Dialog,
  DialogContent,
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

/** Render per-message rating controls and a dedicated written-feedback modal. */
export const FeedbackControls = ({
  mode = "mlflow",
  request,
  value,
  onSubmit,
}: {
  /** Server-selected feedback destination. */
  mode?: "mlflow" | "genie";
  /** Original user request required by Genie feedback. */
  request?: string;
  /** Last thumbs the user chose, so the active button stays highlighted. */
  value?: FeedbackValue;
  onSubmit: (submission: FeedbackSubmission) => void | Promise<void>;
}) => {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const genieRequest = request?.trim();
  const canComment = mode === "mlflow" || Boolean(value && genieRequest);

  const submitRating = (rating: FeedbackValue) => {
    if (mode === "genie") {
      if (!genieRequest) return;
      void onSubmit({ value: rating, request: genieRequest });
      return;
    }
    void onSubmit({ value: rating });
  };

  const submitComment = async () => {
    const text = comment.trim();
    if (!text || sending) return;
    if (mode === "genie" && (!value || !genieRequest)) return;
    setSending(true);
    try {
      await onSubmit({
        ...(mode === "genie" ? { value, request: genieRequest } : {}),
        comment: text,
      });
      setComment("");
      setOpen(false);
    } finally {
      setSending(false);
    }
  };

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
            onClick={() => submitRating("up")}
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
            onClick={() => submitRating("down")}
          >
            <ThumbsDownIcon className="size-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Bad response</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild disabled={!canComment}>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={canComment ? "Leave written feedback" : "Rate the response first"}
                disabled={!canComment}
              >
                <MessageSquareTextIcon className="size-3" />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          {!open && (
            <TooltipContent>
              {canComment ? "Leave written feedback" : "Rate the response first"}
            </TooltipContent>
          )}
        </Tooltip>
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share feedback</DialogTitle>
          </DialogHeader>
          <Textarea
            value={comment}
            maxLength={5_000}
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitComment();
              }
            }}
            placeholder="Add details about this response"
            rows={5}
            autoFocus
          />
          <DialogFooter>
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
