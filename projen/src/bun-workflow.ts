/** Shared Bun setup for generated workflows. */

/** Bun version used by package manifests, generated workflows, and CLI services. */
export const BUN_VERSION = "1.4.2";

/** Oldest Bun release allowed to run generated project tasks. */
export const MINIMUM_BUN_VERSION = BUN_VERSION;

/** Generated runtime-version guard executed before dependency installation. */
export const BUN_VERSION_CHECK_SCRIPT = "scripts/check-bun.ts";
