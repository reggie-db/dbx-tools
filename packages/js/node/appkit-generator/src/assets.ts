/**
 * Deterministic brand-asset discovery from an official page.
 *
 * @module
 */

import { object } from "@dbx-tools/shared-core";
import type { BrandAssetSet } from "@dbx-tools/shared-core/brand-utils";
import { load } from "cheerio";

/** Asset references extracted from one official HTML page. */
export interface DiscoveredBrandAssets {
  /** Theme-aware icon reference. */
  icon: BrandAssetSet;
  /** Theme-aware logo reference. */
  logo: BrandAssetSet;
  /** Browser favicon reference. */
  favicon: string;
}

/** Normalize a page-relative asset reference to a public HTTPS URL. */
function assetUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const resolved = new URL(value.trim(), baseUrl);
    return resolved.protocol === "https:" ? resolved.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Add a normalized URL to a candidate list once. */
function appendCandidate(candidates: string[], value: string | undefined, baseUrl: string): void {
  const resolved = assetUrl(value, baseUrl);
  if (resolved && !candidates.includes(resolved)) candidates.push(resolved);
}

/**
 * Find logo-like URLs nested in JSON-LD organization metadata.
 *
 * JSON-LD permits `logo` and `image` to be a URL, an object with a `url` or
 * `contentUrl`, or an array. The bounded recursive walk accepts those forms
 * without treating unrelated strings elsewhere in the document as assets.
 */
function jsonLdAssetUrls(value: unknown, depth = 0, assetContext = false): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === "string") return assetContext ? [value] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => jsonLdAssetUrls(entry, depth + 1, assetContext));
  }
  if (!object.isRecord(value)) return [];

  const direct = assetContext
    ? [value.url, value.contentUrl].flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
  return [
    ...direct,
    ...jsonLdAssetUrls(value.logo, depth + 1, true),
    ...jsonLdAssetUrls(value.image, depth + 1, true),
    ...jsonLdAssetUrls(value["@graph"], depth + 1, false),
  ];
}

/**
 * Discover icon, logo, and favicon URLs from an official page.
 *
 * The function only returns URLs present in page metadata or markup. When the
 * page omits an icon, it uses the conventional `/favicon.ico` URL on the same
 * origin. The logo falls back to that icon so a generated context never points
 * at the dbx-tools default artwork.
 */
export function discoverBrandAssets(html: string, pageUrl: string): DiscoveredBrandAssets {
  const $ = load(html);
  const icons: string[] = [];
  const logos: string[] = [];

  $("link[rel]").each((_index, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase();
    if (rel.split(/\s+/).some((part) => part === "icon" || part === "apple-touch-icon")) {
      appendCandidate(icons, $(element).attr("href"), pageUrl);
    }
  });

  for (const selector of [
    'meta[property="og:image"]',
    'meta[property="og:logo"]',
    'meta[name="twitter:image"]',
  ]) {
    $(selector).each((_index, element) => {
      appendCandidate(logos, $(element).attr("content"), pageUrl);
    });
  }

  $("img").each((_index, element) => {
    const descriptor = [
      $(element).attr("alt"),
      $(element).attr("class"),
      $(element).attr("id"),
      $(element).attr("data-testid"),
    ]
      .filter(Boolean)
      .join(" ");
    if (/\b(?:brand|logo|wordmark)\b/i.test(descriptor)) {
      appendCandidate(logos, $(element).attr("src"), pageUrl);
    }
  });

  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      const value: unknown = JSON.parse($(element).text());
      for (const candidate of jsonLdAssetUrls(value)) {
        appendCandidate(logos, candidate, pageUrl);
      }
    } catch {
      return;
    }
  });

  const fallbackIcon = new URL("/favicon.ico", pageUrl).toString();
  const icon = icons[0] ?? logos[0] ?? fallbackIcon;
  const logo = logos[0] ?? icons[0] ?? fallbackIcon;
  return {
    icon: { light: icon },
    logo: { light: logo },
    favicon: icon,
  };
}
