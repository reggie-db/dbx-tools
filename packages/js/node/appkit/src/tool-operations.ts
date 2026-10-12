/** Zod-owned operation contracts converted into native AppKit agent tools. */

import { defineTool, type ToolRegistry } from "@databricks/appkit/beta";
import { z } from "zod";

/** Metadata stored under `appkitTool` by a Zod schema's `.meta()` value. */
export interface AppKitToolMeta {
  /** Opt in to exposing this operation as an agent tool. */
  readonly agentTool?: boolean;
  /** Tool side-effect classification. Defaults to `write`. */
  readonly effect?: "read" | "write" | "destructive";
  /** Require human approval before execution. */
  readonly approval?: boolean;
  /** Whether execution requires an authenticated user context. */
  readonly requiresUserContext?: boolean;
  /** Whether repeated calls with the same input are safe. */
  readonly idempotent?: boolean;
  /** Whether AppKit may inherit the tool automatically. */
  readonly autoInheritable?: boolean;
}

/** Shape placed in a Zod schema's `.meta()` value. */
export interface AppKitOperationSchemaMeta {
  readonly appkitTool?: AppKitToolMeta;
}

/** One typed operation backed by a single Zod input contract. */
export interface AppKitOperation<TSchema extends z.ZodType = z.ZodType, TResult = unknown> {
  readonly schema: TSchema;
  readonly execute: (input: z.output<TSchema>, signal?: AbortSignal) => TResult | Promise<TResult>;
}

/** Preserve operation inference while declaring an exported operation map. */
export function defineOperations<
  const TSchemas extends Readonly<Record<string, z.ZodType>>,
>(operations: {
  readonly [TName in keyof TSchemas]: AppKitOperation<TSchemas[TName], unknown>;
}): typeof operations {
  return operations;
}

/** Convert exported Zod operation contracts into a native AppKit tool registry. */
export function toolRegistryFromOperations(
  operations: Readonly<Record<string, AppKitOperation<z.ZodType, unknown>>>,
): ToolRegistry {
  return Object.fromEntries(
    Object.entries(operations).flatMap(([name, operation]) => {
      const metadata = operation.schema.meta() as AppKitOperationSchemaMeta | undefined;
      const tool = metadata?.appkitTool ?? {};
      if (tool.agentTool !== true) return [];
      const effect = tool.effect ?? "write";
      const approval = tool.approval === true || effect === "destructive";
      const description = operation.schema.description?.trim();
      if (!description) {
        throw new TypeError(`AppKit operation ${name} requires a Zod schema description`);
      }
      return [
        [
          name,
          defineTool({
            description,
            schema: operation.schema,
            annotations: {
              effect,
              ...(approval ? { destructive: true } : {}),
              ...(tool.requiresUserContext === undefined
                ? {}
                : { requiresUserContext: tool.requiresUserContext }),
              ...(tool.idempotent === undefined ? {} : { idempotent: tool.idempotent }),
            },
            ...(tool.autoInheritable === undefined
              ? {}
              : { autoInheritable: tool.autoInheritable }),
            execute: (input, signal) => operation.execute(operation.schema.parse(input), signal),
          }),
        ],
      ];
    }),
  );
}
