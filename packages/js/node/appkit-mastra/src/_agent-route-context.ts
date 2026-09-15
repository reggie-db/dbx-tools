/**
 * Shared agent binding and request-context resolution for Mastra custom routes.
 *
 * @module
 */

import { ValidationError } from "@databricks/appkit";
import type { Agent } from "@mastra/core/agent";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  type RequestContext,
} from "@mastra/core/request-context";
import type { ContextWithMastra } from "@mastra/core/server";

/** Fixed-agent or dynamic `:agentId` binding accepted by custom agent routes. */
export type AgentRouteOptions =
  { path: `${string}:agentId${string}`; agent?: never } | { path: string; agent: string };

/** Validated route path and optional fixed agent binding. */
export interface ResolvedAgentRouteOptions {
  path: string;
  fixedAgent: string | undefined;
}

/** Resolve and validate a fixed or dynamic agent route declaration. */
export function resolveAgentRouteOptions(
  options: AgentRouteOptions,
  field: string,
): ResolvedAgentRouteOptions {
  const fixedAgent = "agent" in options ? options.agent : undefined;
  if (!fixedAgent && !options.path.includes(":agentId")) {
    throw ValidationError.invalidValue(
      field,
      options.path,
      "a path containing `:agentId`, or an explicit `agent`",
    );
  }
  return { path: options.path, fixedAgent };
}

interface ResolvedAgentRequestContext {
  agentId: string;
  agent: Agent;
  requestContext: RequestContext;
  resourceId: string;
}

interface AgentRequestContextError {
  error: Response;
}

interface ResolveAgentRequestContextOptions {
  fixedAgent?: string;
  threadId?: "optional" | "required";
}

/** Resolve an agent plus the caller-scoped Mastra request context. */
export function resolveAgentRequestContext(
  context: ContextWithMastra,
  options: ResolveAgentRequestContextOptions & { threadId: "required" },
): (ResolvedAgentRequestContext & { threadId: string }) | AgentRequestContextError;
export function resolveAgentRequestContext(
  context: ContextWithMastra,
  options?: ResolveAgentRequestContextOptions,
): (ResolvedAgentRequestContext & { threadId?: string }) | AgentRequestContextError;
export function resolveAgentRequestContext(
  context: ContextWithMastra,
  options: ResolveAgentRequestContextOptions = {},
): (ResolvedAgentRequestContext & { threadId?: string }) | AgentRequestContextError {
  const mastra = context.get("mastra");
  const requestContext = context.get("requestContext");
  const agentId = options.fixedAgent ?? context.req.param("agentId");
  if (!agentId) {
    return { error: context.json({ error: "agentId is required" }, 400) };
  }
  const agent = mastra.getAgentById(agentId);
  if (!agent) {
    return { error: context.json({ error: `Unknown agent "${agentId}"` }, 404) };
  }
  const resourceId = requestContext.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  if (!resourceId) {
    return {
      error: context.json({ error: "resource id missing from request context" }, 400),
    };
  }
  const threadId = requestContext.get(MASTRA_THREAD_ID_KEY) as string | undefined;
  if (options.threadId === "required" && !threadId) {
    return {
      error: context.json({ error: "thread id missing from request context" }, 400),
    };
  }
  return {
    agentId,
    agent,
    requestContext,
    resourceId,
    ...(threadId ? { threadId } : {}),
  };
}
