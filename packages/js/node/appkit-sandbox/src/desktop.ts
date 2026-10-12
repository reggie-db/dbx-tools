import { brandUtils } from "@dbx-tools/shared-core";
import { dbxToolsAssetDataUrls, dbxToolsAssetSvg } from "@dbx-tools/ui/branding/assets";

const DESKTOP_DISPLAY = 20;
const DESKTOP_VNC_PORT = 5900 + DESKTOP_DISPLAY;
const DESKTOP_WEB_PORT = 6080;
const BRAND = brandUtils.defaultBrandContext;
const BRAND_COLORS = BRAND.colors;
const WALLPAPER_LOGO = dbxToolsAssetSvg.logoDark.replace(
  "<svg ",
  '<svg x="500" y="378" width="600" height="135" ',
);

const DBX_TOOLS_WALLPAPER =
  // ============================================================================
  /*xml*/ `
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B161B"/>
      <stop offset="0.55" stop-color="${BRAND_COLORS.primary}"/>
      <stop offset="1" stop-color="${BRAND_COLORS.primaryHover}"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0H0V64" fill="none" stroke="${BRAND_COLORS.surface}" stroke-opacity="0.045"/>
    </pattern>
  </defs>
  <rect width="1600" height="1000" fill="url(#background)"/>
  <rect width="1600" height="1000" fill="url(#grid)"/>
  <path d="M0 780C310 650 475 920 780 775s500-220 820-55v280H0Z" fill="${BRAND_COLORS.accent}" fill-opacity="0.13"/>
  <path d="M0 835c300-125 510 105 790-10s500-170 810-65" fill="none" stroke="${BRAND_COLORS.accent}" stroke-width="4" stroke-opacity="0.7"/>
  ${WALLPAPER_LOGO}
  <text x="800" y="558" text-anchor="middle" fill="${BRAND_COLORS.muted}" font-family="${BRAND.typography.sans}" font-size="24" letter-spacing="5">SANDBOX DESKTOP</text>
</svg>
`
    // ============================================================================
    .trim();

const DBX_TOOLS_TERMINAL_ICON =
  // ============================================================================
  /*xml*/ `
<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="6" width="56" height="52" rx="12" fill="${BRAND_COLORS.primary}"/>
  <rect x="8" y="10" width="48" height="44" rx="8" fill="${BRAND_COLORS.primaryHover}"/>
  <path d="m18 23 9 9-9 9" fill="none" stroke="${BRAND_COLORS.surface}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M34 41h12" fill="none" stroke="${BRAND_COLORS.accent}" stroke-width="4" stroke-linecap="round"/>
</svg>
`
    // ============================================================================
    .trim();

const DESKTOP_BRAND_HEAD =
  // ============================================================================
  /*html*/ `
<style id="dbx-tools-desktop-brand">
.noVNC_logo,h1.noVNC_logo,a[title="KasmVNC Learn More"]{display:none!important}
</style>
<link data-dbx-tools-desktop-icon rel="icon" href="${dbxToolsAssetDataUrls.iconDark}">
<script id="dbx-tools-desktop-brand-script">(()=>{const icon=${JSON.stringify(dbxToolsAssetDataUrls.iconDark)};const rewrite=(root)=>{if(root.nodeType===Node.TEXT_NODE){if(root.nodeValue?.includes("KasmVNC"))root.nodeValue=root.nodeValue.replaceAll("KasmVNC","dbx tools Desktop");return}const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())if(node.nodeValue?.includes("KasmVNC"))node.nodeValue=node.nodeValue.replaceAll("KasmVNC","dbx tools Desktop")};const apply=()=>{document.title="dbx tools Desktop";for(const link of document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]'))link.setAttribute("href",icon);if(document.body)rewrite(document.body)};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",apply,{once:true});else apply();new MutationObserver((entries)=>{for(const entry of entries){if(entry.type==="characterData")rewrite(entry.target);else for(const node of entry.addedNodes)rewrite(node)}}).observe(document.documentElement,{childList:true,subtree:true,characterData:true})})();</script>
`
    // ============================================================================
    .trim();

/** Browser metadata used by the packaged KasmVNC service. */
export const desktopBrowserMetadata = {
  remoteHost: "127.0.0.1",
  remotePort: DESKTOP_WEB_PORT,
  stripPrefix: true,
  redirectToSlash: true,
  htmlHead: DESKTOP_BRAND_HEAD,
} as const;

/** Browser entry URL for the built-in KasmVNC desktop. */
export function desktopOpenUrl(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const websocketPath = `${normalized.replace(/^\/+/, "")}/websockify`;
  const parameters = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    show_dot: "1",
    clipboard_seamless: "0",
    enable_webp: "0",
    kasmvnc_mode_preference: "-1027",
    path: websocketPath,
  });
  return `${normalized}/?${parameters.toString()}`;
}

/** Environment values consumed while installing the packaged desktop service. */
export function desktopMiseEnvironment(): Readonly<Record<string, string>> {
  return {
    DBX_TOOLS_DESKTOP_WALLPAPER_BASE64: Buffer.from(DBX_TOOLS_WALLPAPER).toString("base64"),
    DBX_TOOLS_DESKTOP_BRAND_ICON_BASE64: Buffer.from(dbxToolsAssetSvg.iconDark).toString("base64"),
    DBX_TOOLS_DESKTOP_TERMINAL_ICON_BASE64: Buffer.from(DBX_TOOLS_TERMINAL_ICON).toString("base64"),
    DBX_TOOLS_DESKTOP_HOMEPAGE_BASE64: Buffer.from(BRAND.links.website).toString("base64"),
    DBX_TOOLS_DESKTOP_PRIMARY: BRAND_COLORS.primary,
    DBX_TOOLS_DESKTOP_PRIMARY_HOVER: BRAND_COLORS.primaryHover,
    DBX_TOOLS_DESKTOP_SURFACE: BRAND_COLORS.surface,
    DBX_TOOLS_DESKTOP_FONT: "DejaVu Sans",
  };
}

/** Fixed ports owned by the packaged desktop service. */
export const desktopPorts = {
  vnc: DESKTOP_VNC_PORT,
  web: DESKTOP_WEB_PORT,
} as const;
