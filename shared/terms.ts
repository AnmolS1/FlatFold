// The in-app terms every account must accept before the app is usable, and the
// version stamp that says which revision they accepted.
//
// WHY THIS LIVES IN shared/: the Worker writes `users.terms_version` from
// TERMS_VERSION and the client renders TERMS_SECTIONS. Two copies of the version
// would drift, and the drift is silent in both directions — a client ahead of the
// server re-gates everyone forever, a server ahead of the client never re-gates
// anyone. One constant, imported by both. The Worker imports only the version;
// the text tree-shakes out of the Worker bundle.
//
// WHY THE TEXT IS BUNDLED IN THE APP rather than linked: App Review checks that
// the agreement states there is no tolerance for objectionable content or abusive
// users. A link to ponderance.dev/terms cannot satisfy that — the reviewer has to
// be able to read the sentence inside the app, offline, in the gate itself.
//
// BUMPING THIS re-gates every existing user on their next `/api/auth/me`. Do that
// only for a change that actually matters to someone who already agreed; a typo
// fix does not warrant making every user re-accept.
export const TERMS_VERSION = '2026-08-06';

export interface TermsSection {
	heading: string;
	body: string[];
}

export const TERMS_SECTIONS: TermsSection[] = [
	{
		heading: 'What you are agreeing to',
		body: [
			'FlatFold is a private messenger. These terms are the agreement between you and the developer for using it. If you do not agree to them, do not use the app.',
			'You must be at least 18 years old to use FlatFold.',
		],
	},
	{
		// The clause App Review is looking for. Keep the first sentence intact and
		// keep it first — a reviewer scanning this screen should hit it immediately.
		heading: 'No tolerance for objectionable content or abusive users',
		body: [
			'There is no tolerance for objectionable content, and none for abusive users. Accounts that send it are terminated and the username is retired so it cannot be taken again.',
			'Do not use FlatFold to send content that is illegal; that sexually exploits or endangers a child; that threatens, harasses, stalks or bullies someone; that incites violence or hatred against people for who they are; or that you have no right to send.',
			'Do not use FlatFold to send unsolicited bulk messages, to impersonate someone else, or to try to break, overload or work around the service.',
			'Reports are reviewed, and reports of objectionable content are acted on within 24 hours.',
		],
	},
	{
		heading: 'You decide who can reach you',
		body: [
			'Someone who is not already one of your contacts cannot open a conversation with you. Their message waits as a request showing only their username, with nothing from the message itself, until you approve it. Decline, and it is dropped and they are blocked.',
			'You can block anyone at any time, and a blocked account cannot deliver to you at all. You can report a conversation or an individual message. You can delete your own messages for everyone in the chat.',
		],
	},
	{
		heading: 'What reporting actually sends',
		body: [
			'Messages are end-to-end encrypted, which means the developer cannot read them on the server and cannot search them. That is the point, and it does not change.',
			'It also means a report has to carry its own evidence. When you report something, you choose which messages to include, you are shown what is being sent, and only those messages are sent — from your device, your copy. Nothing is collected automatically and nothing else in the conversation goes with it.',
			'Reported material is deleted once the report has been reviewed, and in any case within 90 days.',
		],
	},
	{
		heading: 'Your account',
		body: [
			'Your account is a username and a password, and the encryption keys live on your device. Keep your password. If you lose it and have not set up a recovery code, nobody can restore your account or your messages — not the developer either.',
			'You are responsible for what is sent from your account.',
		],
	},
	{
		heading: 'The software itself',
		body: [
			'FlatFold is free and open source, licensed under the GNU Affero General Public License version 3. It is provided as is, without warranty. The source is public so you do not have to take any of this on trust.',
		],
	},
];
