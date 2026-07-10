-- Sealed sender (post-M7): each account publishes ONE "delivery token" — a
-- random string that lets others send to it over the sealed (sender-hidden)
-- OHTTP path. It is NOT a secret capability: it rides the (anonymously
-- fetchable) prekey bundle, so anyone who can fetch your bundle can obtain it.
-- Its value is anti-spam / per-recipient rate-limit hygiene and cutting off a
-- passive removed contact after a rotation, NOT cryptographic access control.
-- See docs/THREAT_MODEL.md. Nullable — an account has no token until it
-- publishes one; the recipient's Mailbox DO holds the authoritative valid set.
ALTER TABLE users ADD COLUMN seal_token TEXT;
