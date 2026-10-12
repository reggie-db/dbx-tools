import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { addApiGuideLink, apiSymbolLinks, linkPackageGuideApi } from "./api-guide-links.mjs";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "api-guide-links-"));
  fixtures.push(directory);
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("generated API guide links", () => {
  it("discovers TypeScript symbol pages and drops ambiguous names", () => {
    const directory = fixture();
    writeFileSync(join(directory, "class-widget.md"), '---\ntitle: "Class: Widget"\n---\n');
    writeFileSync(join(directory, "function-create.md"), '---\ntitle: "Function: createWidget()"\n---\n');
    writeFileSync(join(directory, "other-widget.md"), '---\ntitle: "Interface: Widget"\n---\n');

    assert.deepEqual([...apiSymbolLinks(directory, "widget", "/docs")], [
      ["createWidget", "/docs/api/widget/function-create/"],
    ]);
  });

  it("discovers Python public exports as anchors on the package page", () => {
    const directory = fixture();
    writeFileSync(
      join(directory, "index.md"),
      [
        "---",
        'title: "Widget Python API"',
        "---",
        "",
        "| Export | Owner | Kind |",
        "| --- | --- | --- |",
        "| `Widget` | `widget.core` | class |",
        "| `create_widget` | `widget.core` | function |",
      ].join("\n"),
    );

    assert.deepEqual([...apiSymbolLinks(directory, "py-widget")], [
      ["Widget", "/api/py-widget/#widget"],
      ["create_widget", "/api/py-widget/#create_widget"],
    ]);
  });

  it("links one occurrence per section and skips code fences and existing links", () => {
    const markdown = [
      "## Configure",
      "Use `Widget` with `Widget` and [`createWidget()`](/custom).",
      "",
      "```ts",
      "new Widget();",
      "```",
      "",
      "## Operate",
      "Reuse `Widget` and call `createWidget()`.",
    ].join("\n");
    const links = new Map([
      ["Widget", "/api/widget/class-widget/"],
      ["createWidget", "/api/widget/function-create/"],
    ]);

    assert.equal(
      linkPackageGuideApi(markdown, links),
      [
        "## Configure",
        "Use [`Widget`](/api/widget/class-widget/) with `Widget` and [`createWidget()`](/custom).",
        "",
        "```ts",
        "new Widget();",
        "```",
        "",
        "## Operate",
        "Reuse [`Widget`](/api/widget/class-widget/) and call [`createWidget()`](/api/widget/function-create/).",
      ].join("\n"),
    );
  });

  it("adds one package-guide backlink after the generated comment", () => {
    const markdown = "---\ntitle: API\n---\n\n<!--\n  Generated.\n-->\n\nBody.\n";
    const linked = addApiGuideLink(markdown, "@scope/widget", "/packages/widget/");
    assert.match(linked, /Generated\.\n-->\n\nFor setup, workflows/);
    assert.equal(addApiGuideLink(linked, "@scope/widget", "/packages/widget/"), linked);
  });
});
