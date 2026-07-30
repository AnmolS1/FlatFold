# D4 — app icon + splash

Files delivered in `brand/`:
- `flatfold-app-icon-1024.png` — the iOS app icon. 1024×1024, **RGB (no alpha)**, opaque cream background, fills the square with margin for iOS's corner rounding. Do not add transparency or pre-round the corners; iOS masks them.
- `app-icon-source.svg` — the editable source for the icon.
- `flatfold-splash-1242x2688.png` — a branded launch image (mark centered, wordmark below, cream ground).
- `splash-source.svg` — the editable source for the splash.

Design: the folded-paper mark (a sheet with one corner folded, crease-blue outline, a single crane-orange facet) on cream. Deliberately a *note that folds*, not a chat bubble — calm and trustworthy, distinct at small sizes.

## Placement (Claude Code)
- Replace the Capacitor placeholder in `ios/App/App/Assets.xcassets/AppIcon.appiconset` (currently only `AppIcon-512@2x.png`) with the 1024 icon as the single-size marketing icon (Xcode's single-size app-icon slot). Confirm the icon set has no alpha channel — App Store rejects icons with alpha.
- Wire the splash into the launch storyboard as a centered image on a cream (`#EEF0EC`) background. For the launch screen specifically, prefer a **mark-only, centered** image over baked-in text: it scales cleanly across devices and avoids font-embedding issues. The `flatfold-splash-1242x2688.png` here includes the wordmark for reference, but the sandbox render used a fallback font for "FlatFold" — if you keep the wordmark, re-render the splash with the bundled Bricolage Grotesque, or drop to mark-only.
- Provide a dark-appropriate launch background if the app launches in a dark theme (a Midnight Crane / Ink cream-swap), so the splash doesn't flash bright before the themed UI loads.

## If you want alternates
The source SVGs are parametric — a maskable/adaptive Android icon (safe-zone padded) and per-theme splash variants (Ink/Vellum grounds) are easy re-renders from the same mark. Ask and I'll produce them.
