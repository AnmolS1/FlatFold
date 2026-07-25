// The COMPLETE, honest enumeration of every piece of state the FlatFold
// server persists. This is the single source of truth for the /transparency
// page — and `test/schema-drift.test.ts` fails the build if the D1 tables
// here ever drift from the actual migrations, so this page can't silently
// fall out of date when the schema changes.
//
// If you add a column or table in a migration, this file MUST be updated in
// the same change, or CI breaks. Durable Object storage (the offline queue
// and per-user counters) is NOT in the D1 migrations, so it's declared here
// by hand and carries no automated drift check — call that out.

export interface PersistedField {
	name: string;
	description: string;
}

export interface PersistedStore {
	name: string;
	storage: 'D1' | 'Durable Object';
	purpose: string;
	// Whether the schema-drift test cross-checks this against the migrations.
	driftChecked: boolean;
	fields: PersistedField[];
}

export const SERVER_STATE: PersistedStore[] = [
	{
		name: 'users',
		storage: 'D1',
		purpose: 'One row per account. No email, no phone number. Just a username and a password.',
		driftChecked: true,
		fields: [
			{ name: 'username', description: 'Your exact handle. This is how other people find you.' },
			{ name: 'password_verifier', description: 'An Argon2id hash of your password, with the salt baked in. Never the password itself.' },
			{ name: 'identity_pubkey', description: 'Your public identity keys (signing + DH). Public on purpose. People need them to message you.' },
			{ name: 'signed_prekey', description: 'A rotating signed public prekey for starting sessions. Also public.' },
			{ name: 'created_at', description: 'When you signed up, rounded to the minute.' },
			{ name: 'seal_token', description: 'A public "delivery token" people use to send you a message without showing who they are. Not a secret. It rides along with your public bundle, and it exists to cut spam, not to control access.' },
			{ name: 'token_epoch', description: 'A plain counter behind "Sign out everywhere." Bumping it invalidates all your current logins at once. It is just a number and says nothing about you or your devices.' },
			{ name: 'recovery_verifier', description: 'Only if you turned on a recovery code. An Argon2id hash of a separate authenticator derived from that code — so a recovery request can be checked against you before anything is handed back. Never the code itself, and it cannot decrypt anything.' },
			{ name: 'recovery_blob', description: 'Only if you turned on a recovery code. Your identity keys and contacts, encrypted under a key derived from your recovery code. Opaque to the server — it holds no key to read it. It is here so you can get back in on a new device. Your past messages are NOT in it; those only ever lived on your device.' },
			{ name: 'recovery_salt_rec', description: 'Only if you turned on a recovery code. A public salt for re-deriving the key that decrypts your recovery blob. Not a secret.' },
			{ name: 'recovery_salt_auth', description: 'Only if you turned on a recovery code. A public salt for re-deriving the recovery authenticator. Not a secret.' },
		],
	},
	{
		name: 'one_time_prekeys',
		storage: 'D1',
		purpose: 'A pool of your one-time public prekeys. Each one gets used up and deleted the moment someone starts a conversation with you.',
		driftChecked: true,
		fields: [
			{ name: 'id', description: 'Row identifier.' },
			{ name: 'username', description: 'Whose prekey this is.' },
			{ name: 'public_key', description: 'A one-time public prekey. Public, and deleted the moment it is used.' },
			{ name: 'created_at', description: 'When it was published.' },
		],
	},
	{
		name: 'rate_limits',
		storage: 'D1',
		purpose: 'Short-lived counters that slow down abuse. They cap how fast one account can look up prekey bundles, and one global bucket limits anonymous sealed-sender fetches too. Both are there to stop people scraping the user list. Old windows get pruned.',
		driftChecked: true,
		fields: [
			{ name: 'requester', description: 'The account doing the lookups.' },
			{ name: 'window_start', description: 'The current time window.' },
			{ name: 'count', description: 'How many lookups happened in this window.' },
		],
	},
	{
		name: 'push_subscriptions',
		storage: 'D1',
		purpose: 'Where to send a content-free "wake up and sync" push when you have a message waiting. No message content is ever pushed.',
		driftChecked: true,
		fields: [
			{ name: 'id', description: 'Row identifier.' },
			{ name: 'username', description: 'Whose device this is.' },
			{ name: 'endpoint', description: 'An opaque push-service URL. It carries no content, only a nudge to wake up and sync.' },
			{ name: 'created_at', description: 'When you turned notifications on.' },
		],
	},
	{
		name: 'apns_subscriptions',
		storage: 'D1',
		purpose:
			'The same content-free "wake up and sync" push as above, but for the native iOS app (which can’t use Web Push). No message content is ever pushed.',
		driftChecked: true,
		fields: [
			{ name: 'id', description: 'Row identifier.' },
			{ name: 'username', description: 'Whose device this is.' },
			{ name: 'device_token', description: 'An opaque Apple push token for your device. It carries no content, only a nudge to wake up and sync.' },
			{ name: 'environment', description: 'Which Apple push environment the token belongs to (sandbox during development, production otherwise). Says nothing about you.' },
			{ name: 'created_at', description: 'When you turned notifications on.' },
		],
	},
	{
		name: 'Mailbox (Durable Object storage)',
		storage: 'Durable Object',
		purpose: 'Your personal mailbox. It holds encrypted envelopes only while you are offline. The moment your device confirms it got them, they are deleted, and anything still sitting there after 14 days is deleted anyway, no exceptions.',
		driftChecked: false,
		fields: [
			{ name: 'queued envelopes', description: 'Encrypted message text waiting for you while you are offline. The server cannot read any of it. Gone once your device confirms delivery, and gone after 14 days no matter what.' },
			{ name: 'send sequence counter', description: 'A counter that only exists to keep offline messages in the right order.' },
			{ name: 'receive sequence counter', description: 'A counter that orders sealed (sender-hidden) messages, since they carry no sender to order by.' },
			{ name: 'delivery tokens', description: 'The handful of currently valid public delivery tokens for this mailbox (the newest few, so rotation has a grace period). Senders present one on the sealed path, and it carries no hint of who they are.' },
		],
	},
];

// Sealed sender: how a message's sender is hidden, who sees what, and the
// honest residual. Kept plain and specific — no infrastructure identifiers.
export interface SealedSenderFacts {
	activeMode: string;
	points: string[];
	residual: string;
	keyPinSha256: string;
}

export const SEALED_SENDER: SealedSenderFacts = {
	// The relay mode currently wired into this build.
	activeMode: 'Independent relay, run by Oblivious Network LLC. That is a different company from FlatFold, and a different company from Cloudflare, who hosts us.',
	points: [
		'A sealed send is encrypted to the server’s public key and routed through the independent relay, which strips every identifying header (your IP, your user-agent, all of it) and passes on only the ciphertext.',
		'The relay sees your IP but not the message. The FlatFold gateway sees the message but not your IP. Neither one on its own can tie your IP to a message. It would take both of them working together.',
		'The message itself is separately end-to-end encrypted the whole way, so the relay and the gateway only ever touch ciphertext.',
		'If the independent relay is ever down, sends fall back through a FlatFold-run relay on a different platform. That still hides your IP from the gateway, but it is a weaker promise, since one operator (me) is now running both hops. It is a temporary fallback, not the normal path.',
	],
	// Honest limit — do not overclaim.
	residual:
		'This helps, but it is not magic, and I do not want to oversell it. The connection you keep open to receive messages still tells FlatFold when you are online and what IP you are on. Given enough of that, someone could start guessing who you talk to from the timing alone. The relay moves linking you to a message from trivial to genuinely hard. It does not make it impossible.',
	// SHA-256 (base64) of the gateway’s sealed-sender public key, pinned in this
	// build. The app hashes the key the server hands it and refuses to send (with
	// a visible warning) if it ever differs — defeating a server that tries to
	// hand different users different keys to re-identify them.
	keyPinSha256: 'Bso9x6k3uVzzLCOVMUHke6zmsxbObYqsGCwPhnlgDGk=',
};

// What a legal request (subpoena) could compel. This is the honest, complete
// answer — deliberately short.
export const LEGAL_ANSWER: string[] = [
	'Your username and the date you signed up.',
	'Your public key material: identity key, prekeys, the sealed-sender delivery token. All public by design.',
	'Any encrypted text still queued because someone was offline, which the server cannot decrypt, and which gets deleted on delivery or after 14 days anyway.',
	'That is it. No readable messages, no contact lists, no read receipts, no typing indicators, no IP logs, no history. None of it exists on the server to hand over.',
];
