/**
 * Default Vite plugins for host apps building `@dbx-tools/*` UI packages.
 * Import from `@dbx-tools/ui-appkit/vite` so Tailwind and React refresh resolve
 * from this package's dependencies, not the host's.
 *
 * @module
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { PluginOption } from "vite";

/** React + Tailwind v4 plugins for a standard AppKit UI Vite app. */
export function appkitUiVitePlugins(): PluginOption[] {
  return [react(), tailwindcss()];
}
