# D3 — theme system

Five themes: two base (Paper, Ink) and three branded (Vellum, Graphite, Midnight Crane), all rooted in the folded-paper brand. Every text/background pair below was contrast-checked with alpha-composited colors (secondary text is a real rgba over its actual surface, not the raw hex) and **passes WCAG AA** — ratios are in §3.

## 1. Behavior

- **Default to the OS** (`prefers-color-scheme`) on first launch: dark OS → Ink, light OS → Paper. Follow live OS changes unless the user has picked a theme.
- **User override** in Settings persists (the existing `ThemeContext` already persists a choice); an "Automatic" option returns to following the OS.
- Wire these as token sets in `ThemeContext` + the Tailwind v4 `@theme`/`:root` layers. Keep the existing token *names* (`--color-graph`, `--color-graph-card`, `--color-inset`, `--color-graphite`, `--color-graphite-60/-40`, `--color-crease`, `--color-crease-line`, `--color-grid-line`, `--color-crane`, `--color-sax`, `--color-orbit`); each theme just supplies different values for them. That way no component changes — only the token values swap.

## 2. Token values per theme

Roles: `page` = app background (`--color-graph`); `surface` = cards/bubbles-received (`--color-graph-card`); `inset` = inputs (`--color-inset`); `ink` = primary text (`--color-graphite`); `ink-2` = secondary text (`--color-graphite-60`); `structural` = borders/links/own-bubble (`--color-crease`); `accent` = attention/unread/warnings (`--color-crane`); `hairline` = `--color-crease-line`.

Primary action buttons use the `structural` fill with white (or ink) text — not `accent` — because `accent` (crane) is reserved for small non-text attention marks (unread dots, key-change warnings). This keeps the one bold color meaningful and keeps button text AA.

### Paper (light, default)
| role | value | role | value |
|---|---|---|---|
| page | `#EEF0EC` | ink | `#1B2A33` |
| surface | `#F6F7F4` | ink-2 | `rgba(27,42,51,0.72)` |
| inset | `#FFFFFF` | structural | `#2E5E8C` |
| hairline | `rgba(46,94,140,0.13)` | accent | `#E84A27` (warnings use `#C23A1C`) |

### Ink (dark, default)
| role | value | role | value |
|---|---|---|---|
| page | `#0E1A24` | ink | `#E9ECE7` |
| surface | `#182530` | ink-2 | `rgba(233,236,231,0.70)` |
| inset | `#1E2C38` | structural | `#82A9CE` |
| hairline | `rgba(130,169,206,0.16)` | accent | `#E84A27` |
Own-bubble/button fill uses `#2E5E8C` with white text, or `#82A9CE` with ink text — both AA.

### Vellum (branded — warm parchment, calmest)
| role | value | role | value |
|---|---|---|---|
| page | `#EFE7D6` | ink | `#3A2F23` |
| surface | `#F7F1E4` | ink-2 | `#6B5C48` |
| inset | `#FFFDF7` | structural | `#8A4B2A` (sienna) |
| hairline | `rgba(138,75,42,0.15)` | accent | `#B23A1B` |

### Graphite (branded — crisp high-contrast mono, minimal)
| role | value | role | value |
|---|---|---|---|
| page | `#FBFBFA` | ink | `#16181A` |
| surface | `#FFFFFF` | ink-2 | `#4A4E52` |
| inset | `#FFFFFF` | structural | `#2E5E8C` |
| hairline | `rgba(22,24,26,0.12)` | accent | `#C23A1C` |

### Midnight Crane (branded — warm dark, crane-forward)
| role | value | role | value |
|---|---|---|---|
| page | `#14110E` | ink | `#F0E9E2` |
| surface | `#1F1A15` | ink-2 | `rgba(240,233,226,0.70)` |
| inset | `#251F19` | structural | `#F08A5D` (warm crane) |
| hairline | `rgba(240,138,93,0.18)` | accent | `#E84A27` |
Button fill uses `#F08A5D` with ink text (AA).

## 3. Verified contrast (WCAG AA; body needs 4.5, large/non-text 3.0)

| theme | primary/page | primary/surface | secondary/surface | structural text | button text | warn/accent |
|---|---|---|---|---|---|---|
| Paper | 12.84 | 13.70 | 5.74 | 6.31 | 6.78 | 4.99 |
| Ink | 14.78 | 13.09 | 7.09 | 6.33 | 7.14 | 4.04 (accent, need 3) |
| Vellum | 10.60 | 11.58 | 5.74 | 5.98 | 6.73 | 5.31 |
| Graphite | 17.19 | 17.80 | 8.39 | 6.78 | 17.80 | 5.36 |
| Midnight Crane | 15.64 | 14.35 | 7.59 | 6.98 | 7.61 | 4.47 (accent, need 3) |

All pass. Re-run the check (the script pattern in the D3 work) any time a token value changes, and always composite alpha over the actual surface before the ratio — a raw-hex check on `ink-2` would be wrong.

## 4. Notes for the implementer
- The graph-paper ground (`--color-grid-line`) is part of the brand across all themes; derive it from `structural` at ~7% so it re-tints per theme automatically.
- `--color-sax` (gold, verified state) and `--color-orbit` (indigo, verification panel) should get a per-theme value too; keep sax readable as a small check mark (non-text, ≥3:1 against surface) and orbit legible as a panel with white/ink text — verify if you change them.
- Ship "Automatic / Paper / Ink / Vellum / Graphite / Midnight Crane" in the Settings theme picker; Automatic is the default.
