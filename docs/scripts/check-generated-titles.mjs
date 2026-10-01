#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { walk } from "./repository-docs.mjs";

const root = process.cwd();
const docsRoot = path.join(root, ".docs-build", "site", "src", "content", "docs");
const markdownTitle = /`|\[[^\]]+\]\([^)]+\)|(?:^|\s)[*_~](?=\S)/;
const failures = [];

function checkTitles(directory) {
  for (const file of walk(directory)) {
    if (path.extname(file) !== ".md") continue;
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

checkTitles(docsRoot);
if (failures.length) throw new Error(`Invalid generated docs titles:\n${failures.join("\n")}`);
console.log("Generated docs titles are plain text");
