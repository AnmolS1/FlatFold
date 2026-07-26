# D5b — Google Play copy + Data Safety

Android/Play equivalent of D5, in Anmol's voice (ran the write-like-anmol two-pass: no em-dashes, no "just", no buzzwords, honest). Play's fields differ from Apple's (no keyword field — discovery comes from the title + description).

## Title (limit 30)
`FlatFold: private messenger` — 27 chars.

## Short description (limit 80)
`Encrypted chat, no phone number, and a server that keeps almost nothing.` — 71 chars.

## Full description (limit 4000)

FlatFold is a private messenger. Your messages are end-to-end encrypted on your device, so only the people in a conversation can read them. The server holds the encrypted text only long enough to deliver it, then drops it. It never sees what you said, and it can't hand over what it doesn't have.

Signing up takes a username and a password. No phone number, no email, nothing that ties the app to the rest of your life.

It's the ordinary things, done privately: one-to-one and group chats, photos, files, and voice notes, all encrypted end to end. Messages that disappear on a timer when you want them to. A panic wipe that clears everything on your device in one move. Notifications that wake the app without carrying a word of what was said. Optional two-factor for signing in, and a recovery code so a forgotten password doesn't have to mean a lost account.

The whole thing is open source, and that matters more here than usual. An encrypted messenger asks you to trust it, and the honest way to earn that is to let anyone read exactly how it works. So the code is public, and there's a plain-language page in the app that lists every single thing the server stores. It's a short list on purpose.

What it doesn't do: track you, show ads, sell anything, or ask who you are. There's no account to monetize, because there's barely an account at all.

If your threat model is serious, read the threat model. It's public, and it's honest about the limits too, including the ones a messenger delivered through an app store can't fully escape.

(~1,340 chars — well under 4000.)

## Data Safety form (Play's version of the privacy label)
Mirror the honest story in D6:
- **Data collected / shared:** username (account management, app functionality; linked; not for tracking); push token if notifications are on (app functionality; linked; not for tracking); if 2FA/recovery are enabled, the TOTP secret + backup-code hashes + recovery verifier/blob (account management/security; linked; the blob is opaque to the server). No data shared with third parties.
- **Not collected:** message content, photos, files, voice notes (end-to-end encrypted, not accessible to the developer); contacts (on-device only); location; diagnostics/analytics. No third-party SDKs.
- **Security practices:** data encrypted in transit; end-to-end encryption for message content; the user can request deletion (account deletion wipes server-side data). Answer "yes" to "data encrypted in transit" and the E2E option.
- **[sign-off]** the E2E-content-not-collected position and the privacy-policy URL need Anmol's confirmation, same as D6.

## Store graphics still needed (not copy)
Play requires a **512×512 icon** (`flatfold-play-listing-512.png`, delivered in `brand/`), a **1024×500 feature graphic**, and **phone screenshots**. The feature graphic and screenshots come from the built app — say the word and I'll design the feature graphic from the brand; screenshots come from the running app (Claude Code / on-device).

## French listing
Since France is in scope, a French translation of the title, short description, and full description is worth doing for the FR locale — tell me and I'll produce it in the same voice.
