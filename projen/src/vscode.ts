/**
 * Root `.vscode/*` files: settings, extension recommendations, and tasks.
 *
 * Prettier is projen's built-in component (not emitted here). The auto-run watcher
 * is delivered by `.vscode/tasks.json` (`runOn: folderOpen`) - projen has no native
 * tasks.json component, so a `JsonFile` is the idiomatic emitter.
 */
import { existsSync, readFileSync } from "node:fs";

import { Component, JsonFile, javascript } from "projen";
import { flattenDiagnosticMessageText, parseConfigFileTextToJson } from "typescript";

const PROJEN_JSON_MARKER = "//";

function objectFilePath(key: string): string {
  return key.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
}

function existingSettings(path: string): Record<string, unknown> {
  const parsed = parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(
      `Cannot preserve VS Code settings from ${path}: ${flattenDiagnosticMessageText(parsed.error.messageText, "\n")}`,
    );
  }
  if (!parsed.config || typeof parsed.config !== "object" || Array.isArray(parsed.config)) {
    throw new Error(`Cannot preserve VS Code settings from ${path}: expected a JSON object`);
  }
  return parsed.config as Record<string, unknown>;
}

class EditableVsCodeSettings extends Component {
  constructor(
    scope: javascript.NodeProject,
    private readonly file: JsonFile,
  ) {
    super(scope);
    this.file.readonly = false;
  }

  override preSynthesize(): void {
    if (!existsSync(this.file.absolutePath)) return;
    for (const [key, value] of Object.entries(existingSettings(this.file.absolutePath))) {
      if (key === PROJEN_JSON_MARKER) continue;
      this.file.addOverride(objectFilePath(key), value);
    }
  }
}

/** Configure the native Projen VS Code component and the unsupported tasks file. */
export function configureVsCode(scope: javascript.NodeProject): void {
  const editor = scope.vscode;
  if (!editor) return;
  new EditableVsCodeSettings(scope, editor.settings.file);
  editor.settings.addSettings({
    "typescript.tsdk": "node_modules/typescript/lib",
    "typescript.preferences.importModuleSpecifier": "non-relative",
    "javascript.preferences.importModuleSpecifier": "non-relative",
    "editor.formatOnSave": true,
    "editor.defaultFormatter": "esbenp.prettier-vscode",
    "editor.codeActionsOnSave": {
      "source.fixAll.eslint": "explicit",
    },
    "[python]": {
      "editor.defaultFormatter": "charliermarsh.ruff",
      "editor.formatOnSave": true,
      "editor.codeActionsOnSave": {
        "source.fixAll.ruff": "explicit",
      },
    },
    "notebook.formatOnSave.enabled": true,
    "notebook.defaultFormatter": "charliermarsh.ruff",
    "files.watcherExclude": {
      "**/node_modules/**": true,
      "**/dist/**": true,
    },
    "search.exclude": {
      "**/.prettierrc.json": true,
      "**/eslintrc.json": true,
      "docs/**/archived/**": true,
    },
  });
  editor.extensions.addRecommendations(
    "esbenp.prettier-vscode",
    "dbaeumer.vscode-eslint",
    "charliermarsh.ruff",
  );

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
