/**
 * Fine-grained Shiki runtime containing only the chat's supported languages.
 *
 * This module is itself dynamically imported, so its grammar, theme, and WASM
 * dependencies remain off the network until a supported code block appears.
 */
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import bash from "shiki/langs/bash.mjs";
import javascript from "shiki/langs/javascript.mjs";
import json from "shiki/langs/json.mjs";
import markdown from "shiki/langs/markdown.mjs";
import python from "shiki/langs/python.mjs";
import sql from "shiki/langs/sql.mjs";
import typescript from "shiki/langs/typescript.mjs";
import yaml from "shiki/langs/yaml.mjs";
import githubLight from "shiki/themes/github-light.mjs";

/** Create the shared highlighter with the exact configured language set. */
export function createHighlighter() {
  return createHighlighterCore({
    themes: [githubLight],
    langs: [sql, python, typescript, javascript, json, bash, yaml, markdown],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  });
}
