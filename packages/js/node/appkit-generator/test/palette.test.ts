import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorContrastRatio, normalizeBrandPalette } from "../src/palette.ts";
import type { GeneratedBrandProfile } from "../src/schema.ts";

const profile: GeneratedBrandProfile = {
  name: "Databricks",
  shortName: "Databricks",
  tagline: "Data and AI.",
  description: "Data and AI platform.",
  colors: {
    primary: "#FF3621",
    primaryHover: "#E62B1E",
    accent: "#FF3621",
    foreground: "#1B3139",
    background: "#FFFFFF",
    surface: "#F7F7F7",
    muted: "#777777",
    border: "#DCE0E2",
  },
  typography: {
    sans: "Arial, sans-serif",
    mono: "monospace",
  },
  voice: {
    audience: ["data teams"],
    tone: ["direct"],
    principles: ["Be specific."],
    avoid: ["vague claims"],
  },
  links: {
    website: "https://www.databricks.com/",
  },
};

describe("generated brand palette", () => {
  it("preserves hue while making action and text colors WCAG AA readable", () => {
    const normalized = normalizeBrandPalette(profile);
    for (const color of [
      normalized.colors.primary,
      normalized.colors.primaryHover,
      normalized.colors.foreground,
      normalized.colors.muted,
    ]) {
      assert.ok(colorContrastRatio(color, normalized.colors.background) >= 5);
    }
    assert.notEqual(normalized.colors.primary, profile.colors.primary);
    assert.equal(normalized.colors.accent, profile.colors.accent);
  });
});
