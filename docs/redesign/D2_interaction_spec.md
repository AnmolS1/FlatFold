# D2 — interaction-model spec

The implementable native spec, written against the D1 recommendation (Quiet Paper frame + Blueprint brand ground + Focus gestures). This is intent and rules for the Claude Code session to build and verify on-device; it is not device-tested. Re-point the navigation section if the primary direction changes.

Cross-reference: the hard constraints bind everything here (no crypto/backend changes, reuse the native seams, preserve privacy behaviors, keep web working, a11y). They are restated in full under "Hard constraints" in `STATUS.md ("The hard constraints")`.

## 0. Global rules — these are what make the bug class impossible

1. **Every text input renders at ≥16px.** iOS Safari/WKWebView auto-zooms any focused input whose computed `font-size` is under 16px, and FlatFold's inputs were smaller. Set a hard floor: no `<input>`/`<textarea>`/`contenteditable` below 16px, ever. This single rule removes the "tap a field, viewport zooms and sticks" bug.
2. **Lock the viewport, own the keyboard.** `<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">` to block pinch/auto-zoom in the app context (native app, not the web build — gate this so the web build keeps user zoom). Drive layout off `visualViewport`: the composer and any bottom-docked bar sit on `visualViewport.height`, not `100vh`, so the keyboard never covers the input and the view never has to scroll to chase it. On blur, restore scroll position; never leave the viewport offset.
3. **No floating FAB.** Compose is a docked bar (list screen) or a header action — an element in normal flow, never `position: fixed` floating over a scroll container. This removes the "+ zooms and scrolls off the top" bug entirely.
4. **Safe areas + reachability.** Pad top/bottom with `env(safe-area-inset-*)`. Primary actions live in the bottom third (thumb zone); nothing critical in the top corners except the back affordance.
5. **44pt minimum tap target** on every interactive element; **native scroll containment** (`overscroll-behavior: contain`) so a chat scroll never rubber-bands the shell.
6. **Motion respects `prefers-reduced-motion`** (the paper-fold send animation included). **Type respects Dynamic Type.**

## 1. Navigation model

Push-navigation stack (Quiet Paper). Two persistent top-level surfaces reached from the conversation list:
- **Conversation list** = home. Header: wordmark left, a single settings glyph right. A docked "New message" bar at the bottom.
- **Settings** pushes from the header glyph; **new message / contacts** pushes from the docked bar (search-to-add lives inside that flow).
- **Chat** pushes from a row; back returns to the list.
- Keep Blueprint's **bottom tab bar (Chats / Contacts / Settings) in reserve** — if on-device testing shows people can't find Contacts/Settings, switch the list screen to a tab bar without touching any other screen.

## 2. Control inventory — what gets cut or merged

The current UI's problem is control count and footprint. Concrete cuts:
- **The duplicate "search locally" field + separate search button → one control.** A single search entry (a tappable pill that expands, or a header search glyph), never both a field and a button doing the same thing.
- **The floating "+" FAB → the docked "New message" bar** (list) — removed as a floating element.
- **Header buttons capped at two** per screen (a back/settings affordance + at most one contextual action). Everything else moves into a long-press action sheet or a swipe.
- **In-chat header:** name + verification state only, tappable to open the contact sheet; the timer/verify/panic controls live inside that sheet, not as separate header buttons.

## 3. Per-screen spec

### Conversation list
Rows 60–64px, initials avatar (circle for people, rounded-square for groups), name, mono timestamp, one-line snippet, an unread dot (crane). Verification state as a small gold check inline (Blueprint touch). Faint graph-paper ground. **Swipe actions** (Focus): swipe a row for pin/archive. Docked "New message" bar at the bottom. Empty state: an invitation, not an apology — "Add someone by their username to start" with the add action.

### Chat
Header: back chevron, username + verification line beneath (mono, e.g. "verified" / "not verified — tap to verify"); tapping the header opens the contact/verification sheet. Messages on the graph-paper ground; own = crease-blue bubble with light ink, received = surface bubble with a hairline; timestamps + delivery state mono, in-bubble. **Swipe-to-reply** on a bubble (Focus), **long-press** for the action sheet (copy, reply, delete for me, delete for everyone, details). Paper-fold send animation, reduced-motion-aware.

### Composer
Docked above the keyboard via `visualViewport`. 16px+ text. Left: one attach control (sheet: photo / file / voice). Right: mic that morphs to send when text is present. Reply chip appears above the field when replying. No control below 44pt. This is the highest-risk surface for the viewport bug — build and verify it first.

### Media
In-bubble: images inline (tap for full-screen viewer), files as a compact chip, voice notes as play + waveform + mono duration. Attach sheet is a bottom sheet, not a floating menu.

### Search
One entry point. Local-only (never networked — preserve that property and say so in the empty state: "Search stays on your device"). Results reuse the row component.

### Settings
Grouped list. A **Security** group (Sign out, Sign out everywhere, Delete account — ascending severity, delete last in danger color), a decoy-notification-label control, theme picker (D3), disappearing-message default, and panic wipe (deliberate two-step, plus the existing chord). Every privacy control from the current app must survive the redesign.

### Onboarding / login
Username + password only (no phone, no email) — make that a selling point in the copy on-screen, not a limitation. Keystore-unlock is a distinct step from server login; keep it visually distinct so users understand the two-lock model.

### Keystore-unlock
A focused single-purpose screen: unlock prompt, the panic-wipe escape hatch reachable here (works while locked), nothing else.

### Safety-number / QR
The verification surface on the indigo orbit panel with mono digit blocks + QR + camera scan. Key-change warning reuses this surface with a crane banner. This is a trust-critical screen — it should feel deliberate and a little ceremonial.

## 4. Where this lands in the code

- `src/pages/Chat.tsx` is the god-component (WS, message state, compose, groups, timers). The audit flags it for decomposition; this redesign is the moment to extract `useMailboxSocket` / `useConversationState` hooks and per-surface components **without touching the ratchet region**. Keep all crypto calls exactly where they are; only presentational structure moves.
- Surfaces: `src/components/chat/*` (MessageInput = the composer + voice/file; SafetyNumberDialog = camera/QR), `src/pages/Login.tsx`, `src/components/SettingsDialog.tsx`.
- Gate every native-only behavior (viewport lock, swipe gestures tuned for touch, docked keyboard model) on `isNativePlatform()` so the web build is unchanged.

## 5. Accessibility (carry forward + extend)

Keep the existing `useModalDialog` focus-trap/Escape/scroll-lock, the polite live region for incoming messages, and Dynamic-Type support. Extend: VoiceOver labels/roles on every new control (swipe actions need accessible equivalents — a long-press menu is the non-gesture path), logical focus order, 44pt targets, reduced-motion, and alpha-composite-before-WCAG for every themed color pair (see D3). Swipe-only actions must always have a discoverable non-gesture equivalent.

## 6. Build order (for the implementer)

1. Global rules §0 (viewport meta, 16px floor, `visualViewport` composer) — this alone fixes the reported bugs; verify on-device before anything else.
2. Conversation list + docked compose.
3. Chat + composer + gestures.
4. Settings (with the Security group + theme picker) and the verification surface.
5. Onboarding/unlock polish.
Each step: verify on the simulator/device with a screenshot, not the browser.
