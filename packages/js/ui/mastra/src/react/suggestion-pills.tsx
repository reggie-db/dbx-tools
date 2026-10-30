import { Button, cn } from "@databricks/appkit-ui/react";

// Shared rendering for suggested questions. Both the initial starter
// suggestions (above the composer when the transcript is empty) and
// the per-message follow-up suggestions use this so the two look and
// behave identically.

/** Props for the shared starter and follow-up question pill row. */
export interface SuggestionPillsProps {
  /** Questions to render as clickable pills. Empty renders nothing. */
  questions: string[];
  /** Invoked with the question text when a pill is clicked. */
  onSelect?: (question: string) => void;
  /**
   * Render the pills inert. Used while a thread's history is still loading,
   * where a click would start a turn against a transcript that has not
   * arrived yet.
   */
  disabled?: boolean;
  /** Arrange suggestions in a horizontal row or vertical list. */
  orientation?: "horizontal" | "vertical";
  /** Extra classes for the wrapping flex row (layout / spacing). */
  className?: string;
}

/** Render suggestion actions in the requested layout. */
export const SuggestionPills = ({
  questions,
  onSelect,
  disabled = false,
  orientation = "horizontal",
  className,
}: SuggestionPillsProps) => {
  if (questions.length === 0) return null;
  return (
    <div
      aria-label="Suggested questions"
      className={cn(
        "flex gap-1.5",
        orientation === "horizontal"
          ? "touch-pan-x flex-nowrap overflow-x-auto overscroll-x-contain [scrollbar-width:none] md:flex-wrap md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
          : "flex-col",
        className,
      )}
    >
      {questions.map((q) => (
        <Button
          key={q}
          type="button"
          size="sm"
          variant="outline"
          className={cn(
            "h-auto shrink-0 whitespace-normal rounded-2xl px-3 py-1.5 text-left text-xs font-normal leading-snug",
            orientation === "horizontal"
              ? "max-w-[min(20rem,85vw)] md:max-w-full"
              : "w-full max-w-full justify-start",
          )}
          onClick={() => onSelect?.(q)}
          disabled={disabled || !onSelect}
        >
          {q}
        </Button>
      ))}
    </div>
  );
};
