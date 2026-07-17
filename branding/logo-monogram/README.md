# dbx.tools — Logo Concepts (Phase 1)

**Creative lane:** Monogram / Wordmark. Typographic identity for `dbx.tools` — a set of
open-source-style developer tools that make working on Databricks easier.

**Vibe:** nerdy and digital — developer/engineer aesthetic, clean and modern (not
playful-cartoon). Geometric sans-serif typography adjacent to the Databricks type feel,
without copying the Databricks logo.

Open `index.html` directly in a browser (no server needed) for the full contact sheet:
all 4 concepts, light + dark, at favicon sizes (16/32/48px) up to large.

---

## Coral palette

| Role         | Hex       | Usage                                             |
|--------------|-----------|---------------------------------------------------|
| Primary coral| `#FF7A5C` | Main brand coral (Apple iPhone "Coral" family)    |
| Dark coral   | `#E85C42` | Lettermark strokes on light backgrounds, contrast |
| Light tint   | `#FFD9CE` | Accents on dark backgrounds, soft fills, badges   |
| Ink          | `#0a0a0a` | Near-black for dark-mode backgrounds              |
| Light bg     | `#FFFFFF` / `#FFF1ED` | White / warm tint icon backgrounds    |

On **light** backgrounds the lettermark strokes use dark coral `#E85C42` for punch, with
the accent dot / swash in primary coral `#FF7A5C`. On **dark** backgrounds the strokes use
primary coral `#FF7A5C` with accents in light tint `#FFD9CE`.

## Typography

Wordmark set in **DM Sans** (falling back to **Inter**, then system geometric sans),
weight 600, letter-spacing `-0.5`. Databricks-adjacent geometric sans without imitating the
Databricks mark. In every lockup the `dbx` is inked and `tools` is muted grey, with the `.`
rendered as an expressive coral separator dot.

## Files

Each concept ships a horizontal **lockup** (monogram + `dbx.tools` wordmark) and a
**monogram/icon-only** mark, each in **light** and **dark** variants:

```
concept-N-lockup-light.svg   concept-N-icon-light.svg
concept-N-lockup-dark.svg    concept-N-icon-dark.svg
```

All SVGs are hand-authored vectors with a proper `viewBox`, no stray artifacts, and stay
legible down to 16px favicon size.

---

## The concepts (and where the mustache hides)

The brief calls for an **extremely subtle** mustache easter egg in each mark — invisible to a
casual viewer, delightful once pointed out. Never a cartoon mustache; always hidden inside a
letterform or accent.

### Concept 1 · The x Mustache
A tight, confident `x` lettermark. The two strokes extend slightly past the crossing point and
**curl upward at the baseline** — the waxed tips of a mustache. Reads as a clean modern `x` at
a glance.
🥸 **Mustache:** the upward-curling tips of the two `x` strokes; the coral domain dot below is
the centre stud.

### Concept 2 · The Dot Curl
The `x` lettermark sits above a thin coral swash that reads as a domain underline; the `.`
separator lives in the swash. Editorial and elegant — the dot-as-accent leads the eye.
🥸 **Mustache:** the underline swash dips in the centre and **flicks up symmetrically at both
tips** — a minimalist waxed mustache. In the lockup the same swash runs under `dbx`.

### Concept 3 · Bracket Mustache
The most overtly "dev" option: a terminal / CLI aesthetic. Two mirrored chevrons frame a coral
prompt dot, over a cursor underscore — reads as `>_<` code brackets around a cursor.
🥸 **Mustache:** the two chevrons **flick up at their outer tips** and the prompt dot is the knot
between them, forming a small centred upturned mustache.

### Concept 4 · Ligature x
The most solid / app-icon-ready option: a filled coral tile with a knocked-out `x`. The strokes
are gently **bowed** rather than straight, so the lower half of the `x` silhouettes a mustache in
the negative space. Scales cleanly to a favicon.
🥸 **Mustache:** the bowed lower strokes of the knockout `x` sweep out and up; the small knocked-out
dot at the crossing is the **philtrum**.

---

*Phase 1 deliverable — logo concepts only. No production asset packaging, favicon generation, or
brand guidelines yet; those are later phases.*
