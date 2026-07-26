# D5 — App Store Connect copy

Written for the audience in the brief (privacy-conscious, Signal-adjacent, technically literate, unhyped) and in Anmol's voice: honest, precise, quietly confident, no overclaiming, no crypto-jargon dump. Character counts noted against Apple's limits.

## Subtitle (limit 30)
`Private chat, only a username` — 29 chars.

Alternates if you want a different angle: `End-to-end encrypted messaging` (30), `Private by default, no number` (29).

## Promotional text (limit 170)
`A messenger that keeps almost nothing. End-to-end encrypted, no phone number or email, and open source so you don't have to take my word for it.` — 142 chars.

## Description (limit 4000)

FlatFold is a private messenger. Your messages are end-to-end encrypted on your device, so only the people in a conversation can read them. The server holds the encrypted text only long enough to deliver it, then drops it. It never sees what you said, and it can't hand over what it doesn't have.

Signing up takes a username and a password. No phone number, no email, nothing that ties the app to the rest of your life.

It's the ordinary things, done privately: one-to-one and group chats, photos, files, and voice notes, all encrypted end to end. Messages that disappear on a timer when you want them to. A panic wipe that clears everything on your device in one move. Notifications that wake the app without carrying a word of what was said.

The whole thing is open source, and that matters more here than usual. An encrypted messenger asks you to trust it, and the truthful way to earn that is to let anyone read exactly how it works. So the code is public, and there's a plain-language page in the app that lists every single thing the server stores. It's a short list because that's all there is.

What it doesn't do: track you, show ads, sell anything, or ask who you are. There's no account to monetize, because there's barely an account at all.

If your threat model is serious, read the threat model. It's public, and it's clear about the limits too, including the ones a messenger that runs in an app store can't fully escape.

(~1,180 chars — well under 4000. Room to add a short "what's new" or a line about specific platforms at submission if wanted.)

## Keywords (limit 100, comma-separated, spaces count)
`encrypted,private,privacy,e2ee,secure,messenger,anonymous,no phone,open source,end-to-end,burner` — ~96 chars.

Notes: don't repeat words already in the app name/subtitle (Apple indexes those separately, so "chat"/"username" are covered). Tune after you see which terms you want to rank for.

## App Review notes

FlatFold is a free, open-source, end-to-end encrypted messenger. No in-app purchases, no ads, no accounts beyond a username and password.

Getting in:
1. On first launch, tap Sign up. Enter any username and a password — there is no phone or email verification, so the reviewer can create an account instantly.
2. After signup you'll set/unlock a local keystore (a second password step that protects keys on the device). This is expected and is separate from signing in.

To test messaging, you need two accounts (messages are end-to-end encrypted between real users):
- Use the demo account below on one device/simulator, and create a second account to talk to it.
- Add a contact by their exact username (there's no directory — this is by design), then send a message, a photo, or a voice note (hold the mic in the composer).
- To see verification, open a conversation, tap the header, and view the safety number / QR.

**Superseded 2026-07-25 — see `D5b_app_review_notes.md` for the text to actually paste.**
Two demo accounts now exist on prod (`flatfold_review1`, `flatfold_review2`), sharing one
password that lives in `.env.asc` and goes only into App Store Connect's Sign-In Information
field. Do not fill a password in here: this file is review-notes copy, not protected storage.
D5b also covers the four behaviours that read as bugs to a reviewer (the account starts empty,
the second password prompt, sign in to both before adding contacts, and the sign-in throttle).

Encryption / export compliance: the app uses only standard, published cryptography and its full source is publicly available, so it is not subject to the EAR (see the encryption compliance record). `ITSAppUsesNonExemptEncryption` is set to false. There is no non-standard cryptography.

## Notes for whoever submits
- Ran through the write-like-anmol voice pass. If you tweak the description, keep it plain and honest — no "seamless / powerful / revolutionary," no exclamation marks, and don't claim "nothing stored" flatly (the honest version is "held only long enough to deliver, then dropped").
- The description references the in-app transparency page and the public threat model; make sure both ship in the reviewed build so the claims are verifiable.
- Localizations: if you ship to France (you are), a French translation of at least the description + subtitle is worth doing; say the word and I'll produce it in the same voice.
