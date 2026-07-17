/**
 * Unmanaged Vite override for the demo app.
 *
 * The projen-owned, read-only `vite.config.ts` beside this file merges this
 * module's default export over the generated config at Vite startup (later wins;
 * `plugins` arrays concatenate). Edit or delete this file freely - it is NOT
 * managed by projen.
 *
 * The generated config already supplies the React refresh plugin, so here we
 * only add Tailwind v4 (`@tailwindcss/vite`) - which processes `src/index.css`'s
 * `@import` of the feature UI stylesheets (they use Tailwind `@source`) with no
 * separate Tailwind CLI step - plus the `@` -> `src` path alias.
 */
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

/** @type {import("vite").UserConfig} */
export default {
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
};
