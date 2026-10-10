import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatedLinkFailures } from "./check-generated-links.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(files) {
  const siteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dbx-tools-generated-links-"));
  temporaryDirectories.push(siteRoot);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(siteRoot, "src", "content", "docs", relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return siteRoot;
}

test("validates generated routes, duplicate headings, and fragments", () => {
  const siteRoot = fixture({
    "index.md": "# Home\n\n[Package](/packages/widget#run-it-1)\n",
    "packages/widget.md": "# Widget\n\n## Run It\n\n## Run It\n\n[Home](/)\n",
  });

  expect(generatedLinkFailures(siteRoot)).toEqual({ checkedPages: 2, failures: [] });
});

test("reports missing targets and heading fragments", () => {
  const siteRoot = fixture({
    "index.md": "# Home\n\n[Missing](/missing)\n\n[Bad fragment](/packages/widget#wrong)\n",
    "packages/widget.md": "# Widget\n\n## Right\n",
  });

  expect(generatedLinkFailures(siteRoot).failures).toEqual([
    "index.md: /missing has no generated target",
    "index.md: /packages/widget#wrong has no matching generated fragment",
  ]);
});

test("allows API stubs before API generation", () => {
  const siteRoot = fixture({
    "packages/widget.md": "# Widget\n\n[API](/api/widget/)\n",
  });

  expect(generatedLinkFailures(siteRoot, { allowApiStubs: true }).failures).toEqual([]);
  expect(generatedLinkFailures(siteRoot).failures).toEqual([
    "packages/widget.md: /api/widget/ has no generated target",
  ]);
});

test("ignores external links and Markdown-looking text inside code", () => {
  const siteRoot = fixture({
    "index.md": [
      "# Home",
      "",
      "[External](https://example.com/missing#fragment)",
      "",
      "`[Not a link](/missing)`",
      "",
    ].join("\n"),
  });

  expect(generatedLinkFailures(siteRoot).failures).toEqual([]);
});
