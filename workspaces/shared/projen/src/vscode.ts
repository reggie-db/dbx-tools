/**
 * Root `.vscode/*` files: settings, extension recommendations, and tasks.
 *
 * Prettier is projen's built-in component (not emitted here). The auto-run watcher
 * is delivered by `.vscode/tasks.json` (`runOn: folderOpen`) - projen has no native
 * tasks.json component, so a `JsonFile` is the idiomatic emitter.
 */
import { Component, JsonFile, type Project, vscode } from "projen";

/**
 * Configures root `.vscode/settings.json`, `extensions.json`, and `tasks.json`.
 * Only a tree ROOT constructs this component (see {@link DBXToolsNodeProject}).
 */
export class DBXToolsVsCode extends Component {
  /** projen's built-in VsCode component (settings + extension recommendations). */
  readonly vsCode: vscode.VsCode;

  constructor(scope: Project) {
    super(scope);

    this.vsCode = new vscode.VsCode(scope);
    this.vsCode.settings.addSettings({
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
    this.vsCode.extensions.addRecommendations("esbenp.prettier-vscode");
    this.vsCode.settings.file.readonly = true;
    this.vsCode.extensions.file.readonly = true;

    new JsonFile(scope, ".vscode/tasks.json", {
      marker: false,
      readonly: true,
      obj: {
        version: "2.0.0",
        tasks: [
          {
            label: "sync",
            detail: "projen sync --watch - concurrently: projen --watch (re-synth) + barrels + openapi watchers",
            type: "shell",
            command: "pnpm exec projen sync --watch",
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
            command: "pnpm exec projen",
            problemMatcher: [],
          },
        ],
      },
    });
  }
}
