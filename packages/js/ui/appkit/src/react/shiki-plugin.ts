import { stringUtils } from "@dbx-tools/shared-core";
import type { BundledLanguage, BundledTheme } from "shiki";
import type { HighlighterCore } from "shiki/core";
import type { CodeHighlighterPlugin } from "streamdown";

// Streamdown 2.x ships syntax highlighting as an opt-in plugin and has
// no shiki dependency of its own; without a `code` plugin every fenced
// block renders as uncolored plaintext. This module provides a small
// shiki-backed highlighter to wire in via `plugins={{ code }}`.

/**
 * Languages we highlight in the chat. SQL is the primary one (Genie
 * query previews); the rest cover code the assistant might emit. Kept
 * to a curated set so shiki only bundles these grammars.
 */
const LANGUAGES = [
  "text",
  "plaintext",
  "txt",
  "sql",
  "python",
  "typescript",
  "javascript",
  "json",
  "bash",
  "yaml",
  "markdown",
] as const;

/** High-contrast theme pair used for every syntax surface. */
const THEMES = [
  "github-light-high-contrast",
  "github-dark-high-contrast",
] as const satisfies readonly [BundledTheme, BundledTheme];

/** Languages we can tokenize, as a set for O(1) support checks. */
const SUPPORTED = new Set<string>(LANGUAGES);

let _highlighter: HighlighterCore | null = null;
let _loading: Promise<HighlighterCore> | null = null;

/** Lazily create the shared shiki highlighter (singleton, loaded once). */
function loadHighlighter(): Promise<HighlighterCore> {
  _loading ??= import("./_shiki-runtime.ts")
    .then(({ createHighlighter }) => createHighlighter())
    .then((highlighter) => {
      _highlighter = highlighter;
      return highlighter;
    });
  return _loading;
}

function splitThemeColor(
  value: string | undefined,
  darkVariable: "--shiki-dark" | "--shiki-dark-bg",
): { light?: string; dark?: string } {
  if (!value) return {};
  const marker = `;${darkVariable}:`;
  const index = value.indexOf(marker);
  if (index < 0) return { light: value };
  return {
    light: value.slice(0, index),
    dark: value.slice(index + marker.length),
  };
}

/** Tokenize `code` with the active themes into Streamdown's result shape. */
function highlightTokens(h: HighlighterCore, code: string, language: string) {
  const { tokens, fg, bg, rootStyle } = h.codeToTokens(code, {
    lang: language as BundledLanguage,
    themes: { light: THEMES[0], dark: THEMES[1] },
  });
  const foreground = splitThemeColor(fg, "--shiki-dark");
  const background = splitThemeColor(bg, "--shiki-dark-bg");
  const darkStyles = [
    foreground.dark ? `--shiki-dark:${foreground.dark}` : "",
    background.dark ? `--shiki-dark-bg:${background.dark}` : "",
  ]
    .filter(Boolean)
    .join(";");
  return {
    tokens,
    fg: foreground.light,
    bg: background.light,
    rootStyle: [rootStyle, darkStyles].filter(Boolean).join(";"),
  };
}

/** Escape HTML-significant characters (from the shared string utils). */
const escapeHtml = stringUtils.escapeHtml;

/**
 * Highlight `code` into minimal inline HTML: one colored `<span>` per
 * token, lines joined by real newlines, with no line-number gutter or
 * per-line wrapper elements. Meant to drop straight into a
 * `<pre><code>` so the rendered text stays cleanly selectable and
 * copyable. Falls back to plain escaped text when the language isn't
 * supported or shiki fails to parse the snippet.
 */
export async function highlightToHtml(code: string, language: string): Promise<string> {
  if (!SUPPORTED.has(language)) return escapeHtml(code);
  const h = await loadHighlighter();
  try {
    const { tokens } = highlightTokens(h, code, language);
    return tokens
      .map((line) =>
        line
          .map((token) => {
            const light = token.htmlStyle?.color ?? token.color ?? "inherit";
            const dark = token.htmlStyle?.["--shiki-dark"] ?? light;
            const style = `--sdm-c:${light};--shiki-dark:${dark}`;
            return `<span style="${escapeHtml(style)}">${escapeHtml(token.content)}</span>`;
          })
          .join(""),
      )
      .join("\n");
  } catch {
    return escapeHtml(code);
  }
}

/**
 * shiki-backed code highlighter plugin for Streamdown. The highlighter
 * loads asynchronously: the first call for any block returns `null`
 * and resolves through the `callback` once shiki is ready, after which
 * results are synchronous. Unsupported languages return `null` so the
 * block stays plaintext rather than throwing.
 */
export function createShikiPlugin(): CodeHighlighterPlugin {
  const isSupported = (language: string): boolean => SUPPORTED.has(language);

  return {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => [...LANGUAGES],
    getThemes: () => [...THEMES],
    supportsLanguage: (language) => isSupported(language),
    highlight: (options, callback) => {
      if (!isSupported(options.language)) return null;
      const language = options.language;
      if (_highlighter) {
        try {
          return highlightTokens(_highlighter, options.code, language);
        } catch {
          return null;
        }
      }
      void loadHighlighter().then((h) => {
        try {
          callback?.(highlightTokens(h, options.code, language));
        } catch {
          // Parse failure for this block - leave it as plaintext.
        }
      });
      return null;
    },
  };
}
