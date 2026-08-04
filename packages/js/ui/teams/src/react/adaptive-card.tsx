import type { AdaptiveCard as AdaptiveCardDocument } from "@dbx-tools/shared-teams";
import { lazy, Suspense } from "react";

const AdaptiveCardRenderer = lazy(() => import("./_adaptive-card-renderer.tsx"));

/** Props for {@link AdaptiveCardView}. */
export interface AdaptiveCardViewProps {
  /** The compiled Adaptive Card document to render. */
  card: AdaptiveCardDocument;
  /**
   * Called when an `Action.OpenUrl` button is tapped. Defaults to opening the
   * URL in a new tab. Pass a handler to intercept (e.g. to post back instead).
   */
  onOpenUrl?: (url: string) => void;
  /** Extra classes merged onto the mount container. */
  className?: string;
}

/**
 * Render a single Adaptive Card document, loading the imperative renderer and
 * markdown processor only when a card is actually mounted.
 */
export const AdaptiveCardView = (props: AdaptiveCardViewProps) => (
  <Suspense
    fallback={<div className={props.className} data-testid="adaptive-card" aria-busy="true" />}
  >
    <AdaptiveCardRenderer {...props} />
  </Suspense>
);
