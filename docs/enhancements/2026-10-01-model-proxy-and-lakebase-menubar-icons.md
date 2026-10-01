# Menu-bar icons for the model-proxy and Lakebase services

Two macOS menu-bar (systray) icons: one for the **model-proxy** service that
fronts Databricks Model Serving endpoints, and one for the **Lakebase**
connector. They should read as a set, sit inside the `dbx-tools` pixel-mark
family, and each say what their service does at a glance.

Status: model-proxy M1 is implemented by the shared service desktop runtime and
the model-proxy companion adapter. Lakebase adoption and its L1 icon remain
pending.

## Why template images (the "white" question)

macOS menu-bar icons are not shipped as a white asset and a dark asset. The
shared `tray-icon` runtime marks one monochrome glyph as a template image, then
the system draws it:

- black on a light menu bar,
- white on a dark menu bar,
- dimmed when the app is inactive, highlighted (inverted) when the menu is open.

So "can it be white" is yes, automatically, and we only design the shape. The
only time we leave template mode is to signal a state the system can't express:
render the same glyph in a solid color for an error or alert (lava red
`#FF3621`), the way `reggieai/icon.py` already turns its glyph alert-red on
failure.

Each preview below shows the identical template glyph on a light bar (left) and a
dark bar (right) so you can see the auto-invert. In production the light-mode
fill is pure black; the previews use navy `#1B3139` so they sit in the brand.

## Design plan

**Grid.** Same 8px pixel grid and `shape-rendering="crispEdges"` as the `dbx`
mark, drawn in a `0 0 64 64` viewBox. Details land on a 4px half-cell so the
database seams and connector lines stay legible when the icon is scaled down to
the 16-18pt the menu bar actually renders.

**Color.**

| Token          | Hex       | Use                                                         |
| -------------- | --------- | ----------------------------------------------------------- |
| Template black | `#000000` | The real menu-bar glyph fill (system inverts it)            |
| Navy           | `#1B3139` | Dark badge background; stand-in for black in these previews |
| Lava red       | `#FF3621` | Dock/app badge fill, and the error-state menu-bar glyph     |
| Lava light     | `#FF5F46` | Highlight pixel on the dark badge                           |
| Oat            | `#F9F7F4` | Light badge background                                      |

**Principles.**

- One idea per icon. The database reads as a database; the proxy reads as
  one-in / many-out. No labels, no gradients, nothing that collapses at 16px.
- The two icons must be unmistakable from each other in a crowded menu bar: a
  rounded cylinder versus an angular node graph. Different silhouette, same
  pixel vocabulary.
- Build the glyph on transparent background for the menu bar. The rounded-square
  badge is only for the dock/app icon and launcher, where it matches the
  existing `dbx` badge.

## Lakebase connector

A database that lives on a lakehouse. The cylinder is the one database
pictogram everyone reads instantly, built here out of pixel bands with cut
seams so it stays in the `dbx` family instead of looking like a stock glyph.

### Variation L1 — Stacked cylinder

The plain, durable choice. Three disks, two seams, rounded top and bottom.

<svg viewBox="0 0 136 64" width="272" height="128" role="img" aria-label="Lakebase icon, stacked database cylinder, shown on a light and a dark menu bar" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <g id="lb1">
      <rect x="16" y="8" width="32" height="4"/>
      <rect x="12" y="12" width="40" height="4"/>
      <rect x="12" y="16" width="40" height="4"/>
      <rect x="12" y="20" width="8" height="4"/><rect x="44" y="20" width="8" height="4"/>
      <rect x="12" y="24" width="40" height="4"/>
      <rect x="12" y="28" width="40" height="4"/>
      <rect x="12" y="32" width="8" height="4"/><rect x="44" y="32" width="8" height="4"/>
      <rect x="12" y="36" width="40" height="4"/>
      <rect x="12" y="40" width="40" height="4"/>
      <rect x="12" y="44" width="40" height="4"/>
      <rect x="16" y="48" width="32" height="4"/>
      <rect x="20" y="52" width="24" height="4"/>
    </g>
  </defs>
  <rect x="0" y="0" width="64" height="64" rx="12" fill="#EEEDE9"/>
  <use href="#lb1" fill="#1B3139"/>
  <rect x="72" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#lb1" x="72" fill="#FFFFFF"/>
</svg>

### Variation L2 — Cylinder on a wave

The "lake" pun made literal: a shorter database resting over two water crests.
More specific to Lakebase, slightly busier at tiny sizes.

<svg viewBox="0 0 136 64" width="272" height="128" role="img" aria-label="Lakebase icon, database cylinder above a water wave, shown on a light and a dark menu bar" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <g id="lb2">
      <rect x="16" y="6" width="32" height="4"/>
      <rect x="12" y="10" width="40" height="4"/>
      <rect x="12" y="14" width="40" height="4"/>
      <rect x="12" y="18" width="8" height="4"/><rect x="44" y="18" width="8" height="4"/>
      <rect x="12" y="22" width="40" height="4"/>
      <rect x="12" y="26" width="40" height="4"/>
      <rect x="16" y="30" width="32" height="4"/>
      <rect x="20" y="34" width="24" height="4"/>
      <rect x="16" y="44" width="8" height="4"/><rect x="40" y="44" width="8" height="4"/>
      <rect x="12" y="48" width="40" height="4"/>
    </g>
  </defs>
  <rect x="0" y="0" width="64" height="64" rx="12" fill="#EEEDE9"/>
  <use href="#lb2" fill="#1B3139"/>
  <rect x="72" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#lb2" x="72" fill="#FFFFFF"/>
</svg>

**Recommendation: L1.** It survives the menu bar better and never gets confused
with a weather or audio glyph. Keep L2 as the dock/app badge variant where the
extra size makes the wave legible.

## Model-proxy service

The proxy takes one stream of requests and routes it across many Databricks
Model Serving endpoints. The icon should show that fan, not a generic "AI"
sparkle.

### Variation M1 — Fan-out router

One node on the left, a spine, three endpoints on the right. One-in / many-out
is the whole job of a proxy, and this draws exactly that.

<svg viewBox="0 0 136 64" width="272" height="128" role="img" aria-label="Model-proxy icon, one node routing to three endpoints, shown on a light and a dark menu bar" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <g id="mp1">
      <rect x="8" y="26" width="12" height="12"/>
      <rect x="48" y="8" width="12" height="12"/>
      <rect x="48" y="26" width="12" height="12"/>
      <rect x="48" y="44" width="12" height="12"/>
      <rect x="20" y="30" width="12" height="4"/>
      <rect x="32" y="12" width="4" height="40"/>
      <rect x="36" y="12" width="12" height="4"/>
      <rect x="36" y="30" width="12" height="4"/>
      <rect x="36" y="48" width="12" height="4"/>
    </g>
  </defs>
  <rect x="0" y="0" width="64" height="64" rx="12" fill="#EEEDE9"/>
  <use href="#mp1" fill="#1B3139"/>
  <rect x="72" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#mp1" x="72" fill="#FFFFFF"/>
</svg>

### Variation M2 — Hub

A central proxy with four endpoints around it. Symmetric, calmer, and reads as a
network rather than a direction. Good if you prefer a mark that is not
left-right oriented.

<svg viewBox="0 0 136 64" width="272" height="128" role="img" aria-label="Model-proxy icon, central hub linked to four endpoints, shown on a light and a dark menu bar" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <defs>
    <g id="mp2">
      <rect x="26" y="26" width="12" height="12"/>
      <rect x="26" y="4" width="12" height="12"/>
      <rect x="26" y="48" width="12" height="12"/>
      <rect x="4" y="26" width="12" height="12"/>
      <rect x="48" y="26" width="12" height="12"/>
      <rect x="30" y="16" width="4" height="10"/>
      <rect x="30" y="38" width="4" height="10"/>
      <rect x="16" y="30" width="10" height="4"/>
      <rect x="38" y="30" width="10" height="4"/>
    </g>
  </defs>
  <rect x="0" y="0" width="64" height="64" rx="12" fill="#EEEDE9"/>
  <use href="#mp2" fill="#1B3139"/>
  <rect x="72" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#mp2" x="72" fill="#FFFFFF"/>
</svg>

**Recommendation: M1.** It states "proxy" instead of "some network." The hub
(M2) risks reading as a generic apps or share icon.

## The set, side by side

L1 and M1 together: distinct silhouettes, one pixel vocabulary.

<svg viewBox="0 0 136 64" width="272" height="128" role="img" aria-label="Lakebase cylinder and model-proxy fan shown together on a dark menu bar" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <rect x="0" y="0" width="136" height="64" rx="12" fill="#1B3139"/>
  <use href="#lb1" x="8" fill="#FFFFFF"/>
  <use href="#mp1" x="64" fill="#FFFFFF"/>
</svg>

## Dock / app badges (recommended variations)

For the launcher and dock, drop the chosen glyph onto the same rounded badge as
the `dbx` mark: oat `#F9F7F4` light, navy `#1B3139` dark, glyph in lava red.

<svg viewBox="0 0 272 64" width="272" height="64" role="img" aria-label="Lakebase and model-proxy dock badges in light and dark" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
  <rect x="0" y="0" width="64" height="64" rx="12" fill="#F9F7F4"/>
  <use href="#lb1" transform="translate(6.4 6.4) scale(0.8)" fill="#FF3621"/>
  <rect x="72" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#lb1" transform="translate(78.4 6.4) scale(0.8)" fill="#FF5F46"/>
  <rect x="144" y="0" width="64" height="64" rx="12" fill="#F9F7F4"/>
  <use href="#mp1" transform="translate(150.4 6.4) scale(0.8)" fill="#FF3621"/>
  <rect x="216" y="0" width="64" height="64" rx="12" fill="#1B3139"/>
  <use href="#mp1" transform="translate(222.4 6.4) scale(0.8)" fill="#FF5F46"/>
</svg>

## Export and implementation

The generic tray and WebView runtime lives in `packages/rs/service`; the
model-proxy companion supplies its M1 pixel mask, title, health URL, and Metrics
URL from `packages/rs/model-proxy/src/bin/desktop.rs`.

The M1 adapter rasterizes the pixel rectangles directly into a 32px RGBA mask.
The shared desktop runtime marks it as a macOS template icon so the system owns
light/dark inversion; Windows and Linux receive the coral brand color. A future
Lakebase adapter can supply its own RGBA mask through the same `DesktopIcon`
contract without taking a dependency on model-proxy assets.

## Open questions

- Lakebase still needs to adopt `dbx-tools-service` and select its L1 icon when
  its background lifecycle is implemented.
- **claude.ai/design sync.** If these should become shared, previewable
  components in a claude.ai/design design system, that is a separate publish
  step via the `/design-sync` skill. Not done here, since it pushes outside the
  repo.

## Appendix: production glyph sources

Transparent, `currentColor`, no badge. Ready for the renderer.

### Lakebase L1

```xml
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Lakebase" fill="currentColor" shape-rendering="crispEdges">
  <rect x="16" y="8" width="32" height="4"/>
  <rect x="12" y="12" width="40" height="4"/>
  <rect x="12" y="16" width="40" height="4"/>
  <rect x="12" y="20" width="8" height="4"/><rect x="44" y="20" width="8" height="4"/>
  <rect x="12" y="24" width="40" height="4"/>
  <rect x="12" y="28" width="40" height="4"/>
  <rect x="12" y="32" width="8" height="4"/><rect x="44" y="32" width="8" height="4"/>
  <rect x="12" y="36" width="40" height="4"/>
  <rect x="12" y="40" width="40" height="4"/>
  <rect x="12" y="44" width="40" height="4"/>
  <rect x="16" y="48" width="32" height="4"/>
  <rect x="20" y="52" width="24" height="4"/>
</svg>
```

### Model-proxy M1

```xml
<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Model proxy" fill="currentColor" shape-rendering="crispEdges">
  <rect x="8" y="26" width="12" height="12"/>
  <rect x="48" y="8" width="12" height="12"/>
  <rect x="48" y="26" width="12" height="12"/>
  <rect x="48" y="44" width="12" height="12"/>
  <rect x="20" y="30" width="12" height="4"/>
  <rect x="32" y="12" width="4" height="40"/>
  <rect x="36" y="12" width="12" height="4"/>
  <rect x="36" y="30" width="12" height="4"/>
  <rect x="36" y="48" width="12" height="4"/>
</svg>
```
