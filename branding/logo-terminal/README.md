# dbx.tools — Logo concepts · Terminal / Prompt-Cursor lane

Phase 1 branding exploration for **dbx.tools**, a set of open-source-style tools that
make working on Databricks easier. This folder covers **one creative lane**: marks built
from developer-terminal motifs — the command prompt, the blinking cursor, code brackets,
and the terminal window.

Open [`index.html`](./index.html) for the full contact sheet (no server required —
double-click it). It shows every concept on light and dark backgrounds, at favicon sizes
(16 / 32 / 48 px) up through large, with rationale and mustache notes under each.

---

## Brand foundations (shared across all four concepts)

### Color — Coral palette
Anchored to the Apple iPhone **"Coral"** color (a warm pink-orange). On light backgrounds
the deeper coral is used for legibility; on dark (`#0a0a0a`) the brighter hero coral leads.

| Token | Hex | Role |
|-------|-----|------|
| **Coral** (hero) | `#FF7A5C` | Primary mark on dark; the `.tools` accent |
| **Coral Deep** | `#E85C42` | Primary stroke/fill on light backgrounds |
| **Coral Dark** | `#C6412A` | Secondary accents (cursor, slash, dots) on light |
| **Coral Bright** | `#FF9E86` | Secondary accents on dark backgrounds |
| **Coral Tint** | `#FFE4DC` | Light fills / callout backgrounds |
| Ink | `#1A1A1A` / `#0a0a0a` | Wordmark on light / dark canvas |

### Type — wordmark
**DM Sans**, weight **700**, letter-spacing `-1` — the same geometric-sans family Databricks
uses, so the wordmark sits adjacent to the Databricks brand without copying it. Fallback stack
in the SVGs is `DM Sans → Inter → system-ui`. The wordmark is set as `dbx` in ink + `.tools`
in coral, so the product name reads as a domain and the coral ties back to the icon.

### The subtle mustache easter egg
Every mark hides a mustache so understated a casual viewer reads only the terminal glyph.
It is **never a cartoon face** — it is always load-bearing geometry that happens to also be a
tiny waxed handlebar. Locations are listed per concept below.

---

## The four concepts

### Concept 01 — The `>_` Prompt
Files: `concept-1-icon-{light,dark}.svg`, `concept-1-lockup-{light,dark}.svg`

The universal shell prompt reduced to its essence: an open chevron and a resting cursor bar.
The cleanest, most instantly-legible "this is a terminal" signal, and the strongest favicon of
the set.
**🥸 Mustache:** the two arms of the `>` are gently **waxed** — subtly curved outward like a
groomed handlebar, meeting at the point (which becomes the philtrum). Reads as a crisp chevron;
only on a second look is it a mustache.

### Concept 02 — The Cursor Block
Files: `concept-2-icon-{light,dark}.svg`, `concept-2-lockup-{light,dark}.svg`

A solid blinking cursor block resting on the command line — the heartbeat of an active session.
The most abstract, monogram-like option; the tall block echoes the ascenders of the wordmark.
**🥸 Mustache:** the command-line baseline underneath the cursor isn't flat — its two tips flick
**upward** by a couple of pixels, a barely-perceptible handlebar. Looks like a cursor sitting on
a line; it's quietly a face.

### Concept 03 — The `</>` Code Brackets
Files: `concept-3-icon-{light,dark}.svg`, `concept-3-lockup-{light,dark}.svg`

The "this is code" glyph in coral: two chevrons split by a slash. Symmetrical, energetic, and
unmistakably about software tooling, with strong horizontal balance beside the wordmark.
**🥸 Mustache:** read the left `<` and right `>` as the two halves of a handlebar, and the
angled `/` becomes the nose-and-philtrum parting them down the middle. A code tag first; a face
on the second glance.

### Concept 04 — The Terminal Window
Files: `concept-4-icon-{light,dark}.svg`, `concept-4-lockup-{light,dark}.svg`

The whole environment in one glyph: a rounded window with a title bar and a live `>_` prompt
inside. The most "product / app-icon" of the set while still nodding to the command line.
**🥸 Mustache:** the prompt `>` inside the window carries the same waxed, curling arms as Concept
01 — a mustache tucked behind the glass. Doubly hidden: you have to notice the prompt first, then
the mustache within it.

---

## Files

```
branding/logo-terminal/
├── index.html                     # self-contained contact sheet (open directly)
├── README.md                      # this file
├── concept-1-icon-light.svg       # >_ prompt        — icon,   light bg
├── concept-1-icon-dark.svg        #                    icon,   dark bg
├── concept-1-lockup-light.svg     #                    lockup, light bg
├── concept-1-lockup-dark.svg      #                    lockup, dark bg
├── concept-2-*                    # cursor block      (icon/lockup × light/dark)
├── concept-3-*                    # </> code brackets (icon/lockup × light/dark)
└── concept-4-*                    # terminal window   (icon/lockup × light/dark)
```

All marks are hand-authored SVG with a proper `viewBox` (icons `0 0 64 64`), no raster
assets and no stray artifacts, verified legible from 16 px favicon up to large display sizes.

_Phase 1 — concepts only. Not final artwork._
