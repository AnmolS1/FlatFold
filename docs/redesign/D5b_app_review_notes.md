# App Review notes — the text to paste into App Store Connect

Written 2026-07-25. Supersedes the "App Review notes" stub in `D5_appstore_copy.md`,
which had blank demo credentials and assumed the reviewer would create the second
account themselves.

**Passwords are not in this file.** Both demo accounts share one password, which
lives in `.env.asc` (gitignored) and goes into App Store Connect's *Sign-In
Information* field and nowhere else. That is why the notes below say "the same
password as the first account" rather than repeating it — these notes are
attached to a submission and are not protected information.

---

## Why there are two demo accounts

FlatFold is end-to-end encrypted between real users. **One account cannot
demonstrate a conversation** — there is no server-side history to show and no
bot to talk to. So a reviewer needs a second party, and the previous draft asked
them to create one. Handing them both removes a step that could go wrong.

## Four things that look like bugs and are not

These are the ones that will cost a review if the notes don't say them.

1. **The account starts completely empty.** No messages, no contacts. Message
   history is encrypted and stored *on the device*, not on the server, so there
   is nothing to pre-load into a demo account. An empty conversation list is a
   successful login, not a failed one.
2. **After signing in, the app asks for a password again.** This is the local
   keystore unlock, a separate step from the server session, and it takes the
   *same* password. It is not a failed login and not a second account.
3. **Sign in to both accounts once before adding them as contacts.** An account
   that has never signed in anywhere has not yet published its public keys, and
   adding it returns "That user has not published key material yet."
4. **Sign-in is rate-limited to 10 attempts per 5 minutes per username.** A few
   mistyped passwords produce a throttle message that reads like an outage.

## One more, for whoever submits — do not paste this into ASC

Each account should stay on the device it was first signed in on. Signing an
account in somewhere new mints a fresh device identity, and the other side then
correctly shows a "safety number changed" warning. That is the app working, but
it looks alarming mid-review. This is also why neither demo account has keys
published or contacts added in advance: doing either would guarantee the warning
(or worse — a message encrypted to a key the reviewer's device no longer holds,
which arrives as a decryption failure rather than a message).

The iOS Simulator cannot reach a signed-in state at all: Argon2 and the HPKE
WebAssembly segfault there. Real hardware only. App Review uses real devices, so
this is a note for us, not for them.

---

## The text to paste into App Store Connect

> FlatFold is a free, open-source, end-to-end encrypted messenger. There are no
> in-app purchases and no ads. An account is a username and a password — there
> is no phone number, no email, and no verification step.
>
> **Two demo accounts are provided**, because messages are end-to-end encrypted
> between real users and a single account cannot show a conversation.
>
> - Account A: `flatfold_review1` — password in the Sign-In Information field above.
> - Account B: `flatfold_review2` — **the same password as account A.**
>
> **Suggested run-through**
>
> 1. Sign in as `flatfold_review1` on the device.
> 2. You will then be asked to unlock — enter the **same password** again. This
>    is expected. Your messages are encrypted on the device under a key derived
>    from your password, and unlocking that store is a separate step from signing
>    in. It is not a second account.
> 3. Open https://flatfold.ponderance.dev in a browser on another machine and
>    sign in as `flatfold_review2` the same way. The app is one account at a
>    time, so the second account needs a second place to run; the web app is the
>    same application.
> 4. Back on the device, go to Contacts, add `flatfold_review2` by that exact
>    username, and send a message. There is no user directory and no search —
>    you add someone by knowing their username. That is deliberate.
> 5. Reply from the browser. Both sides should update within a second or two.
> 6. Try a photo and a voice note (hold the microphone in the composer).
> 7. To see the encryption verification, open the conversation, tap the header,
>    and view the safety number and its QR code. This is how two people confirm
>    nobody is intercepting them.
>
> **Please expect the following. None of them is a failure.**
>
> - **Both accounts start empty** — no messages and no contacts. Message history
>   is encrypted and kept on the device, never on our server, so there is nothing
>   we can pre-load into a demo account.
> - **The unlock prompt after signing in** is the local encrypted store, and it
>   takes the same password (step 2 above).
> - **Please sign in to both accounts once before adding them as contacts.** An
>   account that has never signed in anywhere has not yet published its public
>   keys, and adding it will say so.
> - **Sign-in allows 10 attempts per 5 minutes per username**, so a few mistyped
>   passwords will produce a throttling message rather than a sign-in error.
> - **Notifications never show a sender or any message text** — only "New
>   activity". That is intentional and central to what the app is for; a
>   notification that leaked "Alice: hey" would undo the privacy model.
>
> **Encryption / export compliance:** the app uses only standard, published
> cryptography, and its full source is publicly available at
> github.com/AnmolS1/FlatFold, so it is not subject to the EAR.
> `ITSAppUsesNonExemptEncryption` is set to false. There is no proprietary or
> non-standard cryptography. The threat model is published in the repository and
> the in-app Transparency page describes exactly what the server stores.

---

## Before submitting — checklist

- [ ] Paste the shared password into App Store Connect → App Review Information →
      **Sign-In Information**. Username field: `flatfold_review1`. Put account B's
      username in the notes (as above), never its password.
- [ ] Confirm both accounts still sign in (`POST /api/auth/login` against prod, or
      just sign in on the web app). They were created and verified 2026-07-25.
- [ ] Do **not** enable 2FA or a recovery code on either account.
- [ ] Confirm the reviewed build ships the Transparency page and that the public
      threat model is reachable, since the description points at both.
- [ ] If either account is ever signed in from a new place for testing, expect
      the safety-number warning and consider recreating the pair.
