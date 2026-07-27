/**
 * Compile a high-level {@link card.CardSpec} into a valid Adaptive Card 1.5
 * document. The model drafts the small semantic spec; this is the single place
 * that turns it into the element tree the `adaptivecards` renderer consumes and
 * Teams accepts, so a card is well-formed by construction rather than by hoping
 * the model produced correct schema.
 *
 * Element choices are deliberate and conservative:
 * - the title is a bold, large `TextBlock`; the subtitle a lighter one;
 * - body text is a wrapping `TextBlock` (Teams renders its Markdown subset);
 * - facts become a single `FactSet` (the right control for key/value detail);
 * - each action becomes an `Action.OpenUrl` - the one action safe to render in
 *   any host with no back end wired up.
 *
 * @module
 */

import { card } from "@dbx-tools/shared-teams";

/** An Adaptive Card element (loosely typed; the builder owns the exact shapes). */
type CardElement = Record<string, unknown>;

/** Build the title / subtitle heading block(s). */
function headingElements(spec: card.CardSpec): CardElement[] {
  const elements: CardElement[] = [
    {
      type: "TextBlock",
      text: spec.title,
      size: "Large",
      weight: "Bolder",
      wrap: true,
    },
  ];
  if (spec.subtitle) {
    elements.push({
      type: "TextBlock",
      text: spec.subtitle,
      isSubtle: true,
      spacing: "None",
      wrap: true,
    });
  }
  return elements;
}

/** Build the optional body `TextBlock`. */
function textElements(spec: card.CardSpec): CardElement[] {
  if (!spec.text) return [];
  return [{ type: "TextBlock", text: spec.text, wrap: true }];
}

/** Build the optional `FactSet` from the spec's facts. */
function factElements(spec: card.CardSpec): CardElement[] {
  if (!spec.facts || spec.facts.length === 0) return [];
  return [
    {
      type: "FactSet",
      facts: spec.facts.map((fact) => ({ title: fact.title, value: fact.value })),
    },
  ];
}

/** Build the `Action.OpenUrl` actions from the spec's link buttons. */
function actionElements(spec: card.CardSpec): CardElement[] {
  if (!spec.actions || spec.actions.length === 0) return [];
  return spec.actions.map((action) => ({
    type: "Action.OpenUrl",
    title: action.title,
    url: action.url,
  }));
}

/**
 * Compile a semantic card spec into a full Adaptive Card document. The result
 * validates against {@link card.adaptiveCardSchema} and is ready to render with
 * the `adaptivecards` package or post to a Teams incoming webhook.
 */
export function buildAdaptiveCard(spec: card.CardSpec): card.AdaptiveCard {
  const body: CardElement[] = [
    ...headingElements(spec),
    ...textElements(spec),
    ...factElements(spec),
  ];
  const actions = actionElements(spec);
  const document: card.AdaptiveCard = {
    type: "AdaptiveCard",
    $schema: card.ADAPTIVE_CARD_SCHEMA_URL,
    version: card.ADAPTIVE_CARD_VERSION,
    body,
    ...(actions.length > 0 ? { actions } : {}),
  };
  return document;
}

/**
 * Compile a spec into the tool/route result shape: the validated Adaptive Card
 * document plus the title echoed back for a caller that wants a label without
 * re-reading the document.
 */
export function buildCardResult(spec: card.CardSpec): card.CardResult {
  return { title: spec.title, card: buildAdaptiveCard(spec) };
}
