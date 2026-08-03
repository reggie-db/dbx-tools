/**
 * Imperative Adaptive Cards renderer loaded behind the public React wrapper.
 *
 * The `adaptivecards` package leaves TextBlock markdown processing to its host,
 * so this module installs the shared `marked` processor when the renderer chunk
 * is first requested.
 */
import * as AdaptiveCards from "adaptivecards";
import { marked } from "marked";
import { useEffect, useRef } from "react";
import type { AdaptiveCardViewProps } from "./adaptive-card.tsx";

/** Install the process-wide markdown callback required by Adaptive Cards. */
function _installMarkdownProcessor(): void {
  AdaptiveCards.AdaptiveCard.onProcessMarkdown = (text, result) => {
    try {
      result.outputHtml = marked.parse(text, { async: false, breaks: true }) as string;
      result.didProcess = true;
    } catch {
      result.didProcess = false;
    }
  };
}

_installMarkdownProcessor();

/** Parse and mount one Adaptive Card document into a host element. */
const AdaptiveCardRenderer = ({ card, onOpenUrl, className }: AdaptiveCardViewProps) => {
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
    } catch (error) {
      host.replaceChildren(
        Object.assign(document.createElement("pre"), {
          textContent: `Failed to render card: ${(error as Error).message}`,
        }),
      );
    }
    return () => host.replaceChildren();
  }, [card, onOpenUrl]);

  return <div ref={hostRef} className={className} data-testid="adaptive-card" />;
};

export default AdaptiveCardRenderer;
