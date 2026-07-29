# FlatFold — encryption export compliance record

The master reference for FlatFold's encryption export status: the classification, the basis for it, and the exact answers to give Apple. Point back here on every App Store submission and any annual review.

**Not legal advice.** This reflects the current BIS / ANSSI / Apple rules as of July 2026 (sources at the end) and FlatFold's specific facts. Confirm the live App Store Connect wording and the France submission channel when you actually file, and if you want extra assurance have someone who's filed encryption paperwork look it over. Filings are amendable, so nothing here is one-way.

**Filing party:** Anmol Saxena (individual), matching the Apple Developer account. See "Changing to the LLC later" at the end — this is updatable.

## 1. What FlatFold's encryption is

FlatFold is a free, open-source (AGPL-3.0), end-to-end encrypted messenger. Its complete source is public at https://github.com/AnmolS1/FlatFold. All cryptography is standard and published by recognized standards bodies (IETF / NIST); none is proprietary or "non-standard" in the export sense.

| Function | Algorithm(s) | Standard |
| --- | --- | --- |
| Key agreement | X25519 (Curve25519 ECDH); P-256 ECDH (inside HPKE DHKEM) | RFC 7748; NIST FIPS 186 / SP 800-56A |
| Digital signatures | Ed25519 | RFC 8032 |
| AEAD encryption | ChaCha20-Poly1305; AES-128-GCM (HPKE) | RFC 8439; NIST FIPS 197 / SP 800-38D |
| KDF / hash / MAC | HKDF-SHA-256, SHA-256, HMAC-SHA-256 | RFC 5869; FIPS 180-4; FIPS 198-1 |
| Password hashing | Argon2id | RFC 9106 |
| Protocols | Signal protocol (X3DH, Double Ratchet, sender keys); HPKE (RFC 9180); OHTTP (RFC 9458); TLS | published specs / RFCs |

Purpose: end-to-end confidentiality, integrity, and authentication of user messages and media, plus at-rest protection of keys. Encryption is a means to the messenger's function, not a separately-sold product feature.

## 2. United States (EAR) — not subject to the EAR, nothing to file

**Determination: FlatFold is not subject to the EAR.** Its complete encryption source code is publicly available, which — following a BIS Final Rule published November 2024 — is released from the EAR **without any email notification**. The prior §742.15(b) requirement to email BIS and the ENC Encryption Request Coordinator with the source URL was eliminated by that rule. Publicly available encryption **object code** (the compiled App Store binary) is likewise not subject to the EAR when the corresponding source is publicly available. FlatFold's own complete source is published, so it qualifies on that basis (not merely because it uses open-source libraries like `@noble`).

Consequences:

- **No §742.15(b) email** to send (requirement eliminated Nov 2024).
- **No annual self-classification report** and **no CCATS** — those attach to the mass-market `5D992.c` License Exception ENC path, which FlatFold does not need to use.
- **Trigger to revisit:** this determination rests on FlatFold being (a) publicly-available open source and (b) free. If it ever goes closed-source or paid, redo the analysis — it would then likely be a `5D992.c` self-classification with an annual report.

## 3. Apple App Store Connect answers

Record of the answers to give, consistent with the determination above:

- **"What type of encryption algorithms does your app implement?"** → **"Standard encryption algorithms instead of, or in addition to, using or accessing the encryption within Apple's operating system."** (FlatFold ships its own standard, published crypto beyond system TLS.)
- **Exemption follow-up (if shown):** FlatFold qualifies for exemption — its encryption is publicly-available open source and not subject to the EAR (a Category 5 Part 2 basis). Answer that it qualifies for the exemption.
- **`ITSAppUsesNonExemptEncryption` in `Info.plist`:** set to **`false`** — FlatFold uses only encryption that is exempt / not subject to the EAR, so no US export documentation is required and the prompt won't recur on every TestFlight build. (Verify the exact exemption wording in your live ASC flow; if in doubt, the conservative alternative is to set `true` and record this document as the compliance basis. Either is amendable.)

**Important:** the US exemption above does **not** cover France. France is a separate requirement (next section) triggered by distributing an encryption app to French users, regardless of the US answer.

## 4. France (ANSSI) — FILED AND ACCEPTED 2026-07-25. Nothing to do.

> **STATUS: DONE.** The déclaration was filed and **ANSSI accepted it on
> 2026-07-25**. France compliance is closed. Do not re-raise it as an open item,
> and do not drop France from the territory list.
>
> This banner exists because the rest of this section is written in the future
> tense — "we're doing it", "file before you need the France release live" —
> and reads as pending to anyone who lands here without also reading
> `STATUS.md`. That has now cost several people the same wrong conclusion.

### How it was done, for the record

France (Décret n°2007-663) requires a declaration to ANSSI to *supply* a means of cryptology to French users. FlatFold provides secure communications and secure storage, which are controlled categories (no banking/medical exemption applies). Because every algorithm is **standard**, FlatFold needs a **déclaration** (the lighter path), not a *demande d'autorisation* (which is only for non-standard cryptography).

The declaration content is drafted in `FRANCE_ENCRYPTION_DECLARATION.md`. Submission channel (confirm in your live ASC flow — the sources conflict on which is current):

- Newer path: submit the encryption declaration directly through **App Store Connect's** France encryption flow.
- Traditional path: complete the ANSSI declaration form and email it to **controle@ssi.gouv.fr** (post is also accepted), then upload the completed form in App Store Connect when submitting the app. Apple wants the completed form, not the acknowledgement.

Whichever your account presents, the substantive content is the same and is in the France doc. Historically ANSSI takes roughly a month. (Filed and accepted 2026-07-25 — see the banner above.)

## 5. Changing to the LLC later

Filing as yourself now is fine and reversible:

- **US:** there is no US filing to update (FlatFold is not subject to the EAR). If you form the LLC and keep FlatFold free + open-source, there's still nothing to file. Only a move to closed-source/paid would create a filing, at which point you'd file as whichever entity then owns it.
- **France:** the ANSSI declaration names the declarant (you). If the responsible entity later becomes Ponderance LLC, file an updated/superseding declaration under the LLC — declarations can be re-filed. Keep it consistent with whoever owns the Apple Developer account at that time.
- **Apple:** the bigger entity change is the Apple Developer account type (individual → organization), which is a separate Apple process and the thing to plan around when the LLC forms; the encryption answers themselves carry over unchanged.

So: proceed as an individual now, and revisit only the France declarant + the Apple account type when the LLC exists.

## Sources (verify currency at filing time)

- BIS — Encryption items not subject to the EAR: https://www.bis.gov/learn-support/encryption-controls/encryption-items-not-subject-to-ear
- BIS Final Rule (Nov 2024) eliminating the §742.15(b) email + easing mass-market reporting (law-firm summaries): https://www.wsgr.com/en/insights/us-department-of-commerces-bureau-of-industry-and-security-relaxes-several-classification-and-reporting-requirements-for-encryption-items.html and https://sanctionsnews.bakermckenzie.com/bis-updates-reporting-requirements-relating-to-mass-market-encryption-items-and-publicly-available-software-and-also-updates-certain-classifications/
- Apple — Export compliance documentation for encryption: https://developer.apple.com/help/app-store-connect/reference/export-compliance-documentation-for-encryption/
- ANSSI (France) — encryption controls: https://cyber.gouv.fr
- Cryptomator — France App Store walkthrough (older but clear on mechanics): https://cryptomator.org/blog/2016/06/16/indepth-french-app-store/
