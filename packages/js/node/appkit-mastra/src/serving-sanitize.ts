/**
 * Databricks Model Serving wire repairs shared with the model gateway.
 *
 * @module
 */

export {
  applyToolReasoningCompatibility,
  flattenChoiceDeltaContent,
  flattenChoiceMessageContent,
  repairAssistantPrefill,
  rewriteServingBody,
  rewriteServingRequest,
  rewriteServingResponseBody,
  rewriteServingResponseStream,
  stripReasoningFromServingMessages,
  type RewrittenServingRequest,
  type ServingChatMessage,
} from "@dbx-tools/model/serving-wire";
