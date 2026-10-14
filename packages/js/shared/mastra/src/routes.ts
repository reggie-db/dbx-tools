/**
 * Route segments the Mastra plugin mounts under its `basePath`
 * (`/api/<plugin-name>`). Shared between the server's route
 * registration and the browser client (`MastraPluginClient` in
 * `@dbx-tools/ui-mastra`) so a relayout - or a rename of a
 * sub-path - is a one-line change here and the two can never drift.
 *
 * `chat` is the official Mastra AI SDK UI stream route and always carries an
 * agent id. The `suggestions` and `defaultModel` segments take an optional
 * `/:agentId` suffix; the default agent uses the bare segment. Memory history
 * and thread management ride Mastra's native memory routes.
 *
 * `feedback` is the plugin-owned POST endpoint the chat UI calls to
 * log a thumbs / comment assessment against a turn's MLflow trace (see
 * `feedback.ts`); it is not agent-scoped (a trace id identifies the
 * turn on its own).
 *
 * @module
 */
export const MASTRA_ROUTES = {
  chat: "/chat",
  runs: "/runs",
  abort: "/abort",
  feedback: "/route/feedback",
  mlflowExperiment: "/route/mlflow-experiment",
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
  // Direct Genie conversations: `/genie/:alias` scopes the chat, threads,
  // messages, and suggestions segments to one configured Genie space alias.
  genie: "/genie",
  threads: "/threads",
  messages: "/messages",
} as const;

/**
 * Build a mount-relative direct Genie route for one space alias. Each part is
 * either a {@link MASTRA_ROUTES} segment (leading `/`), an Express parameter
 * token (leading `:`), or a concrete id, which is URI-encoded.
 *
 * @example
 * genieRoutePath(":alias", MASTRA_ROUTES.threads, ":threadId"); // server
 * genieRoutePath("default", MASTRA_ROUTES.threads, conversationId); // browser
 */
export function genieRoutePath(alias: string, ...parts: string[]): string {
  const encode = (part: string) =>
    part.startsWith("/") || part.startsWith(":") ? part : encodeURIComponent(part);
  return [MASTRA_ROUTES.genie, ...[alias, ...parts].map(encode)].join("/").replace(/\/{2,}/g, "/");
}
