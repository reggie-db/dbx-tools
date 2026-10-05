/**
 * Serializable configuration for a system-tray CLI service.
 *
 * @module
 */

import { z } from "zod";

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeUrl(value: string): boolean {
  try {
    return SAFE_URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** A process launched by the system-tray service host. */
export const CliServiceCommandSchema = z
  .object({
    executable: z.string().min(1).optional(),
    entrypoint: z.string().min(1).optional(),
    arguments: z.array(z.string()).readonly().optional(),
    cwd: z.string().min(1).optional(),
  })
  .superRefine((command, context) => {
    if (Number(command.executable !== undefined) + Number(command.entrypoint !== undefined) !== 1) {
      context.addIssue({
        code: "custom",
        message: "command requires exactly one of executable or entrypoint",
      });
    }
  })
  .readonly();

/** A process launched by the system-tray service host. */
export type CliServiceCommand = z.infer<typeof CliServiceCommandSchema>;

/** A typed custom item inserted between the default service title and Quit item. */
export const CliServiceMenuItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("separator") }).readonly(),
  z
    .object({
      type: z.literal("url"),
      label: z.string().min(1),
      url: z.string().refine(isSafeUrl, "URL must use HTTP, HTTPS, or mailto"),
    })
    .readonly(),
  z
    .object({
      type: z.literal("command"),
      label: z.string().min(1),
      command: CliServiceCommandSchema,
    })
    .readonly(),
]);

/** A typed custom item inserted between the default service title and Quit item. */
export type CliServiceMenuItem = z.infer<typeof CliServiceMenuItemSchema>;

/** Complete serializable definition consumed by the lifecycle manager and tray host. */
export const CliServiceDefinitionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, "service id must be filesystem safe"),
    name: z.string().min(1),
    version: z.string().min(1),
    icon: z.string().min(1),
    isTemplateIcon: z.boolean().optional(),
    dataDirectory: z.string().min(1).optional(),
    command: CliServiceCommandSchema.optional(),
    menu: z.array(CliServiceMenuItemSchema).readonly().optional(),
  })
  .readonly();

/** Complete serializable definition consumed by the lifecycle manager and tray host. */
export type CliServiceDefinition = z.infer<typeof CliServiceDefinitionSchema>;
