import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { brandUtils } from "@dbx-tools/shared-core";

import { brandCssVariables } from "../src/branding/browser.ts";

const styles = await readFile(new URL("../src/branding/styles.css", import.meta.url), "utf8");
const bridge = await readFile(new URL("../src/branding/brand-bridge.css", import.meta.url), "utf8");

describe("default brand CSS", () => {
  it("matches the canonical navy, blue, and green palette", () => {
    assert.match(styles, /--brand-color-primary:\s*#1b3139;/);
    assert.match(styles, /--brand-color-primary-hover:\s*#0e538b;/);
    assert.match(styles, /--brand-color-accent:\s*#00a972;/);
    const variables = brandCssVariables(brandUtils.defaultBrandContext);
    assert.equal(variables["--brand-color-primary"], "#1B3139");
    assert.equal(variables["--brand-color-primary-hover"], "#0E538B");
    assert.equal(variables["--brand-color-accent"], "#00A972");
  });

  it("uses a cool menu tint without overriding status semantics", () => {
    assert.match(
      bridge,
      /--accent:\s*color-mix\(in oklab, var\(--brand-color-primary-hover\) 12%,/,
    );
    assert.doesNotMatch(bridge, /^\s*--(?:success|warning|destructive):/m);
  });

  it("lightens brand interaction colors on dark surfaces", () => {
    assert.match(bridge, /:root\.dark\[data-brand\]/);
    assert.match(bridge, /@media \(prefers-color-scheme: dark\)/);
    assert.match(
      bridge,
      /--primary:\s*color-mix\([\s\S]*var\(--brand-color-primary-hover\) 58%,[\s\S]*var\(--foreground\)/,
    );
    assert.match(bridge, /--primary-foreground:\s*var\(--background\);/);
  });
});
