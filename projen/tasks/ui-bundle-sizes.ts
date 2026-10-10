import { resolve } from "node:path";
import { runTaskMain } from "./cli.ts";

const entries = {
  auth: "packages/js/ui/appkit/src/auth/react/index.ts",
  email: "packages/js/ui/appkit/src/email/react/index.ts",
  search: "packages/js/ui/appkit/src/search/react/index.ts",
} as const;

export async function main(): Promise<void> {
  for (const [name, entry] of Object.entries(entries)) {
    const result = await Bun.build({
      entrypoints: [resolve(entry)],
      target: "browser",
      minify: true,
      sourcemap: "none",
      external: ["react", "react-dom", "@databricks/*", "@dbx-tools/shared-*", "lucide-react"],
    });
    if (!result.success) {
      throw new AggregateError(result.logs, `Could not build the ${name} UI subpath`);
    }
    const bytes = result.outputs.reduce((total, output) => total + output.size, 0);
    console.log(`${name}: ${bytes} bytes`);
  }
}

await runTaskMain(import.meta, main);
