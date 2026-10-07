/**
 * Binding-safe Lakebase address and credential surface.
 *
 * Generated language bindings retain one Lakebase client so discovery and
 * Databricks authentication caches remain shared across database connections.
 *
 * @module
 */

export { parseAddress } from "./address.ts";
export { createLakebaseClient } from "./client.ts";
