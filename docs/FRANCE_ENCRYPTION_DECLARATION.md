# FlatFold — France (ANSSI) encryption declaration content

The substantive content for FlatFold's French encryption declaration under Décret n°2007-663 (déclaration for the *supply* of a means of cryptology using standard algorithms). Drop this into whichever channel your App Store Connect account presents — the native ASC France encryption flow, or the ANSSI form emailed to `controle@ssi.gouv.fr` with the completed form uploaded to ASC. Confirm the exact fields in the live flow; this covers everything either one asks for.

**Filing as:** Anmol Saxena (individual), matching the Apple Developer account.
**Language note:** written in English for clarity. A direct ANSSI form submission may need French; if you go that route rather than ASC-native, tell me and I'll translate this into the French declaration wording.
**Not legal advice** — confirm against the current ANSSI declaration form / ASC flow before submitting.

---

## Declarant (Déclarant)

- **Name:** Anmol Saxena (individual developer; the Apple Developer account holder).
- **Contact email:** security@flatfold.ponderance.dev
- **Role:** developer and supplier of the application.
- *(Provide the mailing address the ANSSI form requires at submission — not recorded here to keep this file free of personal address data. If the LLC is formed later, refile naming Ponderance LLC as declarant.)*

## The means of cryptology (Le moyen de cryptologie)

- **Name:** FlatFold
- **Type:** a free, open-source, end-to-end encrypted messaging application (iOS/iPadOS/macOS/Android, plus a web app).
- **Source code:** publicly available under AGPL-3.0 at https://github.com/AnmolS1/FlatFold — the full implementation is open to inspection.
- **Nature of the declaration:** *fourniture* (supply / making available) of a means of cryptology to users, including users in France, via the App Store and the web.

## Cryptographic functionality (Fonctions assurées)

FlatFold provides **confidentiality**, **integrity**, and **authentication** of user communications and stored data:

- **Confidentiality:** end-to-end encryption of messages and media, so that only the communicating users — never the server — can read content.
- **Integrity + authentication:** message and sender authentication (per-message signatures in groups; authenticated key exchange in 1:1), and safety-number verification between users.
- **At-rest protection:** local key material is encrypted at rest on the device with a password-derived key.
- **Metadata protection:** a "sealed sender" mechanism reduces what the server learns about who is communicating.

## Algorithms and key lengths (Algorithmes et longueurs de clé)

All standard, published by recognized bodies (IETF / NIST). No proprietary or non-standard cryptography.

| Function | Algorithm | Key length | Reference |
| --- | --- | --- | --- |
| Key agreement | X25519 (Curve25519 ECDH) | 256-bit curve | RFC 7748 |
| Key agreement (HPKE DHKEM) | P-256 ECDH | 256-bit curve | NIST SP 800-56A |
| Signatures | Ed25519 | 256-bit | RFC 8032 |
| Symmetric AEAD | ChaCha20-Poly1305 | 256-bit key | RFC 8439 |
| Symmetric AEAD (HPKE) | AES-128-GCM | 128-bit key | NIST FIPS 197 / SP 800-38D |
| KDF | HKDF-SHA-256 | — | RFC 5869 |
| Hash / MAC | SHA-256, HMAC-SHA-256 | 256-bit | FIPS 180-4 / 198-1 |
| Password hashing | Argon2id | 256-bit output | RFC 9106 |
| Key-exchange / ratchet protocol | Signal protocol: X3DH + Double Ratchet + sender keys | — | published specs |
| Oblivious transport | HPKE (RFC 9180), OHTTP (RFC 9458) | — | RFCs |
| Transport security | TLS | — | RFC 8446 |

## Classification statement

Because every algorithm above is a standard, published algorithm, FlatFold falls under the **declaration** regime (déclaration), not the authorization regime (autorisation). It supplies confidentiality using only standard cryptography, and its complete source is publicly available for verification.

## Submission checklist

1. Confirm the current channel in App Store Connect: native France encryption declaration flow, or ANSSI form → `controle@ssi.gouv.fr` → upload completed form to ASC.
2. Add the declarant mailing address to the form (kept out of this file).
3. If submitting the ANSSI form directly (not ASC-native), get this content translated into French first.
4. Submit before you need the France release live (allow ~1 month for ANSSI).
5. File the returned/completed declaration reference in your records alongside `ENCRYPTION_COMPLIANCE.md`.
