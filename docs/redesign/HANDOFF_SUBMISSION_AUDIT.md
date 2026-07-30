# Handoff — App Store submission audit (iOS + macOS)

For Cowork. Written 2026-07-28. Everything in §1 was **read from the App Store
Connect API today**, not from memory or from these docs; §2 is what that reading
found; §3 is what the API cannot answer and therefore needs a human with a
browser; §4 is the audit itself.

Read `docs/STATUS.md` first for what the app is and the frozen paths.

**Nothing has ever been submitted.** `reviewSubmissions` is empty, both platform
versions are `PREPARE_FOR_SUBMISSION`, and `apps.apple.com/app/id6793349838`
returns 404. So this is a first submission on both platforms, with no rejection
history to inherit.

---

## 1. Measured state — App Store Connect, app `6793349838` (`dev.flatfold`)

| thing | iOS | macOS |
| --- | --- | --- |
| version record | 1.0, `PREPARE_FOR_SUBMISSION` | 1.0, `PREPARE_FOR_SUBMISSION` |
| build attached | **build 2** (uploaded 2026-07-24, `VALID`) | **none — `/build` returns `data: null`** |
| screenshots | **0 sets** | **0 sets** |
| description / keywords / promo | complete | complete (identical copy) |
| marketing + support URL | set, both HTTP 200 | same |
| review contact + demo account | populated | populated |
| review **notes** | **empty** | **empty** |

Shared across both:

- **Name** FlatFold, **subtitle** "Private chats, just a username".
- **Privacy policy URL** `https://ponderance.dev/privacy/` — HTTP 200.
- **Categories** primary `SOCIAL_NETWORKING`, secondary `UTILITIES`.
- **Age rating** `FOUR_PLUS`, `messagingAndChat: true`, everything else NONE/false.
- **Price** free (`customerPrice 0.0`), base territory USA.
- **Availability** 175 territories, `availableInNewTerritories: true`.
- **EULA** none set → Apple's standard EULA applies. FlatFold is AGPL-3.0; worth
  a deliberate decision rather than a default.
- **Accessibility declarations** — `/v1/apps/6793349838/accessibilityDeclarations`
  returns `total: 0`. **Nothing declared, for any device family.**
- **Builds** two, both iOS. Build 1 (2026-07-21) has `usesNonExemptEncryption:
  null`; build 2 has `false`. Neither expired.
- **TestFlight beta review detail** every field null.

### Reproducing this

The ASC API key is `AuthKey_2MDZ3YJRLG.p8` in the repo root (gitignored); the
issuer id is `ASC_API_ISSUER_ID` in `~/GitHub/ponderance/.env`. Mint an ES256 JWT
and **use `dsaEncoding: 'ieee-p1363'`** — Node's default DER encoding produces a
signature Apple rejects with a bare 401, which reads as a bad key. Never print
the key or the token.

Two API shapes that waste time: `include` is rejected on
`/v1/apps/{id}/builds` (use `/v1/builds?filter[app]=`), and
`include=appStoreVersions` on the apps list silently returns no version
attributes — fetch versions per app.

## 2. What that reading found

**Two hard blockers.**

1. **No screenshots, on either platform.** A version cannot be submitted without
   them. Sizes previously used across these apps: iPhone 1284×2778, iPad
   2064×2752, Mac 2880×1800.
2. **No macOS build has ever been uploaded.** The Mac version record exists and
   is fully written, with nothing attached to it. The Catalyst app builds and
   runs locally today; what is missing is signing, archiving and upload, which
   `docs/STATUS.md` still lists as undecided.

**Five things to resolve, none of them mechanical.**

3. **Accessibility Nutrition Labels are entirely undeclared.** The API confirms
   zero declarations. Whether they are *required* for a new submission as of
   today is the open question — confirm against current App Review rules rather
   than assuming either way. FlatFold has had an accessibility pass, so there
   should be real answers to give here.
4. **The review notes field is empty on both platforms, and it must not be.**
   `redesign/D5b_app_review_notes.md` exists and explains something a reviewer
   cannot work out alone: FlatFold needs **two** demo accounts, because messages
   are end-to-end encrypted and there is no server-side history to pre-load, so
   a single account shows an empty conversation list and looks broken. ASC's
   `demoAccountName` is a single field and holds one account; the second, and
   the explanation, have nowhere to live except the notes. **Submitting as-is
   invites a rejection that the repo already knows how to prevent.**
6. **`PrivacyInfo.xcprivacy` and `D6_app_privacy_label.md` disagree.** The
   manifest declares exactly one collected type, `NSPrivacyCollectedDataTypeUserID`
   (linked, App Functionality). D6 says the **push token** should also be
   disclosed, as a linked identifier, and flags it `[sign-off]`. Either the
   sign-off went the other way and D6 is stale, or the manifest is incomplete.
   The App Privacy answers must match the manifest, so resolve this before
   filling the label in.
7. **The Mac layout.** `docs/NATIVE_MACOS_PLAN.md` records a layout dead-end
   above 900px that already ships on iPad and that Catalyst inherits unchanged.
   That is a Mac screenshot problem before it is a review problem — you cannot
   take a good 2880×1800 shot of a layout that does not use the width.

**One thing that looks like a finding and is not.** `ITSAppUsesNonExemptEncryption`
is `false` for an app that ships X3DH and the Double Ratchet. That is deliberate
and reasoned in `docs/ENCRYPTION_COMPLIANCE.md` §3: FlatFold's complete source is
public, which releases it from the EAR outright under the November 2024 BIS rule,
so no US documentation is required. Do not "fix" it without reading that doc.

## 3. What the API cannot answer

**App Privacy — the nutrition labels — are not in the public ASC API.** There is
no `appPrivacyDetails` relationship on `/v1/apps/{id}`; the full relationship
list was enumerated to confirm it rather than inferred from a 404. So the actual
saved state of the privacy questionnaire **can only be read in the ASC web UI**,
and no automated check will catch a drift between it and `D6_app_privacy_label.md`.
That is the single highest-value manual check in this audit, because it is both
unverifiable from here and the thing an E2EE messenger is most likely to be
challenged on.

Also unreadable from here: whether the screenshots that get uploaded actually
show what the copy claims, and whether the Mac build behaves once signed.

## 4. The audit

Verify, in roughly this order — the first two gate everything else:

1. **Privacy labels in the ASC web UI, against `D6_app_privacy_label.md`,
   against `PrivacyInfo.xcprivacy`, and against what the code actually sends.**
   D6 leaves three `[sign-off]` calls open, and the load-bearing one is
   declaring end-to-end-encrypted content as *not collected*. It is honest and
   it is what other E2EE messengers do — but it is affirmative, and it should be
   signed off knowingly rather than inherited from a draft.
2. **Accessibility labels** — whether required, and what the truthful answers
   are given the accessibility pass already done.
3. **The store copy against the app as it exists today.** The description
   promises "one-to-one and group chats, photos, files, and voice notes",
   disappearing messages, a panic wipe, and content-free notifications. Check
   each against the shipped build, on both platforms. Mac-specific gaps are
   known and listed in `redesign/HANDOFF_2026-07-28.md` — native file save is
   missing on Catalyst, and voice-note waveforms are flat there.
4. **The transparency page against the server.** The copy says there is "a
   plain-language page in the app that lists every single thing the server
   stores". That is a checkable claim: read `/transparency` against
   `worker/` and the D1 schema, and confirm the list is complete.
5. **The review notes**, per §2.4.
6. ~~Encryption and France~~ — **NOTHING TO DO.** The ANSSI déclaration was
   filed and **accepted 2026-07-25**; France is closed and stays in the
   territory list. Noted rather than deleted because this has been wrongly
   raised as open more than once, always by reading `ENCRYPTION_COMPLIANCE.md`
   §4 (written in the future tense) without `STATUS.md`, which has said
   "ANSSI declaration accepted" all along. §4 now leads with a status banner.
7. **The macOS path end to end**: signing, archive, upload, and whether the Mac
   build is worth submitting at all given the known Catalyst gaps.

## 5. Constraints

The repo is **public**. Do not commit secrets, tokens, demo-account passwords,
phone numbers or email addresses — the ASC API returns all of these and none of
them belong in a doc here. `.env` and the `.p8` keys are gitignored; point at
them, never copy them.

Frozen paths: `src/crypto/**`, `src/keystore/**`, `worker/**`, and the ratchet
region of `src/lib/messaging.ts`. This audit should need none of them.

Commit by explicit path, never `git add -A`.
