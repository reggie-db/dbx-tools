import { createRequire } from "node:module";
import { resolve } from "node:path";

const [library, output, tools] = process.argv.slice(2).map((value) => resolve(value));
const require = createRequire(`${tools}/package.json`);
const { build } = require("vite");
const react = require("@vitejs/plugin-react").default;
await build({
  root: library,
  configFile: false,
  plugins: [react()],
  build: {
    outDir: output,
    emptyOutDir: true,
    lib: { entry: `${library}/api.js`, formats: ["es"], fileName: "library" },
    rollupOptions: { external: (specifier: string) => !specifier.startsWith(".") && !specifier.startsWith("/") },
  },
});
