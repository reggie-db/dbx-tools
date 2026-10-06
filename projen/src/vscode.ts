/**
 * Root `.vscode/*` files: settings, extension recommendations, and tasks.
 *
 * Prettier is projen's built-in component (not emitted here). The auto-run watcher
 * is delivered by `.vscode/tasks.json` (`runOn: folderOpen`) - projen has no native
 * tasks.json component, so a `JsonFile` is the idiomatic emitter.
 */
import { JsonFile, javascript } from "projen";

/** Configure the native Projen VS Code component and the unsupported tasks file. */
export function configureVsCode(scope: javascript.NodeProject): void {
  const editor = scope.vscode;
  if (!editor) return;
  editor.settings.addSettings({
    "typescript.tsdk": "node_modules/typescript/lib",
    "typescript.preferences.importModuleSpecifier": "non-relative",
    "javascript.preferences.importModuleSpecifier": "non-relative",
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "files.watcherExclude": {
      "**/node_modules/**": true,
      "**/dist/**": true,
    },
  });
  editor.extensions.addRecommendations("esbenp.prettier-vscode");

  new JsonFile(scope, ".vscode/tasks.json", {
    marker: false,
    readonly: true,
    obj: {
      version: "2.0.0",
      tasks: [
        {
          label: "sync",
          detail:
            "projen sync --watch - projenrc (.projenrc.ts + syncResynthPaths re-synth) + barrel watcher",
          type: "shell",
          command: "bun run sync -- --watch",
          isBackground: true,
          problemMatcher: [],
          runOptions: { runOn: "folderOpen" },
          presentation: {
            reveal: "always",
            panel: "dedicated",
            group: "projen",
          },
        },
        {
          label: "synth",
          detail: "projen - synthesize all generated config",
          type: "shell",
          command: "bun run default",
          problemMatcher: [],
        },
      ],
    },
  });
}
