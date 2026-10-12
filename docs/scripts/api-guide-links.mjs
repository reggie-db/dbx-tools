import fs from "node:fs";
import path from "node:path";

const SYMBOL_TITLE = /^(?:Class|Enumeration|Function|Interface|Type Alias|Variable):\s+(.+?)(?:\(\))?$/;
const PUBLIC_EXPORT_ROW = /^\| `([A-Za-z_$][\w$]*)` \|/gm;

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function route(base, packageSlug, page, fragment = "") {
  const prefix = base ? `/${base.replace(/^\/+|\/+$/g, "")}` : "";
  const suffix = page === "index" ? "" : `${page}/`;
  return `${prefix}/api/${packageSlug}/${suffix}${fragment}`;
}

function title(markdown) {
  return markdown.match(/^title:\s+["']?(.+?)["']?\s*$/m)?.[1];
}

function addUnique(map, name, target) {
  const existing = map.get(name);
  if (existing === undefined) {
    map.set(name, target);
  } else if (existing !== target) {
    map.set(name, null);
  }
}

/** Build exact public-symbol links from generated TypeScript or Python API pages. */
export function apiSymbolLinks(apiDirectory, packageSlug, base = "") {
  const links = new Map();
  if (!fs.existsSync(apiDirectory)) return links;

  for (const entry of fs.readdirSync(apiDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(apiDirectory, entry.name);
    const markdown = read(file);
    const page = path.basename(entry.name, ".md");
    const symbolTitle = title(markdown)?.match(SYMBOL_TITLE)?.[1];
    if (symbolTitle) addUnique(links, symbolTitle, route(base, packageSlug, page));

    if (page === "index") {
      for (const match of markdown.matchAll(PUBLIC_EXPORT_ROW)) {
        const symbol = match[1];
        addUnique(
          links,
          symbol,
          route(base, packageSlug, page, `#${symbol.toLowerCase()}`),
        );
      }
    }
  }

  return new Map([...links].filter((entry) => entry[1] !== null));
}

/** Link the first bare public identifier in each H2 section to its generated API page. */
export function linkPackageGuideApi(markdown, symbolLinks, maxLinksPerSection = 6) {
  let fenced = false;
  let linkedInSection = 0;
  let seen = new Set();

  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      if (/^##\s+/.test(line)) {
        linkedInSection = 0;
        seen = new Set();
        return line;
      }
      if (/^#/.test(line)) return line;

      for (const match of line.matchAll(/\[`([A-Za-z_$][\w$]*)(?:\(\))?`\]\([^)]+\)/g)) {
        seen.add(match[1]);
      }

      return line.replace(
        /(?<!\[)`([A-Za-z_$][\w$]*)(\(\))?`(?!\]\()/g,
        (match, symbol, call = "") => {
          const target = symbolLinks.get(symbol);
          if (!target || seen.has(symbol) || linkedInSection >= maxLinksPerSection) return match;
          seen.add(symbol);
          linkedInSection += 1;
          return `[\`${symbol}${call}\`](${target})`;
        },
      );
    })
    .join("\n");
}

/** Add a task-guide backlink near the top of one generated API landing page. */
export function addApiGuideLink(markdown, packageName, guideRoute) {
  if (markdown.includes(`](${guideRoute})`)) return markdown;
  const sentence = `For setup, workflows, and operational guidance, see the [${packageName} package guide](${guideRoute}).`;
  const generatedComment = /<!--\n[\s\S]*?-->\n/;
  if (generatedComment.test(markdown)) {
    return markdown.replace(generatedComment, (comment) => `${comment}\n${sentence}\n`);
  }
  return `${sentence}\n\n${markdown}`;
}
