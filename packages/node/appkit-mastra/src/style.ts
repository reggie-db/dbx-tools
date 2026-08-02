/**
 * The typography rule every prompt in this plugin shares.
 *
 * Three prompts tell a model how to render text - the agent style block
 * ({@link agents.DEFAULT_STYLE_INSTRUCTIONS}), the summarizer, and the thread
 * titler - and they have to AGREE, because a summary or a thread title sits
 * beside agent prose in the same UI. Stated three times they drifted: one said
 * "never em dashes or en dashes", another only "no em dashes". Keep the rule
 * here so a change reaches every prompt.
 *
 * Em dashes and emojis are the two most recognizable LLM tells, and an em dash
 * additionally breaks the repo's own prose style, so they are called out rather
 * than left to the model's defaults.
 *
 * @module
 */

/**
 * One sentence, safe to append to any instruction block.
 *
 * Phrased as a standalone sentence (not a list fragment) so it reads correctly
 * whether the surrounding prompt is joined with newlines or spaces.
 */
export const TYPOGRAPHY_RULE =
  "Never use emojis. Use hyphens (-) only, never em dashes or en dashes.";
