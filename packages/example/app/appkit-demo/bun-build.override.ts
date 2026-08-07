import { createRequire } from "node:module";
import type { BunPlugin } from "bun";

const require = createRequire(import.meta.url);
const entries = new Map(
  ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"].map(
    (specifier) => [specifier, require.resolve(specifier)],
  ),
);

const dedupeReact: BunPlugin = {
  name: "dedupe-react",
  setup(build) {
    build.onResolve({ filter: /^react(?:-dom)?(?:\/.*)?$/ }, ({ path }) => {
      const resolved = entries.get(path);
      return resolved ? { path: resolved } : undefined;
    });
  },
};

export default { plugins: [dedupeReact] };
