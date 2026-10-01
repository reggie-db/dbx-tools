/** AppKit plugin base for tools backed by the native registry helpers. */

import { Plugin, type BasePluginConfig } from "@databricks/appkit";
import {
  executeFromRegistry,
  toolsFromRegistry,
  type AgentToolDefinition,
  type ToolProvider,
  type ToolRegistry,
} from "@databricks/appkit/beta";

/**
 * Implements AppKit's `ToolProvider` contract from one native tool registry.
 *
 * Subclasses own only their registry entries. Validation, LLM-friendly schema
 * errors, tool descriptions, and dispatch stay on AppKit's native helpers.
 */
export abstract class ToolRegistryPlugin<TConfig extends BasePluginConfig = BasePluginConfig>
  extends Plugin<TConfig>
  implements ToolProvider
{
  /** Native AppKit tool entries exposed by this plugin. */
  protected abstract get toolRegistry(): ToolRegistry;

  /** Tool definitions offered to an AppKit agent. */
  getAgentTools(): AgentToolDefinition[] {
    return toolsFromRegistry(this.toolRegistry);
  }

  /** Validate and dispatch one AppKit agent tool call. */
  executeAgentTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return executeFromRegistry(this.toolRegistry, name, args, signal);
  }
}
