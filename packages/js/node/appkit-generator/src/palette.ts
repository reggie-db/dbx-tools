/**
 * Accessibility normalization for model-generated interface palettes.
 *
 * @module
 */

import type { GeneratedBrandProfile } from "./schema.ts";

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

/** Expand a schema-validated hex color into RGB channels. */
function hexToRgb(color: string): Rgb {
  const hex = color.slice(1);
  const expanded =
    hex.length === 3 ? [...hex].map((value) => `${value}${value}`).join("") : hex.slice(0, 6);
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

/** Serialize RGB channels as a six-digit uppercase hex color. */
function rgbToHex(color: Rgb): string {
  const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0").toUpperCase();
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

/** WCAG relative luminance for one sRGB color. */
function relativeLuminance(color: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue);
}

/** WCAG contrast ratio between two schema-valid hex colors. */
export function colorContrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(hexToRgb(foreground));
  const second = relativeLuminance(hexToRgb(background));
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Blend a color toward black or white past the AA threshold with rendering margin. */
function ensureContrast(color: string, background: string, minimum = 5): string {
  if (colorContrastRatio(color, background) >= minimum) return color;
  const source = hexToRgb(color);
  const backgroundIsLight = relativeLuminance(hexToRgb(background)) > 0.5;
  const target = backgroundIsLight ? 0 : 255;
  for (let amount = 0.05; amount <= 1; amount += 0.05) {
    const candidate = rgbToHex({
      red: source.red + (target - source.red) * amount,
      green: source.green + (target - source.green) * amount,
      blue: source.blue + (target - source.blue) * amount,
    });
    if (colorContrastRatio(candidate, background) >= minimum) return candidate;
  }
  return backgroundIsLight ? "#000000" : "#FFFFFF";
}

/** Make generated text and action colors readable against the page background. */
export function normalizeBrandPalette(profile: GeneratedBrandProfile): GeneratedBrandProfile {
  const background = profile.colors.background;
  return {
    ...profile,
    colors: {
      ...profile.colors,
      primary: ensureContrast(profile.colors.primary, background),
      primaryHover: ensureContrast(profile.colors.primaryHover, background),
      foreground: ensureContrast(profile.colors.foreground, background),
      muted: ensureContrast(profile.colors.muted, background),
    },
  };
}
