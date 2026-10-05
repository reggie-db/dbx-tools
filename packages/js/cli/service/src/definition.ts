/**
 * Serializable configuration for a system-tray CLI service.
 *
 * @module
 */

import { z } from "zod";

import { resolveServicePackage, servicePackageDefaults } from "./_package.ts";

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
    binName: z.string().min(1).optional(),
    arguments: z.array(z.string()).readonly().optional(),
    environment: z.record(z.string(), z.string()).readonly().optional(),
    cwd: z.string().min(1).optional(),
  })
  .superRefine((command, context) => {
    if (
      Number(command.executable !== undefined) +
        Number(command.entrypoint !== undefined) +
        Number(command.binName !== undefined) >
      1
    ) {
      context.addIssue({
        code: "custom",
        message: "command accepts at most one of executable, entrypoint, or binName",
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
    packageName: z.string().min(1),
    version: z.string().min(1).optional(),
    icon: z.string().min(1),
    isTemplateIcon: z.boolean().optional(),
    dataDirectory: z.string().min(1).optional(),
    command: CliServiceCommandSchema.optional(),
    menu: z.array(CliServiceMenuItemSchema).readonly().optional(),
  })
  .readonly();

/** Complete serializable definition consumed by the lifecycle manager and tray host. */
export type CliServiceDefinition = z.infer<typeof CliServiceDefinitionSchema>;

/** Package-derived service fields plus caller-owned icon, process, and menu options. */
export type CliServiceDefinitionOptions = Omit<
  CliServiceDefinition,
  "packageName" | "id" | "name" | "version"
> &
  Partial<Pick<CliServiceDefinition, "id" | "name" | "version">>;

/** Define a service from an owning module URL or installed package name. */
export function defineService(
  packageReference: string,
  options: CliServiceDefinitionOptions,
): CliServiceDefinition {
  const pkg = resolveServicePackage(packageReference);
  const defaults = servicePackageDefaults(pkg);
  return CliServiceDefinitionSchema.parse({
    ...options,
    packageName: pkg.name,
    id: options.id ?? defaults.id,
    name: options.name ?? defaults.name,
    version: options.version ?? pkg.version,
  });
}

/** Resolve a package's single or explicitly named executable entrypoint. */
export function resolveServicePackageBin(packageReference: string, binName?: string): string {
  return resolveServicePackage(packageReference).bin(binName);
}
