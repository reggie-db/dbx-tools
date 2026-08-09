#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, ".docs-build", "site", "src", "content", "docs");
const markdownTitle = /`|\[[^\]]+\]\([^)]+\)|(?:^|\s)[*_~](?=\S)/;
const failures = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    const match = fs.readFileSync(file, "utf8").match(/^title:\s*(.+)$/m);
    if (!match) {
      failures.push(`${path.relative(root, file)}: missing title`);
      continue;
    }
    const title = JSON.parse(match[1]);
    if (markdownTitle.test(title)) {
      failures.push(`${path.relative(root, file)}: Markdown in title ${JSON.stringify(title)}`);
    }
  }
}

if (!fs.existsSync(docsRoot)) {
  throw new Error(`Missing generated docs at ${path.relative(root, docsRoot)}`);
}

walk(docsRoot);
if (failures.length) throw new Error(`Invalid generated docs titles:\n${failures.join("\n")}`);
console.log("Generated docs titles are plain text");
