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
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";

const require = createRequire(import.meta.url);
const appRoot = fileURLToPath(new URL(".", import.meta.url));

// When `@dbx-tools/ui-mastra` is `pnpm link`ed to local source (dev loop), it
// resolves React from the linked package's own tree, giving the app TWO React
// instances and the "Cannot read properties of null (reading 'useState')"
// invalid-hook-call crash. `dedupe` + a directory alias pin react/react-dom to
// this app's single copy so the linked package and the app share one React.
// Aliased to the package DIRECTORY (not index.js) so subpaths like
// `react/jsx-runtime` still resolve. Harmless when unlinked.
const pkgDir = (id) =>
  dirname(require.resolve(`${id}/package.json`, { paths: [appRoot] }));

/** @type {import("vite").UserConfig} */
export default {
  plugins: [tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      react: pkgDir("react"),
      "react-dom": pkgDir("react-dom"),
    },
  },
};
