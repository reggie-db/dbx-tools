// React surface for `@dbx-tools/ui-teams`: a `TeamsChat` that talks to the
// conversation endpoint and renders each reply's Adaptive Card attachments like
// a Teams channel, an `AdaptiveCardView` that renders a compiled Adaptive Card
// document with the `adaptivecards` JavaScript renderer, and a self-contained
// `AdaptiveCardGallery` dev tool that edits a `CardSpec`, compiles it through
// the server's `/api/teams/card` route, and previews the result live. Styled
// with AppKit tokens.

export type { Activity, AdaptiveCard, CardResult, CardSpec } from "@dbx-tools/shared-teams";
export { TeamsChat, DEFAULT_STARTERS, type TeamsChatProps } from "./teams-chat";
export { AdaptiveCardView, type AdaptiveCardViewProps } from "./adaptive-card";
export { AdaptiveCardGallery, type AdaptiveCardGalleryProps } from "./adaptive-card-gallery";
export { CARD_SAMPLES, type CardSample } from "./samples";
