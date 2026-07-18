/**
 * Client-side chat export.
 *
 * Turns chat messages into a portable, self-contained document at either
 * the single-message or the whole-conversation level, in one of two
 * formats:
 *
 *   - `"pdf"`   - a print-ready HTML document rendered in a hidden iframe
 *                 with the browser's print dialog triggered, so the user
 *                 saves a real PDF ("Save as PDF") with no popup tab.
 *   - `"markdown"` - a `.md` file download.
 *
 * The document can be brand-styled (logo, colors, font) via the optional
 * `brand` option; the driver resolves it from `@dbx-tools/ui-branding`.
 *
 * Charts are included, not dropped: each `[chart:<id>]` marker is
 * resolved against the plugin's chart cache and rendered to an inline
 * SVG via Echarts' server-side renderer (no DOM needed), so a PDF/HTML
 * export carries the chart itself rather than a placeholder.
 * `[data:<id>]` markers resolve to a real table. Unresolved / expired
 * ids are skipped so the surrounding prose stays clean.
 */

import {
  marker as markers,
  type Chart,
  type StatementData,
} from "@dbx-tools/shared-mastra";
import { string } from "@dbx-tools/shared-core";
import type { UIMessage } from "ai";
import * as echarts from "echarts";
import { marked } from "marked";
import { normalizeChartOption } from "./chart-option";

/**
 * Output formats {@link exportChat} can produce.
 *   - `"pdf"`   - Save-as-PDF via a hidden print iframe (dialog defaults to
 *                 "Save as PDF"); no new tab.
 *   - `"markdown"` - a `.md` file download.
 */
export type ExportFormat = "pdf" | "markdown";

/**
 * Optional brand styling for the exported document. Plain data (no React /
 * DOM), so this module stays framework-free; the driver resolves it from
 * `@dbx-tools/ui-branding` (`useBrand()` + `resolveBrandAsset`) and passes it
 * through. Any field omitted falls back to the neutral default styling.
 */
export interface ExportBrand {
  /** Logo image src (a data URL) rendered in the document header. */
  logoDataUrl?: string;
  /** Primary brand color for the header rule, headings, and role labels. */
  primary?: string;
  /** Accent brand color (links). */
  accent?: string;
  /** Body text color. */
  foreground?: string;
  /** Sans-serif font stack for the document body. */
  fontSans?: string;
}

/**
 * Resolves the embeds referenced by `[chart:<id>]` / `[data:<id>]`
 * markers in message prose. Satisfied by `MastraPluginClient` (its
 * `chart` / `statement` methods) - the driver passes those straight
 * through.
 */
export interface EmbedResolver {
  chart(id: string): Promise<Chart | undefined>;
  statement(id: string): Promise<StatementData | undefined>;
}

/** Options accepted by {@link exportChat}. */
export interface ExportChatOptions {
  /** Messages to export, oldest first (one entry for a message-level export). */
  messages: UIMessage[];
  /** Target format. */
  format: ExportFormat;
  /** Embed resolver used to inline charts and data tables. */
  resolver: EmbedResolver;
  /** Document title / heading. Defaults to `"Conversation"`. */
  title?: string;
  /** Download filename stem (no extension). Defaults to a slug of the title. */
  filename?: string;
  /**
   * Label for the human speaker (the `user` role). Defaults to
   * `"User"`; callers that know the signed-in identity pass a resource
   * id / email form like `"User (someone@example.com)"`.
   */
  userLabel?: string;
  /** Optional brand styling for the exported document. */
  brand?: ExportBrand;
}

/** Fixed Echarts SSR canvas; the SVG scales to the print column via CSS. */
const CHART_WIDTH_PX = 760;
const CHART_HEIGHT_PX = 380;

/** Delay before firing `print()` so the new tab lays the document out first. */
const PRINT_SETTLE_MS = 300;

/**
 * Export `messages` as a PDF or a Markdown file.
 *
 * `"pdf"` renders a branded, self-contained HTML document and drives it
 * through a hidden `<iframe>` + `print()` - so the browser's print dialog
 * (defaulting to "Save as PDF") opens directly, with no popup tab. If the
 * iframe path can't run (e.g. no DOM body), the document is downloaded as a
 * self-contained `.html` file so the export - charts included - still lands.
 */
export async function exportChat(options: ExportChatOptions): Promise<void> {
  const { messages, format, resolver } = options;
  const title = options.title?.trim() || "Conversation";
  const stem = options.filename?.trim() || slugify(title);
  const userLabel = options.userLabel?.trim() || "User";

  if (format === "markdown") {
    const md = await buildMarkdown(messages, resolver, title, userLabel);
    downloadTextFile(`${stem}.md`, md, "text/markdown;charset=utf-8");
    return;
  }

  // pdf: build the branded document, then print it from a hidden iframe so
  // the Save-as-PDF dialog opens without a stray tab.
  const html = await buildHtmlDocument(messages, resolver, title, userLabel, options.brand);
  printViaHiddenIframe(html, `${stem}.html`);
}

/**
 * Render `html` in an off-screen iframe and trigger its print dialog. The
 * iframe is same-origin via `srcdoc`, so `contentWindow.print()` is allowed;
 * it's removed after printing. Falls back to a file download when there's no
 * document body to attach to.
 */
function printViaHiddenIframe(html: string, downloadName: string): void {
  if (typeof document === "undefined" || !document.body) {
    downloadTextFile(downloadName, html, "text/html;charset=utf-8");
    return;
  }
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.srcdoc = html;

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.setTimeout(() => iframe.remove(), 1000);
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      downloadTextFile(downloadName, html, "text/html;charset=utf-8");
      return;
    }
    // Settle so charts / fonts lay out, then print. `afterprint` removes the
    // iframe once the dialog closes; a 60s timer backstops browsers that don't
    // fire it. The backstop is armed BEFORE `print()` so a throw (sandboxed /
    // policy-restricted frames can reject `print()`) still cleans up, and the
    // export falls back to a file download rather than silently vanishing.
    win.addEventListener("afterprint", cleanup);
    win.setTimeout(() => {
      window.setTimeout(cleanup, 60000);
      try {
        win.focus();
        win.print();
      } catch {
        cleanup();
        downloadTextFile(downloadName, html, "text/html;charset=utf-8");
      }
    }, PRINT_SETTLE_MS);
  };

  document.body.appendChild(iframe);
}

/* ------------------------------- segments -------------------------------- */

/** One slice of a message: prose, a chart embed, or a data embed. */
type Segment =
  | { kind: "text"; text: string }
  | { kind: "chart"; id: string }
  | { kind: "data"; id: string };

/**
 * Split message text into prose / chart / data segments at
 * `[chart:<uuid>]` / `[data:<uuid>]` marker positions. Mirrors the live
 * `MarkdownWithEmbeds` splitter so an export matches what's on screen:
 * non-UUID (fabricated) ids and unknown marker types collapse away so no
 * literal `[type:...]` leaks into the output.
 */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const marker of markers.parseMarkers(text)) {
    if (marker.start > last) {
      segments.push({ kind: "text", text: text.slice(last, marker.start) });
    }
    if (markers.isUuid(marker.id) && (marker.type === "chart" || marker.type === "data")) {
      segments.push({ kind: marker.type, id: marker.id });
    }
    last = marker.end;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** Concatenate a message's `text` parts (matches the on-screen bubbles). */
function messageText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

/**
 * Human label for a message role. The `user` role uses `userLabel`
 * (the signed-in identity, e.g. `"User (someone@example.com)"`);
 * `assistant` is fixed; any other role is title-cased.
 */
function roleLabel(role: UIMessage["role"], userLabel: string): string {
  if (role === "user") return userLabel;
  if (role === "assistant") return "Assistant";
  return string.capitalize(role);
}

/* --------------------------------- HTML ---------------------------------- */

/** Build the full standalone HTML document string. */
async function buildHtmlDocument(
  messages: UIMessage[],
  resolver: EmbedResolver,
  title: string,
  userLabel: string,
  brand?: ExportBrand,
): Promise<string> {
  const articles: string[] = [];
  for (const message of messages) {
    const body = await messageBodyHtml(message, resolver);
    if (!body) continue;
    articles.push(
      `<article class="msg msg-${escapeHtml(message.role)}">` +
        `<div class="role">${escapeHtml(roleLabel(message.role, userLabel))}</div>` +
        `<div class="content">${body}</div></article>`,
    );
  }
  const logo = brand?.logoDataUrl
    ? `<img class="doc-logo" src="${escapeHtml(brand.logoDataUrl)}" alt="">`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${buildDocumentCss(brand)}</style></head>` +
    `<body><header class="doc-header">${logo}<h1>${escapeHtml(title)}</h1>` +
    `<div class="doc-meta">Exported ${escapeHtml(new Date().toLocaleString())}</div>` +
    `</header><main>${articles.join("")}</main></body></html>`
  );
}

/** Render one message's body (prose + inlined charts / tables) to HTML. */
async function messageBodyHtml(
  message: UIMessage,
  resolver: EmbedResolver,
): Promise<string> {
  const isAssistant = message.role === "assistant";
  const parts: string[] = [];
  for (const seg of splitSegments(messageText(message))) {
    if (seg.kind === "text") {
      if (!seg.text.trim()) continue;
      parts.push(
        isAssistant
          ? markdownToHtml(seg.text)
          : `<p class="plain">${escapeHtml(seg.text)}</p>`,
      );
      continue;
    }
    if (seg.kind === "chart") {
      const svg = await chartSvg(resolver, seg.id);
      if (svg) parts.push(`<div class="embed embed-chart">${svg}</div>`);
      continue;
    }
    const table = await dataTableHtml(resolver, seg.id);
    if (table) parts.push(table);
  }
  return parts.join("\n");
}

/** Render a markdown fragment to an HTML string (GFM tables, line breaks). */
function markdownToHtml(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: true }) as string;
}

/**
 * Resolve a chart id and render its Echarts spec to an inline SVG string
 * via server-side rendering (no DOM). The JSON-safe planner spec is run
 * through {@link normalizeChartOption} first - same as the live inline
 * chart - so the export gets compact value ticks, conventionally-placed
 * axis names, and legible category labels rather than a raw spec. Returns
 * `null` when the id is unknown / expired / still processing, or if
 * rendering throws.
 */
async function chartSvg(resolver: EmbedResolver, id: string): Promise<string | null> {
  try {
    const chart = await resolver.chart(id);
    if (!chart?.result) return null;
    const instance = echarts.init(null, undefined, {
      renderer: "svg",
      ssr: true,
      width: CHART_WIDTH_PX,
      height: CHART_HEIGHT_PX,
    });
    try {
      instance.setOption(
        normalizeChartOption(chart.result.option) as echarts.EChartsCoreOption,
      );
      return instance.renderToSVGString();
    } finally {
      instance.dispose();
    }
  } catch {
    return null;
  }
}

/** Resolve a data id and render its rows to an HTML table. `null` on miss. */
async function dataTableHtml(
  resolver: EmbedResolver,
  id: string,
): Promise<string | null> {
  const data = await safeStatement(resolver, id);
  if (!data || data.rows.length === 0) return null;
  const head = data.columns
    .map((c) => `<th>${escapeHtml(string.toLabel(c))}</th>`)
    .join("");
  const body = data.rows
    .map(
      (row) =>
        `<tr>${data.columns
          .map((c) => `<td>${escapeHtml(cellText(row[c]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const note = data.truncated
    ? `<div class="embed-note">Showing ${data.rows.length} of ${data.rowCount} rows.</div>`
    : "";
  return (
    `<div class="embed embed-table"><table><thead><tr>${head}</tr></thead>` +
    `<tbody>${body}</tbody></table>${note}</div>`
  );
}

/* ------------------------------- Markdown -------------------------------- */

/** Build the whole document as a Markdown string. */
async function buildMarkdown(
  messages: UIMessage[],
  resolver: EmbedResolver,
  title: string,
  userLabel: string,
): Promise<string> {
  const blocks: string[] = [`# ${title}`, `_Exported ${new Date().toLocaleString()}_`];
  for (const message of messages) {
    const body = await messageBodyMarkdown(message, resolver);
    if (!body.trim()) continue;
    blocks.push(`## ${roleLabel(message.role, userLabel)}`);
    blocks.push(body);
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Render one message's body to Markdown (charts noted, tables as GFM). */
async function messageBodyMarkdown(
  message: UIMessage,
  resolver: EmbedResolver,
): Promise<string> {
  const parts: string[] = [];
  for (const seg of splitSegments(messageText(message))) {
    if (seg.kind === "text") {
      if (seg.text.trim()) parts.push(seg.text.trim());
      continue;
    }
    if (seg.kind === "chart") {
      const chart = await safeChart(resolver, seg.id);
      if (chart?.result) parts.push(`> **Chart:** ${chartTitle(chart)}`);
      continue;
    }
    const table = await dataTableMarkdown(resolver, seg.id);
    if (table) parts.push(table);
  }
  return parts.join("\n\n");
}

/** Best-effort chart title from the Echarts spec, for the Markdown note. */
function chartTitle(chart: Chart): string {
  const option = chart.result?.option as { title?: unknown } | undefined;
  const title = option?.title;
  const text =
    (Array.isArray(title) ? title[0]?.text : (title as { text?: unknown })?.text) ??
    undefined;
  const label = typeof text === "string" ? text.trim() : "";
  return label || `${chart.result?.chartType ?? "chart"} chart`;
}

/** Render statement rows to a GFM table. `null` on miss / empty. */
async function dataTableMarkdown(
  resolver: EmbedResolver,
  id: string,
): Promise<string | null> {
  const data = await safeStatement(resolver, id);
  if (!data || data.rows.length === 0) return null;
  const header = `| ${data.columns.map((c) => mdCell(string.toLabel(c))).join(" | ")} |`;
  const sep = `| ${data.columns.map(() => "---").join(" | ")} |`;
  const rows = data.rows.map(
    (row) => `| ${data.columns.map((c) => mdCell(cellText(row[c]))).join(" | ")} |`,
  );
  const note = data.truncated
    ? `\n\n_Showing ${data.rows.length} of ${data.rowCount} rows._`
    : "";
  return `${[header, sep, ...rows].join("\n")}${note}`;
}

/* -------------------------------- helpers -------------------------------- */

/** Resolve a chart id, swallowing errors (best-effort export). */
async function safeChart(
  resolver: EmbedResolver,
  id: string,
): Promise<Chart | undefined> {
  try {
    return await resolver.chart(id);
  } catch {
    return undefined;
  }
}

/** Resolve a statement id, swallowing errors (best-effort export). */
async function safeStatement(
  resolver: EmbedResolver,
  id: string,
): Promise<StatementData | undefined> {
  try {
    return await resolver.statement(id);
  } catch {
    return undefined;
  }
}

/** Stringify a table cell value for display. */
function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Escape a Markdown table cell (pipes / newlines would break the row). */
function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Escape HTML-significant characters (from the shared string utils). */
const escapeHtml = string.escapeHtml;

/** Turn a title into a safe, lowercase filename stem. */
function slugify(value: string): string {
  return string.toSlugWithOptions({ maxLength: 60 }, value) || "conversation";
}

/** Trigger a browser download of an in-memory text file. */
function downloadTextFile(filename: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A brand color / font value safe to interpolate into a `<style>` block.
 * Brand colors are hex-validated upstream, but the font stack is only checked
 * for non-blankness, so strip the characters that could close a declaration or
 * rule (`{ } ; < > \` plus HTML-comment openers) to prevent CSS injection into
 * the export document. Falls back to `fallback` when the value is blank.
 */
function cssValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const safe = trimmed.replace(/[{}<>;\\]/g, "");
  return safe || fallback;
}

/**
 * Build the inline stylesheet for the exported document, folding in optional
 * brand color / font overrides (falling back to the neutral slate/blue theme
 * and a system font stack). Tuned for print:
 *
 *   - A readable measure with role-labelled message blocks.
 *   - Content flows naturally across pages: whole messages are NOT
 *     `break-inside: avoid` (a long turn that couldn't fit the
 *     remaining space would otherwise be shoved to the next page,
 *     leaving the current one half-blank). Only atomic units stay
 *     unbroken - a chart image, a code block, and individual table
 *     rows - while long tables split across pages and repeat their
 *     header (`thead { display: table-header-group }`).
 *   - `@page { margin: 0 }` collapses the page margin box so the
 *     browser's own print header/footer (the source URL, the
 *     date, and `n/N` page numbers) have nowhere to render and drop
 *     out; the visible page margin is re-supplied as body padding.
 */
function buildDocumentCss(brand?: ExportBrand): string {
  const fg = cssValue(brand?.foreground, "#0f172a");
  const primary = cssValue(brand?.primary, "#0f172a");
  const link = cssValue(brand?.accent, "#2563eb");
  const font = cssValue(
    brand?.fontSans,
    'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  );
  return `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.6 ${font};
    color: ${fg}; margin: 0; padding: 32px; background: #fff;
  }
  main { max-width: 820px; margin: 0 auto; }
  .doc-header { max-width: 820px; margin: 0 auto 24px; border-bottom: 2px solid ${primary}; padding-bottom: 12px; }
  .doc-logo { height: 28px; width: auto; display: block; margin: 0 0 10px; }
  .doc-header h1 { font-size: 22px; margin: 0 0 4px; color: ${primary}; }
  .doc-meta { font-size: 12px; color: #64748b; }
  .msg { margin: 0 0 20px; }
  .msg .role { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: ${primary}; margin-bottom: 4px; break-after: avoid; }
  .msg-user .content { background: #f1f5f9; border-radius: 8px; padding: 10px 14px; }
  .msg .content > *:first-child { margin-top: 0; }
  .msg .content > *:last-child { margin-bottom: 0; }
  .plain { white-space: pre-wrap; margin: 0; }
  p { margin: 0 0 10px; }
  h1, h2, h3, h4 { line-height: 1.3; margin: 18px 0 8px; break-after: avoid; break-inside: avoid; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: #f1f5f9; padding: .1em .3em; border-radius: 4px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 8px; overflow-x: auto; break-inside: avoid; }
  pre code { background: none; padding: 0; color: inherit; }
  a { color: ${link}; }
  .embed { margin: 12px 0; }
  .embed-chart { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; break-inside: avoid; }
  .embed-chart svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  th, td { border: 1px solid #e2e8f0; padding: 6px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  .embed-note { font-size: 12px; color: #64748b; margin-top: 6px; }
  @page { margin: 0; }
  @media print {
    body { padding: 16mm 18mm; }
    a { color: inherit; text-decoration: none; }
  }
`;
}
