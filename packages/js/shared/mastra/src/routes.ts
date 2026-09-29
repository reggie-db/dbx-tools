/**
 * Route segments the Mastra plugin mounts under its `basePath`
 * (`/api/<plugin-name>`). Shared between the server's route
 * registration and the browser client (`MastraPluginClient` in
 * `@dbx-tools/ui-mastra`) so a relayout - or a rename of a
 * sub-path - is a one-line change here and the two can never drift.
 *
 * The agent-scoped segments (`suggestions`, `defaultModel`) take an optional
 * `/:agentId` suffix; the default agent uses the bare segment. Conversation
 * streaming, memory history, and thread management ride the standard Mastra
 * client routes, so there are no parallel chat or memory segments here.
 *
 * `feedback` is the plugin-owned POST endpoint the chat UI calls to
 * log a thumbs / comment assessment against a turn's MLflow trace (see
 * `feedback.ts`); it is not agent-scoped (a trace id identifies the
 * turn on its own).
 *
 * @module
 */
export const MASTRA_ROUTES = {
  feedback: "/route/feedback",
  suggestions: "/suggestions",
  models: "/models",
  // The static serving-endpoint an agent falls back to when the client pins
  // no model. Agent-scoped like `history`/`threads`/`suggestions` via an
  // optional `/:agentId` suffix; the default agent uses the bare segment.
  // Returns `{ agentId, model, displayName }` where `model` and `displayName`
  // are null when the agent resolves its model dynamically at call time
  // (nothing static to advertise). Lets the picker label its default option
  // with the humanized model name.
  defaultModel: "/default-model",
  embed: "/embed",
} as const;
