// React wrapper over the Adaptive Cards JavaScript renderer (the
// `adaptivecards` npm package). The renderer is imperative - you feed it card
// JSON and it returns a rendered `HTMLElement` - so this component parses the
// document and mounts the rendered node into a ref on every change, and wires
// `Action.OpenUrl` clicks to an optional handler (defaulting to opening the URL
// in a new tab). This is the same renderer many internal Teams preview tools
// embed to show cards outside Teams.
//
// The renderer deliberately ships NO markdown parser: a `TextBlock` is markdown
// per the Adaptive Cards spec, but `adaptivecards` leaves the implementation to
// the host so each host can pick its own (and its own sanitization). Without a
// host processor Teams' own `**bold**` renders literally, so this module
// installs `marked` as the processor once at import - see
// {@link installMarkdownProcessor}.

import type { AdaptiveCard as AdaptiveCardDocument } from "@dbx-tools/shared-teams";
import * as AdaptiveCards from "adaptivecards";
import { marked } from "marked";
import { useEffect, useRef } from "react";

/**
 * Teach the renderer to process `TextBlock` markdown with `marked`.
 *
 * `onProcessMarkdown` is a STATIC hook on `AdaptiveCard`, so this runs once per
 * module load rather than per component. `didProcess` must be set to `true` or
 * the renderer discards the HTML and falls back to the raw text.
 *
 * `marked` is called in a try/catch and falls back to leaving the text alone:
 * card text can come from a model, and a markdown edge case should degrade to
 * plain text rather than blanking the card.
 */
const installMarkdownProcessor = () => {
  AdaptiveCards.AdaptiveCard.onProcessMarkdown = (text, result) => {
    try {
      result.outputHtml = marked.parse(text, { async: false, breaks: true }) as string;
      result.didProcess = true;
    } catch {
      result.didProcess = false;
    }
  };
};

installMarkdownProcessor();

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
 * Render a single Adaptive Card document with the `adaptivecards` renderer.
 * Re-renders whenever the card JSON changes.
 */
export const AdaptiveCardView = ({ card, onOpenUrl, className }: AdaptiveCardViewProps) => {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const rendered = new AdaptiveCards.AdaptiveCard();
    rendered.onExecuteAction = (action) => {
      if (action instanceof AdaptiveCards.OpenUrlAction && action.url) {
        if (onOpenUrl) onOpenUrl(action.url);
        else window.open(action.url, "_blank", "noopener,noreferrer");
      }
    };
    try {
      rendered.parse(card as unknown as Record<string, unknown>);
      const element = rendered.render();
      host.replaceChildren(...(element ? [element] : []));
    } catch (err) {
      host.replaceChildren(
        Object.assign(document.createElement("pre"), {
          textContent: `Failed to render card: ${(err as Error).message}`,
        }),
      );
    }
    return () => host.replaceChildren();
  }, [card, onOpenUrl]);

  return <div ref={hostRef} className={className} data-testid="adaptive-card" />;
};
