# D1 — native UX directions

Three directions for the FlatFold native redesign, each shown as a conversation-list mockup (it sets the nav model, density, and control count). The chat/composer treatment — where the actual viewport bugs lived — is described per direction below. All three kill the two structural bugs the same way: **no floating FAB** (compose is a docked/anchored control, never a button that fights the scroll/zoom), and **inputs at ≥16px text** so iOS never auto-zooms.

## Direction A — "Quiet Paper"
Maximum restraint. One screen at a time (push navigation), hairline-separated rows, and a **docked "New message" bar** at the bottom instead of a floating "+". Settings is a single header glyph; there is no second-level chrome. Fewest controls of the three.
- **Compose model:** tapping a conversation pushes to the chat; the composer is a docked bar pinned above the keyboard via the `visualViewport` API, 16px text, a single attach control and a mic/send that morphs. New-message is the bottom bar on the list screen, so there's never a floating element to scroll off-screen.
- **Feels like:** a calm paper note. Best match for the "as private as possible, honestly" north star.
- **Cost:** contacts and search live one tap in (behind compose / a pull-to-search), not top-level.

## Direction B — "Blueprint"
Leans into the crease-pattern brand: a faint graph-paper ground, mono timestamps, verification state surfaced in the list (gold check = verified), and a **bottom tab bar** (Chats / Contacts / Settings) for unambiguous native navigation.
- **Compose model:** same docked composer as A; new-message is the pencil in the header. The tab bar makes Contacts and Settings reachable in one tap from anywhere.
- **Feels like:** a well-kept engineering notebook. Most overtly "secure/technical," and the most discoverable nav.
- **Cost:** the persistent tab bar is more standing chrome than A — three visible tabs even when you only ever use one.

## Direction C — "Focus"
Densest and gesture-forward. Compact rows, compose and search as small header actions, and **swipe actions on rows** (pin/archive, and swipe-to-reply in chat). Closest to Signal's information density.
- **Compose model:** header compose action; in-chat composer identical to A/B. Gestures carry the secondary actions so there are fewer visible buttons.
- **Feels like:** fast and efficient for a power user.
- **Cost:** gestures are less discoverable, and the higher density reads as "efficient" more than "calm" — slightly against the trust-first tone.

## Recommendation: A as the frame, with B's brand and C's gestures folded in

Lead with **Quiet Paper (A)** because it most directly serves the north star (calm, minimal, trustworthy) and structurally removes the bug class (docked compose bar, fewest controls). Then borrow, at no clutter cost:

- from **Blueprint (B):** the faint graph-paper ground and mono for technical text (timestamps, safety numbers, usernames) — pure brand expression, no added controls. Keep B's bottom tab bar in reserve as the fallback if testing shows people can't find Contacts/Settings from A's leaner nav.
- from **Focus (C):** swipe actions on rows and swipe-to-reply as *secondary* affordances — standard iOS, and they let us remove visible buttons rather than add them.

That synthesis is a calm, minimal base, expressed in the brand, with power-user gestures layered on without new chrome. The D2 interaction spec is written against it. Easy to re-point if you prefer B's tab-bar nav or C's density as the primary — tell me which and I'll swap the spec's navigation section.
