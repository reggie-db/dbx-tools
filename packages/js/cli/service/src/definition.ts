/**
 * Serializable configuration for a system-tray CLI service.
 *
 * This module owns the cross-package service definition contract, package
 * identity defaults, process command, icon, and menu schema. Reuse
 * {@link defineService} instead of maintaining another service manifest shape.
 *
 * @module
 */

import { serializeArgs, type ArgumentSource } from "@dbx-tools/cli-args/args";
import { z } from "zod";

import { resolveServicePackage, servicePackageDefaults } from "./_package.ts";
import { serviceTrayIcon } from "./icon.ts";

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

/** Command input accepted by {@link defineService} before option serialization. */
export type CliServiceCommandInput = Omit<CliServiceCommand, "arguments"> & {
  /** Positional or pre-serialized arguments placed before generated options. */
  readonly arguments?: readonly string[];
  /** Zod defaults or concrete option values converted into CLI flags. */
  readonly options?: ArgumentSource;
};

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

/** Python package installed into a service-owned uv environment. */
export const CliServicePythonPackageSchema = z
  .object({
    name: z.string().min(1).describe("Python distribution name installed by uv."),
    version: z
      .string()
      .min(1)
      .optional()
      .describe("Python distribution version. Defaults to the service package version."),
    python: z
      .string()
      .min(1)
      .default("3.11")
      .describe("Python version request passed to uv when creating the environment."),
  })
  .readonly()
  .describe("Python runtime package installed with uv for a managed service.");

/** Python package installed into a service-owned uv environment. */
export type CliServicePythonPackage = z.infer<typeof CliServicePythonPackageSchema>;

/** Python package input accepted before the default Python version is applied. */
export type CliServicePythonPackageInput = z.input<typeof CliServicePythonPackageSchema>;

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
    pythonPackage: CliServicePythonPackageSchema.optional().describe(
      "Python runtime package installed into a service-owned uv environment.",
    ),
    command: CliServiceCommandSchema.optional(),
    menu: z.array(CliServiceMenuItemSchema).readonly().optional(),
  })
  .readonly();

/** Complete serializable definition consumed by the lifecycle manager and tray host. */
export type CliServiceDefinition = z.infer<typeof CliServiceDefinitionSchema>;

/** Package-derived service fields plus caller-owned icon, process, and menu options. */
export type CliServiceDefinitionOptions = Omit<
  CliServiceDefinition,
  | "packageName"
  | "id"
  | "name"
  | "version"
  | "icon"
  | "isTemplateIcon"
  | "pythonPackage"
  | "command"
> &
  Partial<Pick<CliServiceDefinition, "id" | "name" | "version" | "icon" | "isTemplateIcon">> & {
    /** Python package installed into a service-owned uv environment. */
    readonly pythonPackage?: CliServicePythonPackageInput;
    /** Service process command with optional schema or object-backed options. */
    readonly command?: CliServiceCommandInput;
  };

/** Define a service from an owning module URL or installed package name. */
export function defineService(
  packageReference: string,
  options: CliServiceDefinitionOptions,
): CliServiceDefinition {
  const pkg = resolveServicePackage(packageReference);
  const defaults = servicePackageDefaults(pkg);
  const { command, ...definition } = options;
  return CliServiceDefinitionSchema.parse({
    ...definition,
    command: resolveServiceCommand(command),
    packageName: pkg.name,
    id: definition.id ?? defaults.id,
    name: definition.name ?? defaults.name,
    version: definition.version ?? pkg.version,
    icon: definition.icon ?? serviceTrayIcon(),
    isTemplateIcon: definition.isTemplateIcon ?? process.platform === "darwin",
  });
}

function resolveServiceCommand(
  command: CliServiceCommandInput | undefined,
): CliServiceCommand | undefined {
  if (!command) return undefined;
  const { options, ...definition } = command;
  const arguments_ = [
    ...(definition.arguments ?? []),
    ...(options === undefined ? [] : serializeArgs(options)),
  ];
  return CliServiceCommandSchema.parse({
    ...definition,
    environment: { NODE_ENV: "production", ...definition.environment },
    ...(arguments_.length > 0 ? { arguments: arguments_ } : {}),
  });
}

/** Resolve a package's single or explicitly named executable entrypoint. */
export function resolveServicePackageBin(packageReference: string, binName?: string): string {
  return resolveServicePackage(packageReference).bin(binName);
}
