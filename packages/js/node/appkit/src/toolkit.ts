/**
 * Type-owned AppKit toolkit entry construction shared by dbx-tools add-ons.
 *
 * @module
 */

import type { AgentToolDefinition, ToolkitEntry, ToolkitOptions } from "@databricks/appkit/beta";

/** Resolve one local tool name through AppKit toolkit filtering and naming options. */
export function name(
  localName: string,
  pluginName: string,
  options: ToolkitOptions = {},
): string | null {
  if (options.only && !options.only.includes(localName)) return null;
  if (options.except?.includes(localName)) return null;
  return options.rename?.[localName] ?? `${options.prefix ?? `${pluginName}.`}${localName}`;
}

/** Convert AppKit tool definitions into public toolkit references. */
export function entries(
  pluginName: string,
  definitions: readonly AgentToolDefinition[],
  options: ToolkitOptions = {},
): Record<string, ToolkitEntry> {
  return Object.fromEntries(
    definitions.flatMap((definition) => {
      const key = name(definition.name, pluginName, options);
      if (key === null) return [];
      return [
        [
          key,
          {
            __toolkitRef: true as const,
            pluginName,
            localName: definition.name,
            def: { ...definition, name: key },
            annotations: definition.annotations,
          } satisfies ToolkitEntry,
        ],
      ];
    }),
  );
}
