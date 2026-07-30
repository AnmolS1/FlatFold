# D6 — App Privacy "nutrition label" answers

Draft answers for App Store Connect's App Privacy section, built from what FlatFold actually does. Reconcile against `PrivacyInfo.xcprivacy` and confirm the exact question wording in the live ASC flow before submitting (Apple revises the categories). Anything marked **[sign-off]** is a judgment call that needs Anmol's explicit OK.

## The short version
FlatFold collects almost nothing, and nothing for tracking. Apple's App Privacy model asks you to disclose data your app (or third-party SDKs) *collects* — where "collect" means transmitted off device and accessible to you beyond servicing the immediate request. FlatFold has no third-party SDKs, no analytics, no ads, and can't read message content, so the disclosable set is tiny.

## Data used to track you
**None.** No tracking, no ads, no data shared with data brokers, no cross-app/website tracking. (This lets you answer "No" to the tracking question outright.)

## Data collected and LINKED to the user (purpose: App Functionality only)

- **User ID — the username.** Collected and linked (it *is* the identity), used only for App Functionality (so people can find and message you). Not used for tracking, analytics, or advertising.
- **Identifiers — push token.** Only if the user turns on notifications. Collected and linked to the username, used only for App Functionality (to deliver a content-free "wake and sync" signal). Not used for tracking. The push payload carries no message content or sender. **[sign-off]** confirm you want to disclose the push token here vs. treating it as ephemeral; disclosing it is the conservative, honest choice.

That's the whole "linked" list. No name, no email, no phone number, no address, no contacts, no location, no usage data, no diagnostics.

## Data NOT collected (and why, so the label is defensible)

- **Message content, photos, files, voice notes:** end-to-end encrypted; the developer/server cannot read them and they're held only transiently for offline delivery, then deleted. Under Apple's definition (you never "access" it and it isn't retained beyond servicing delivery), this is **not collected**. This is the same position other end-to-end-encrypted messengers take. **[sign-off]** this is the one call Apple could scrutinize — it's honest and well-supported, but you're affirmatively declaring E2E content as not-collected, so sign off on it knowingly.
- **Contacts:** your contact list lives only in the encrypted on-device keystore and is never uploaded. Not collected.
- **Diagnostics / analytics / crash data:** none gathered; no SDKs. Not collected.
- **Location, browsing, purchases, identifiers for ads:** none.

## Consistency checks before submit
- **Match `PrivacyInfo.xcprivacy`.** The label answers must line up with the privacy manifest's declared collected-data types and any required-reason API declarations. Reconcile the two; if the manifest lists a data type this draft doesn't, resolve the discrepancy before submitting.
- **Privacy policy.** Apple requires a privacy-policy URL. The in-app `/transparency` page + the public threat model cover the substance, but confirm there's a formal privacy-policy URL wired in App Store Connect (the ponderance registry-driven `/privacy` page is the place for it). **[sign-off]** Anmol confirms the privacy-policy URL.
- **Third parties:** answer that no data is collected by third-party partners (true — no SDKs). If any analytics/crash tool is ever added, this section changes.

## Plain-language summary you can reuse
"To use FlatFold you give it a username and a password. That username, and a push token if you turn on notifications, are the only things linked to you, and they exist only to make the app work — never to track you. Your messages are end-to-end encrypted; the app can't read them and doesn't keep them. Your contacts stay on your device. There are no ads, no analytics, and no third-party trackers."
