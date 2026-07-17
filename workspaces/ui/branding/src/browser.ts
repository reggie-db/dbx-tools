import { brand } from "@dbx-tools/shared-core";
import { dbxToolsAssetDataUrls } from "./generated/assets";

const builtInAssets = new Map<string, string>([
  [brand.DEFAULT_BRAND_ASSETS.icon.light, dbxToolsAssetDataUrls.iconLight],
  [brand.DEFAULT_BRAND_ASSETS.icon.dark, dbxToolsAssetDataUrls.iconDark],
  [brand.DEFAULT_BRAND_ASSETS.logo.light, dbxToolsAssetDataUrls.logoLight],
  [brand.DEFAULT_BRAND_ASSETS.logo.dark, dbxToolsAssetDataUrls.logoDark],
  [brand.DEFAULT_BRAND_ASSETS.favicon, dbxToolsAssetDataUrls.iconLight],
]);

export type BrandAssetResolver = (source: string) => string;

/** Resolve built-in package asset ids to portable data URLs. */
export const resolveBrandAsset: BrandAssetResolver = (source) =>
  builtInAssets.get(source) ?? source;

/** Convert a validated context to CSS custom properties. */
export function brandCssVariables(context: brand.BrandContext): Record<string, string> {
  return {
    "--brand-color-primary": context.colors.primary,
    "--brand-color-primary-hover": context.colors.primaryHover,
    "--brand-color-accent": context.colors.accent,
    "--brand-color-foreground": context.colors.foreground,
    "--brand-color-background": context.colors.background,
    "--brand-color-surface": context.colors.surface,
    "--brand-color-muted": context.colors.muted,
    "--brand-color-border": context.colors.border,
    "--brand-font-sans": context.typography.sans,
    "--brand-font-mono": context.typography.mono,
  };
}

export interface ApplyBrandContextOptions {
  root?: HTMLElement;
  document?: Document;
  resolveAsset?: BrandAssetResolver;
  updateTitle?: boolean;
  updateFavicon?: boolean;
}

/** Apply tokens and optional page metadata to a browser document. */
export function applyBrandContext(
  context: brand.BrandContext,
  options: ApplyBrandContextOptions = {},
): void {
  const documentRef = options.document ?? globalThis.document;
  const root = options.root ?? documentRef?.documentElement;
  for (const [name, value] of Object.entries(brandCssVariables(context))) {
    root?.style.setProperty(name, value);
  }

  if (documentRef && options.updateTitle !== false) documentRef.title = context.name;
  if (!documentRef || options.updateFavicon === false) return;

  const resolveAsset = options.resolveAsset ?? resolveBrandAsset;
  let favicon = documentRef.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!favicon) {
    favicon = documentRef.createElement("link");
    favicon.rel = "icon";
    documentRef.head.append(favicon);
  }
  favicon.href = resolveAsset(context.assets.favicon);
}
