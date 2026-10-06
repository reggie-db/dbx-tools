/**
 * Commander arguments generated from a Zod object schema.
 *
 * Zod owns validation, coercion, metadata, and defaults. Commander owns flags,
 * help, and environment display. {@link configUtils} supplies layered local
 * configuration before the final Zod parse.
 *
 * @module
 */

import { configUtils } from "@dbx-tools/core";
import { object, options as sharedOptions, stringUtils } from "@dbx-tools/shared-core";
import { Command, Option } from "commander";
import { z } from "zod";

/** Layered config lookup used to resolve argument values and help defaults. */
export type CliArgsOptions = configUtils.ConfigOptions;

/** CLI metadata read from a field's Zod `.meta()` value. */
export interface CliArgMeta {
  /** Exact environment name or ordered aliases used instead of field-name derivation. */
  readonly env?: string | readonly string[];
  /** Set false to resolve the field from config without generating a Commander flag. */
  readonly flag?: boolean;
  /** Set false to keep schema and configured defaults out of generated help. */
  readonly helpDefault?: boolean;
}

/** Zod defaults or concrete option values serialized by {@link serializeArgs}. */
export type ArgumentSource = z.ZodObject<z.ZodRawShape> | Readonly<Record<string, unknown>>;

interface JsonField extends CliArgMeta {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
}

interface Field extends CliArgMeta {
  key: string;
  description: string;
  type?: string;
  choices?: string[];
  fallback?: unknown;
}

const boundOptions = new WeakMap<Command, CliArgsOptions>();

/** Register Commander arguments for every enabled field on a Zod object schema. */
export function addArgs<T extends z.ZodRawShape>(
  command: Command,
  schema: z.ZodObject<T>,
  options: CliArgsOptions = {},
): Command {
  boundOptions.set(command, options);
  for (const field of fields(schema)) {
    if (field.flag === false) continue;
    const envKeys = fieldEnvKeys(field);
    const envName = envArgName(field, envKeys, options);
    const flags = argFlags(field);
    const sourced = configValue(field, envKeys, options);
    const fallback = sourced ?? field.fallback;
    const option = new Option(flags, field.description);
    Object.defineProperty(option, "schemaHelpDefault", {
      value: field.helpDefault === false ? undefined : field.fallback,
    });
    if (envName) option.env(envName);
    if (field.choices && field.choices.length > 0) option.choices(field.choices);
    if (fallback !== undefined && field.helpDefault !== false) {
      const address = listenAddress(fallback);
      option.default(fallback, address ? sharedOptions.formatListenAddress(address) : undefined);
    }
    if (field.type === "array") {
      option.argParser((value: string, previous: unknown) =>
        previous === fallback || !Array.isArray(previous) ? [value] : [...previous, value],
      );
    }
    command.addOption(option);
    if (field.type === "boolean" && option.long) {
      command.addOption(
        new Option(`--no-${option.long.slice(2)}`, `Disable ${field.description.toLowerCase()}`),
      );
    }
  }
  return command;
}

/** Merge CLI values over layered config, then validate and default through Zod. */
export function parseArgs<T extends z.ZodRawShape>(
  command: Command,
  schema: z.ZodObject<T>,
  options: CliArgsOptions = boundOptions.get(command) ?? {},
): z.output<z.ZodObject<T>> {
  const values: Record<string, unknown> = {};
  for (const field of fields(schema)) {
    if (command.getOptionValueSource(field.key) === "cli") {
      values[field.key] = command.getOptionValue(field.key);
      continue;
    }
    const sourced = configValue(field, fieldEnvKeys(field), options);
    if (sourced !== undefined) values[field.key] = sourced;
  }
  return schema.parse(values);
}

/** Convert schema defaults or concrete option values into Commander arguments. */
export function serializeArgs(source: ArgumentSource): string[] {
  if (source instanceof z.ZodObject) {
    const values = source.parse({}) as Readonly<Record<string, unknown>>;
    return fields(source).flatMap((field) =>
      field.flag === false ? [] : valueArguments(field.key, values[field.key]),
    );
  }
  return Object.entries(source).flatMap(([key, value]) => valueArguments(key, value));
}

function fields(schema: z.ZodObject<z.ZodRawShape>): Field[] {
  const document = z.toJSONSchema(schema);
  const properties = object.isRecord(document) ? document.properties : undefined;
  if (!object.isRecord(properties)) {
    throw new TypeError("Zod Commander binding requires a z.object() schema");
  }
  return Object.entries(properties).map(([key, value]) => {
    if (!object.isRecord(value)) {
      throw new TypeError(`Cannot bind CLI argument "${key}"`);
    }
    const json = value as JsonField;
    const choices =
      json.enum?.map(String) ?? (json.const === undefined ? undefined : [String(json.const)]);
    return {
      key,
      description: typeof json.description === "string" ? json.description : "",
      type: json.type,
      choices,
      fallback: json.default,
      env: json.env,
      flag: json.flag,
      helpDefault: json.helpDefault,
    };
  });
}

function argFlags(field: Field): string {
  const flag = `--${stringUtils.toSlug(field.key)}`;
  return field.type === "boolean" ? flag : `${flag} <value>`;
}

function fieldEnvKeys(field: Field): readonly string[] {
  if (typeof field.env === "string") return [field.env];
  if (Array.isArray(field.env)) return [...field.env];
  return configUtils.environmentKeys(field.key);
}

function envArgName(field: Field, envKeys: readonly string[], options: CliArgsOptions): string {
  if (field.env !== undefined) return envKeys[0] ?? "";
  const canonical =
    envKeys.find((key) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(key)) ??
    envKeys.find((key) => key === key.toUpperCase() && /[A-Z]/.test(key)) ??
    envKeys.at(-1) ??
    "";
  return configUtils.name(canonical, options);
}

function configValue(
  field: Field,
  envKeys: string | readonly string[],
  options: CliArgsOptions,
): unknown {
  if (field.type === "array") {
    const values = configUtils.list(undefined, envKeys, undefined, options);
    return values.length > 0 ? values : undefined;
  }
  if (field.type === "boolean") return configUtils.boolean(undefined, envKeys, options);
  return configUtils.text(envKeys, options);
}

function valueArguments(key: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const flag = `--${stringUtils.toSlug(key)}`;
  if (typeof value === "boolean") return [value ? flag : `--no-${flag.slice(2)}`];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => [flag, scalarArgument(key, entry)]);
  }
  return [flag, scalarArgument(key, value)];
}

function scalarArgument(key: string, value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  const address = listenAddress(value);
  if (address) return sharedOptions.formatListenAddress(address);
  throw new TypeError(`Cannot serialize CLI argument "${key}" with a non-scalar value`);
}

function listenAddress(value: unknown): sharedOptions.ListenAddress | undefined {
  if (!object.isRecord(value)) return undefined;
  if (value.scheme === "tcp" && typeof value.host === "string" && typeof value.port === "number") {
    return { scheme: "tcp", host: value.host, port: value.port };
  }
  if (value.scheme === "unix" && typeof value.path === "string") {
    return { scheme: "unix", path: value.path };
  }
  return undefined;
}
