# FULL_AUDIT_2 §2 — contrast verification evidence

Date: 2026-07-25. Covers the A1–A4 token split and the crane/crease findings that
fell out of it. Kept because the audit's P1 is right that the evidence trail is
the asset, and because these numbers are the only thing standing behind the
claim that a theme can no longer hide a security control.

## What was measured, and where

Two independent measurements, deliberately:

1. **`test-ui/themeContrast.test.ts`** — arithmetic, in CI. Parses the token
   values out of `src/index.css` at run time rather than quoting them, composites
   alpha before the WCAG maths, and asserts 29 pairings × 5 themes.
2. **A real browser (Chromium)** — the numbers below. Five *static* HTML files,
   one per theme, each with `data-theme` as a literal in the markup and the
   built `dist/assets/*.css` inlined, loaded fresh. Each element's computed
   colour is painted onto a canvas over its composited surface and the pixel read
   back, so `color-mix(in oklab, …)` is resolved by the engine instead of modelled.

Both agree, to within rounding, on every row.

## Why the first browser attempt was thrown away

The first attempt flipped `data-theme` on the live app at runtime. `src/index.css`
transitions `color` and `background-color` on `*` for 200ms, so `getComputedStyle`
returned values mid-interpolation, and React's `ThemeProvider` re-asserted the
attribute. The tell: five themes produced identical numbers, and a sanity probe
showed an element resolving to `rgb(216,173,59)` while its own token read
`#7e5c0c`. Suppressing transitions from script did not fix it.

Its output was discarded rather than reported. The static-page method above
avoids the problem by construction — nothing is ever flipped, so nothing is ever
mid-transition — and every run below carries a sanity line proving the element's
colour equals its token before any ratio is believed.

## Results — all five themes, all pairings pass

Sanity column is `--color-sax-ink` token vs the computed colour of an element
using it. Text bar 4.5, graphic bar 3.0.

| pairing | Paper | Ink | Vellum | Graphite | Midnight |
|---|---|---|---|---|---|
| sanity (token → computed) | #7e5c0c → rgb(126,92,12) | #e0b43f → rgb(224,180,63) | #7a5a08 → rgb(122,90,8) | #7a5a08 → rgb(122,90,8) | #e0b43f → rgb(224,180,63) |
| orbit panel body | 12.69 | 12.85 | **13.17** | 12.69 | 12.33 |
| orbit de-emphasis (`-dim`) | 7.31 | 7.32 | 7.51 | 7.31 | 7.08 |
| safety digits on `black/25` | 15.26 | 14.45 | 14.90 | 15.26 | 14.00 |
| gold "Verified" on orbit | 5.65 | 7.86 | 6.60 | 5.65 | 7.61 |
| `on-sax` on the sax fill | 6.56 | 9.04 | 5.81 | 5.47 | 9.65 |
| white on the crane banner | 5.36 | 5.36 | 5.98 | 5.36 | 5.36 |
| `sax-ink` on card | 5.70 | 8.00 | 5.66 | 6.38 | 8.85 |
| `sax-ink` on the `sax/20` chip | 4.92 | 5.33 | 4.92 | 5.18 | 5.86 |
| `crane-ink` error text on card | 4.99 | 4.93 | 5.31 | 5.36 | 5.46 |
| white on a crane button | 5.36 | 5.36 | 5.98 | 5.36 | 5.36 |
| `on-crease` on a crease button | 6.78 | 7.14 | 6.73 | 6.78 | 7.61 |
| own-message bubble body | 6.78 | 7.14 | 6.73 | 6.78 | 7.61 |
| reply-quote `-dim` on the chip | 4.84 | 4.78 | 4.81 | 4.84 | 4.78 |
| bubble timestamp `-dim` | 6.13 | 5.72 | 6.06 | 6.13 | 5.79 |
| unread dot (graphic, 3.0) | 4.99 | 4.93 | 5.31 | 5.36 | 5.46 |
| connected dot (graphic, 3.0) | 5.70 | 8.00 | 5.66 | 6.38 | 8.85 |

**The headline row is Vellum's orbit panel: 1.27 → 13.17.** That is the
safety-number screen, the surface where a user confirms they are not being
MITM'd, in the theme that had made it invisible.

For comparison, the pre-fix values the audit reported — reproduced exactly by the
test before anything was changed, which is how the maths was checked:

| | Paper | Ink | Vellum | Graphite | Midnight |
|---|---|---|---|---|---|
| `text-sax` on card | **2.09** | 8.00 | **4.36** | **3.25** | 8.85 |
| white on `bg-sax` | **2.24** | **1.95** | 4.91 | **3.25** | **1.95** |
| white on orbit | 12.69 | 15.32 | **1.27** | 12.69 | 14.83 |

## Human / device confirmation

**2026-07-25 — confirmed on device by Anmol: "the themes look good on device."**

That closes the gap the ratios could not: these numbers say a pairing is legible,
not that the result is *good*. The two changes that needed a human eye rather than
a calculator were Vellum's console panel going from light parchment to dark
aubergine, and `--color-crane` shifting brand-wide from #E84A27 to #C23A1C
(Midnight Crane is nominally "crane-forward", so that one was a real judgement
call). Both accepted.

## Still outstanding

- The harness pages live in the job's scratch directory and are not committed;
  regenerate them from the built CSS if these numbers need re-checking.
- `--color-orbit-ink` is defined in all six token blocks and used by nothing.
  Pre-existing, untouched by this work — flagged so a future reader doesn't
  assume it is live.
