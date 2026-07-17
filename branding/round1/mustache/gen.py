#!/usr/bin/env python3
"""Generate pixel-brick 'stache logo concepts for dbx.tools.

Databricks brand system (renamed for dbx.tools):
  - Primary: Lava 600 #FF3621
  - Ink / dark surface: Navy 900 #0B2026
  - Light bg: Oat Light #F9F7F4 / Oat Medium #EEEDE9 / White
  - Typeface: DM Sans (brand), DM Mono (code)
The mustache brick texture uses tints/shades of Lava 600 to stay on-brand.
"""
import os

OUT = os.path.dirname(os.path.abspath(__file__))

# --- Databricks palette ---
LAVA       = "#FF3621"  # Lava 600 — primary
LAVA_DARK  = "#D92D18"  # darker lava shade
LAVA_MID   = "#FF5A46"  # lighter lava
LAVA_LT    = "#FF8974"  # lightest lava tint (texture highlight)
NAVY       = "#0B2026"  # Navy 900 — ink / dark surface
OAT_LT     = "#F9F7F4"  # Oat Light — light icon bg
WHITE      = "#FFFFFF"

# grid: 8px bricks, 9px step, 7 columns, 3 rows
COLS = [1, 10, 19, 28, 37, 46, 55]   # x positions c0..c6
ROWS = [20, 29, 38]                   # y positions r0..r2
B = 8                                 # brick size

# shade keys map to lava family; on dark bg we lift them for contrast
SHADE      = {"a": LAVA, "b": LAVA_DARK, "c": LAVA_MID, "d": LAVA_LT}
SHADE_DARK = {"a": LAVA, "b": LAVA_MID, "c": LAVA_LT,  "d": LAVA_LT}

CONCEPTS = {
    # 1. Handlebar / horseshoe — upturned tips, dipped center body
    "handlebar": {
        (0, 0): "b",             (6, 0): "b",
        (0, 1): "a", (1, 1): "a",             (5, 1): "a", (6, 1): "a",
                     (1, 2): "c", (2, 2): "a", (3, 2): "d", (4, 2): "a", (5, 2): "c",
    },
    # 2. Flat-bar 'stache — solid top bar, curled ends, hanging tips w/ philtrum gap
    "flatbar": {
        (0, 0): "a",                                                     (6, 0): "a",
        (0, 1): "b", (1, 1): "a", (2, 1): "c", (3, 1): "d", (4, 1): "c", (5, 1): "a", (6, 1): "b",
                     (1, 2): "b",                                        (5, 2): "b",
    },
    # 3. Chevron 'stache — mirrored peaks nod to a terminal chevron / a峰 mustache
    "chevron": {
                                  (2, 0): "a",              (4, 0): "a",
        (0, 1): "b", (1, 1): "a", (2, 1): "c", (3, 1): "d", (4, 1): "c", (5, 1): "a", (6, 1): "b",
                     (1, 2): "a",                                        (5, 2): "a",
    },
}


def bricks_svg(concept, dark):
    shades = SHADE_DARK if dark else SHADE
    out = []
    for (c, r), s in sorted(concept.items()):
        x, y = COLS[c], ROWS[r]
        out.append(
            f'<rect x="{x}" y="{y}" width="{B}" height="{B}" rx="1" fill="{shades[s]}"/>'
        )
    return "".join(out)


def icon_svg(name, concept, dark):
    bg = NAVY if dark else OAT_LT
    mode = "dark" if dark else "light"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="t d">
  <title id="t">dbx.tools {name} icon {mode}</title>
  <desc id="d">Pixel-brick mustache mark in Databricks Lava for {mode} backgrounds.</desc>
  <rect width="64" height="64" rx="14" fill="{bg}"/>
  <g shape-rendering="crispEdges">{bricks_svg(concept, dark)}</g>
</svg>
'''


def lockup_svg(name, concept, dark):
    bg = NAVY if dark else WHITE
    icon_bg = NAVY if dark else OAT_LT
    ink = "#F9F7F4" if dark else NAVY
    mode = "dark" if dark else "light"
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 72" role="img" aria-labelledby="t d">
  <title id="t">dbx.tools {name} lockup {mode}</title>
  <desc id="d">Horizontal lockup: pixel-brick mustache mark and dbx.tools wordmark.</desc>
  <rect width="300" height="72" rx="18" fill="{bg}"/>
  <g transform="translate(8 4)"><rect width="64" height="64" rx="14" fill="{icon_bg}"/><g shape-rendering="crispEdges">{bricks_svg(concept, dark)}</g></g>
  <text x="88" y="45" font-family="'DM Sans', Inter, ui-sans-serif, system-ui, sans-serif" font-size="30" font-weight="700" letter-spacing="-1" fill="{ink}">dbx<tspan fill="{LAVA}">.tools</tspan></text>
</svg>
'''


def write(path, content):
    with open(path, "w") as f:
        f.write(content)


for name, concept in CONCEPTS.items():
    d = os.path.join(OUT, name)
    os.makedirs(d, exist_ok=True)
    write(os.path.join(d, "icon-light.svg"), icon_svg(name, concept, False))
    write(os.path.join(d, "icon-dark.svg"), icon_svg(name, concept, True))
    write(os.path.join(d, "lockup-light.svg"), lockup_svg(name, concept, False))
    write(os.path.join(d, "lockup-dark.svg"), lockup_svg(name, concept, True))
    print("wrote", name)
