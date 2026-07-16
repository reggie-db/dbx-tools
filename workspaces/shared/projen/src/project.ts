/**
 * Runtime-agnostic dbx-tools project surface.
 *
 * Projen Node/TypeScript classes and package tooling live in {@link ./package}.
 */
import type { DBXToolsConfig } from "./dbx-tools-config";

/**
 * Runtime-agnostic dbx-tools workspace project surface. Deliberately minimal - it
 * carries only {@link dbxToolsConfig} so non-Node projects (e.g. future Python
 * package discovery) can implement it. Node/TypeScript specifics live on
 * `IDBXToolsNodeProject` in {@link ./package}.
 */
export interface IDBXToolsProject {
  readonly dbxToolsConfig: DBXToolsConfig;
}
