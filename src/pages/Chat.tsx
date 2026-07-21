import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, LogOut, Search, Settings, ShieldAlert, ShieldCheck, ShieldOff, Users } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../hooks/useToast';
import type { DisplayMessage, WsDeliveredFrame, WsGroupMessageFrame, WsMessageFrame, WsServerToClientFrame, X3dhHandshakeWire } from '../types';
import * as keystore from '../keystore';
import type { ContactRecord, GroupRecord, ConversationSummary } from '../keystore';
import {
	buildMembershipPayload,
	buildRelayDistribution,
	buildDeliveryTokenPayload,
	buildSenderKeyDistribution,
	createGroupLocal,
	decryptGroupMessage,
	decryptIncoming,
	deliveredReceiptEnvelope,
	encryptForSend,
	ensureOwnSealToken,
	ensureOwnSenderKey,
	ensureContact,
	ensureSession,
	groupConversationKey,
	groupEncryptForSend,
	rotateOwnSealToken,
	rotateOwnSenderKey,
	sealedEnvelopeFromSend,
	sealedFirstContactEnvelope,
} from '../lib/messaging';
import { apiRegisterSealToken } from '../lib/api';
import { isNativePlatform, wsOrigin } from '../lib/platform';
import { cachedNativeToken } from '../lib/nativeToken';
import { apiSealedSend } from '../lib/sealedFetch';
import { generateSealToken } from '../lib/sealToken';
import type { ChatPayload } from '../lib/chatPayload';
import { requestPanicWipe } from '../lib/panicWipe';
import { encryptAndUploadMedia, type MediaUploadInput } from '../lib/media';
import { summaryFromMessage, summariesEqual } from '../lib/conversationSummary';
import { replyRefFrom } from '../lib/reply';
import { orderedVisibleMessages } from '../lib/messageOrder';
import { haptic } from '../lib/haptics';
import { useVisualViewportHeight } from '../hooks/useVisualViewport';
import { ContactList } from '../components/chat/ContactList';
import { DisappearingTimerMenu } from '../components/chat/DisappearingTimerMenu';
import { ContactMenu } from '../components/chat/ContactMenu';
import { CreateGroupDialog } from '../components/chat/CreateGroupDialog';
import { MessageList } from '../components/chat/MessageList';
import { SearchDialog } from '../components/chat/SearchDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import { MessageInput } from '../components/chat/MessageInput';
import { SafetyNumberDialog } from '../components/chat/SafetyNumberDialog';
import { MessageActionSheet } from '../components/chat/MessageActionSheet';
import { LogoMark } from '../components/common/Brand';
import { ThemeToggle } from '../components/common/ThemeToggle';

export const Chat = () => {
	const { username, logout } = useAuth();
	const { showToast } = useToast();
	const navigate = useNavigate();

	const [contacts, setContacts] = useState<ContactRecord[]>([]);
	const [groups, setGroups] = useState<GroupRecord[]>([]);
	// The active conversation is either a 1:1 contact (username) or a group
	// (its groupConversationKey). Exactly one is non-null.
	const [activeContact, setActiveContact] = useState<string | null>(null);
	const [activeGroup, setActiveGroup] = useState<GroupRecord | null>(null);
	const [createGroupOpen, setCreateGroupOpen] = useState(false);
	const [manageGroupOpen, setManageGroupOpen] = useState(false);
	const [addMemberInput, setAddMemberInput] = useState('');
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Keyed by contact username OR groupConversationKey.
	const [messagesByContact, setMessagesByContact] = useState<Record<string, DisplayMessage[]>>({});
	// Chat-list previews + unread markers, keyed by convoKey. Loaded from the
	// keystore on mount and kept current by a derivation effect below (from
	// messagesByContact) — a display cache, never authoritative over history.
	const [summaries, setSummaries] = useState<Record<string, ConversationSummary>>({});
	const [connecting, setConnecting] = useState(true);
	const [connected, setConnected] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Advances on a timer so expired disappearing messages drop out of the
	// rendered list promptly, between keystore sweeps.
	const [nowTick, setNowTick] = useState(() => Date.now());
	const [verifyDialogOpen, setVerifyDialogOpen] = useState(false);
	const [searchOpen, setSearchOpen] = useState(false);
	// The message currently being replied to (swipe-right or the action sheet),
	// or null. Drives the composer's reply chip; cleared on send/cancel.
	const [replyingTo, setReplyingTo] = useState<DisplayMessage | null>(null);
	// The message a long-press opened the action sheet for, or null.
	const [actionSheetMessage, setActionSheetMessage] = useState<DisplayMessage | null>(null);
	// Mobile master/detail: which pane is visible on phones (<900px). Pure
	// view state — nothing in the WS/session-op layer depends on it. At
	// ≥900px both panes render side-by-side and this bit is ignored.
	const [mobileView, setMobileView] = useState<'list' | 'conversation'>('list');
	// Keyboard-aware shell height (see the hook): keeps the composer above the
	// on-screen keyboard on iOS. Falls back to the h-dvh class until it resolves.
	const viewportHeight = useVisualViewportHeight();

	const wsRef = useRef<WebSocket | null>(null);
	// Serializes every session-touching operation — inbound decrypt AND
	// outbound encrypt — onto one chain. Both paths do
	// loadSession→mutate→saveSession against IndexedDB, and saveSession
	// rewrites the *whole* record, so any two overlapping ops (receive/receive
	// during an offline-queue flush, OR a send crossing a receive when both
	// people type at once) would clobber each other's ratchet state — benign
	// within one chain, but permanently wedging across a DH-ratchet step.
	// Chaining makes each op atomic and ordered. Mirrors the sender-side send
	// chain in worker/mailbox.ts.
	const sessionOpChain = useRef<Promise<unknown>>(Promise.resolve());
	// X3DH material to attach to the NEXT outgoing message per contact —
	// only the first message of a new session carries it. Component state
	// (not the keystore) since it only needs to survive until that next
	// send, not a reload.
	const pendingHandshakes = useRef<Map<string, X3dhHandshakeWire>>(new Map());
	// Sealed delivered-receipt (increment 6): rid → the local sent message it
	// refers to, so a returning from-less receipt (which carries only `rid`) can
	// be matched without leaking the conversation to the server. Populated on
	// send; a receipt whose rid isn't here (e.g. flushed after a reload) falls
	// back to keystore.findMessageByRid.
	const ridToLocationRef = useRef<Map<string, { contact: string; messageId: string }>>(new Map());

	// Runs `task` after all previously-enqueued session ops settle. The chain
	// tail never rejects (one failure must not poison later ops), but the
	// returned promise does — so a failed send still surfaces its error to the
	// message input.
	const enqueueSessionOp = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
		const result = sessionOpChain.current.then(task, task);
		sessionOpChain.current = result.then(
			() => {},
			() => {}
		);
		return result;
	}, []);
	const usernameRef = useRef(username);
	usernameRef.current = username;
	// Latest contacts, readable inside stable callbacks (e.g. the send path
	// reading the current disappearing-timer) without adding `contacts` to
	// their dep arrays.
	const contactsRef = useRef(contacts);
	contactsRef.current = contacts;
	// Mirror of `summaries` for reads inside the async disappearing-sweep tick.
	const summariesRef = useRef(summaries);
	summariesRef.current = summaries;
	// Mirror of `replyingTo` so the send handlers can read the current reply
	// target without taking it as a dependency (same pattern as contactsRef).
	const replyingToRef = useRef(replyingTo);
	replyingToRef.current = replyingTo;

	// Begin replying to a message (from a swipe or the action sheet).
	const handleStartReply = useCallback((message: DisplayMessage) => {
		setReplyingTo(message);
		haptic();
	}, []);

	// Long-press opens the message action sheet.
	const handleLongPressMessage = useCallback((message: DisplayMessage) => {
		haptic();
		setActionSheetMessage(message);
	}, []);

	// "Delete for me" — hard-remove from local history only (1:1 or group).
	const handleDeleteForMe = useCallback(
		async (message: DisplayMessage) => {
			const currentUsername = usernameRef.current;
			if (!currentUsername) return;
			const convoKey = activeGroup ? groupConversationKey(activeGroup.id) : activeContact;
			if (!convoKey) return;
			await keystore.deleteMessageLocal(currentUsername, convoKey, message.id);
			setMessagesByContact((prev) => {
				const conv = prev[convoKey];
				if (!conv) return prev;
				return { ...prev, [convoKey]: conv.filter((m) => m.id !== message.id) };
			});
		},
		[activeGroup, activeContact]
	);


	const refreshContacts = useCallback(async () => {
		const currentUsername = usernameRef.current;
		if (!currentUsername) return;
		setContacts(await keystore.listContacts(currentUsername));
	}, []);

	const refreshGroups = useCallback(async () => {
		const currentUsername = usernameRef.current;
		if (!currentUsername) return;
		setGroups(await keystore.listGroups(currentUsername));
	}, []);

	useEffect(() => {
		if (!username) return;
		void refreshContacts();
		void refreshGroups();
	}, [username, refreshContacts, refreshGroups]);

	// Surface a sealed-sender key-config pin mismatch (dispatched by sealedFetch on
	// a gateway HPKE-key hash that the client build never pinned — a possible
	// key-substitution attack, or a stale client after a legit key rotation). The
	// sealed path hard-fails on mismatch; the user needs to know their sends aren't
	// going out sender-hidden. Long-lived toast so it isn't missed.
	useEffect(() => {
		const onPinMismatch = () =>
			showToast('Sealed-sender is unavailable: the server’s encryption key could not be verified. Update the app; messages still send but not sender-hidden.', 'error', 30000);
		const onIntegrityMismatch = () =>
			showToast('Warning: an app file didn’t match its expected checksum. The app may have been changed on the server. Reload; if this persists, don’t trust this session.', 'error', 60000);
		window.addEventListener('flatfold:seal-keypin-mismatch', onPinMismatch);
		window.addEventListener('flatfold:integrity-mismatch', onIntegrityMismatch);
		return () => {
			window.removeEventListener('flatfold:seal-keypin-mismatch', onPinMismatch);
			window.removeEventListener('flatfold:integrity-mismatch', onIntegrityMismatch);
		};
	}, [showToast]);

	// Load persisted chat-list summaries once per user — so previews and unread
	// dots for conversations we haven't opened this session still render.
	useEffect(() => {
		if (!username) return;
		void keystore
			.listConversationSummaries(username)
			.then(setSummaries)
			.catch(() => {
				/* keystore locked / transient — the derivation effect refills it */
			});
	}, [username]);

	// Derive chat-list summaries from message state. Runs whenever messages or
	// the active conversation change: recomputes each conversation's last-message
	// preview, advances lastRead for the OPEN conversation (clearing its unread
	// dot), and persists any change. Pure state update (no IO inside the setState
	// updater); early-returns when nothing changed, so it can't loop even though
	// `summaries` is a dependency.
	useEffect(() => {
		if (!username) return;
		const activeKey = activeGroup ? groupConversationKey(activeGroup.id) : activeContact;
		const changed: [string, ConversationSummary][] = [];
		const cleared: string[] = [];
		const next = { ...summaries };
		for (const [convoKey, msgs] of Object.entries(messagesByContact)) {
			const last = msgs[msgs.length - 1];
			if (!last) {
				// Loaded but empty (its last message was deleted-for-me or expired) —
				// drop the stale preview instead of leaving vanished text in the list.
				if (summaries[convoKey]) {
					delete next[convoKey];
					cleared.push(convoKey);
				}
				continue;
			}
			const prev = summaries[convoKey];
			const summary = summaryFromMessage(prev, last, convoKey === activeKey);
			if (summariesEqual(prev, summary)) continue;
			next[convoKey] = summary;
			changed.push([convoKey, summary]);
		}
		if (changed.length === 0 && cleared.length === 0) return;
		setSummaries(next);
		for (const [convoKey, summary] of changed) {
			void keystore.putConversationSummary(username, convoKey, summary).catch(() => {});
		}
		for (const convoKey of cleared) {
			void keystore.deleteConversationSummary(username, convoKey).catch(() => {});
		}
	}, [messagesByContact, username, activeContact, activeGroup, summaries]);

	// Disappearing-messages sweep: prune expired messages from the encrypted
	// keystore and from the in-memory view. Both sender and receiver stamped
	// the same `expiresAt`, so a message vanishes from both devices around the
	// same moment. Runs on an interval (and `nowTick` also drives render-time
	// filtering so expiry looks instant, not up-to-one-tick late).
	useEffect(() => {
		if (!username) return;
		const tick = async () => {
			const now = Date.now();
			setNowTick(now);
			try {
				const changed = await keystore.sweepExpiredMessages(username, now);
				if (changed.length > 0) {
					setMessagesByContact((prev) => {
						const next = { ...prev };
						for (const contact of changed) {
							if (next[contact]) next[contact] = next[contact].filter((m) => m.expiresAt === undefined || m.expiresAt > now);
						}
						return next;
					});
					// Reconcile chat-list summaries for the affected conversations —
					// including ones NOT loaded into state (the sweep spans the whole
					// keystore), so an expired last message never lingers as a stale
					// list preview. Reads the keystore directly for the true remainder.
					for (const convoKey of changed) {
						const remaining = await keystore.loadMessages(username, convoKey);
						const prevSummary = summariesRef.current[convoKey];
						if (remaining.length === 0) {
							if (prevSummary) {
								await keystore.deleteConversationSummary(username, convoKey);
								setSummaries((prev) => {
									if (!prev[convoKey]) return prev;
									const n = { ...prev };
									delete n[convoKey];
									return n;
								});
							}
						} else {
							const summary = summaryFromMessage(prevSummary, remaining[remaining.length - 1], false);
							if (!summariesEqual(prevSummary, summary)) {
								await keystore.putConversationSummary(username, convoKey, summary);
								setSummaries((prev) => ({ ...prev, [convoKey]: summary }));
							}
						}
					}
				}
			} catch {
				// Keystore locked or a transient error — skip this tick.
			}
		};
		const interval = setInterval(() => void tick(), 3000);
		return () => clearInterval(interval);
	}, [username]);

	const appendLocalMessage = useCallback(async (contactUsername: string, message: DisplayMessage) => {
		const currentUsername = usernameRef.current;
		if (!currentUsername) return;
		await keystore.appendMessage(currentUsername, contactUsername, message);
		setMessagesByContact((prev) => ({ ...prev, [contactUsername]: [...(prev[contactUsername] ?? []), message] }));
	}, []);

	// The RAW send — does the work WITHOUT enqueuing. Safe to call from code
	// that is already running as a task on the session-op chain (an inbound
	// handler), where re-enqueuing would self-deadlock the chain.
	const sendPayloadRaw = useCallback(
		async (contact: string, payload: ChatPayload, localMessage: DisplayMessage | null) => {
			const ws = wsRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected. Please wait and try again.');
			const currentUsername = usernameRef.current;
			if (!currentUsername) throw new Error('Not signed in.');

			// Establish the session lazily, on the first send rather than at
			// contact-add time — see docs/SESSION_COLLISION_OPTIONS.md. Every 1:1
			// send funnels through here, so this is the single place the ratchet
			// comes into existence. A no-op once a session exists, so the callers
			// that already ensureSession before calling us (group sender-key and
			// delivery-token distribution) just short-circuit.
			const established = await ensureSession(currentUsername, contact);
			if (established.status === 'not-found') throw new Error('No such user.');
			if (established.status === 'not-published') throw new Error("That user hasn't set up encryption yet.");
			if (established.pendingHandshake) pendingHandshakes.current.set(contact, established.pendingHandshake);

			const pendingHandshake = pendingHandshakes.current.get(contact) ?? null;
			const id = localMessage?.id ?? crypto.randomUUID();
			// Sealed-sender wrapper inputs (increment 6): our own delivery token +
			// this message's random `rid`, sealed inside the ciphertext so a
			// delivered-receipt can come back and be matched locally. Track rid → this
			// message so the from-less receipt resolves without a conversation id.
			const rid = generateSealToken();
			const ownToken = await ensureOwnSealToken(currentUsername);
			if (localMessage) {
				localMessage.rid = rid;
				ridToLocationRef.current.set(rid, { contact, messageId: id });
			}
			// Encrypt ONCE — the ratchet advances here regardless of transport.
			const frame = await encryptForSend(currentUsername, contact, id, payload, pendingHandshake, ownToken, rid);
			pendingHandshakes.current.delete(contact);

			// Sealed-sender send path. When we hold the peer's delivery token, send the
			// SAME ciphertext from-less through the OHTTP gateway so the server never
			// learns we're the sender (never re-encrypt). Two shapes:
			//  - ESTABLISHED session (increment 5): plain from-less envelope.
			//  - FIRST CONTACT (increment 7): the X3DH handshake is ECIES-encrypted to
			//    the recipient's identity key (x3dhSealed) so the gateway can't see the
			//    initiator's identity keys either.
			// Any failure falls back to the normal WS send of the exact same frame
			// (which carries cleartext x3dh on first contact) — a privacy downgrade
			// surfaced in docs, not silently preferred.
			let sentSealed = false;
			const token = await keystore.loadPeerSealToken(currentUsername, contact);
			if (token) {
				try {
					if (pendingHandshake) {
						const contactRec = await keystore.getContact(currentUsername, contact);
						if (contactRec) {
							sentSealed = await apiSealedSend(
								contact,
								token,
								sealedFirstContactEnvelope(frame, pendingHandshake, contactRec.identity.dhPublicKey)
							);
						}
					} else {
						sentSealed = await apiSealedSend(contact, token, sealedEnvelopeFromSend(frame));
					}
				} catch {
					sentSealed = false;
				}
			}
			if (!sentSealed) ws.send(JSON.stringify(frame));
			if (localMessage) await appendLocalMessage(contact, localMessage);
		},
		[appendLocalMessage]
	);

	// The enqueuing wrapper — for top-level callers (user actions) NOT already
	// on the chain.
	const sendPayload = useCallback(
		(contact: string, payload: ChatPayload, localMessage: DisplayMessage | null) =>
			enqueueSessionOp(() => sendPayloadRaw(contact, payload, localMessage)),
		[sendPayloadRaw, enqueueSessionOp]
	);

	// "Delete for everyone" — tombstone our own message locally and tell the
	// peer to do the same. 1:1 only (group retraction is deferred, like group
	// attachments); the UI only offers this for our own 1:1 messages. Defined
	// here (after sendPayload) so it can use it.
	const handleDeleteForEveryone = useCallback(
		async (message: DisplayMessage) => {
			const currentUsername = usernameRef.current;
			if (!currentUsername || !activeContact) return;
			const contact = activeContact;
			await keystore.tombstoneMessage(currentUsername, contact, message.id);
			setMessagesByContact((prev) => {
				const conv = prev[contact];
				if (!conv) return prev;
				return {
					...prev,
					[contact]: conv.map((m) => (m.id === message.id ? { ...m, deleted: true, text: '', media: undefined, replyTo: undefined } : m)),
				};
			});
			try {
				await sendPayload(contact, { t: 'delete', targetId: message.id }, null);
			} catch {
				showToast('Deleted here; it will retract for them when you reconnect.', 'error');
			}
		},
		[activeContact, sendPayload, showToast]
	);

	// Distributes our own sender key for a group. Creator-relay model (v1):
	// the creator sends its key to all members; a non-creator sends its key
	// only to the creator, who re-distributes it (avoids any member pair
	// mutually initiating a session — i.e. no X3DH glare). RAW: no enqueuing,
	// so it's safe to call from an inbound handler already on the chain.
	const distributeOwnSenderKeyRaw = useCallback(async (group: GroupRecord) => {
		const currentUsername = usernameRef.current;
		if (!currentUsername) return;
		const payload = await buildSenderKeyDistribution(currentUsername, group.id);
		if (!payload) return;
		const targets = currentUsername === group.creator ? group.members : [group.creator];
		for (const member of targets) {
			if (member === currentUsername) continue;
			const session = await ensureSession(currentUsername, member);
			if (session.status !== 'ok') continue; // member unknown / no keys — skip
			if (session.pendingHandshake) pendingHandshakes.current.set(member, session.pendingHandshake);
			await sendPayloadRaw(member, payload, null);
		}
	}, [sendPayloadRaw]);

	const distributeOwnSenderKey = useCallback(
		(group: GroupRecord) => enqueueSessionOp(() => distributeOwnSenderKeyRaw(group)),
		[distributeOwnSenderKeyRaw, enqueueSessionOp]
	);

	// Hands my CURRENT delivery token to every existing contact over their 1:1
	// ratchet (a 'deliverytoken' payload), so they can reach me on the sealed
	// path. RAW: no enqueuing, so it's safe to call from code already on the
	// session-op chain. Existing contacts already have a session, so ensureSession
	// short-circuits (no bundle re-fetch, no re-handshake).
	const distributeOwnSealTokenRaw = useCallback(async () => {
		const currentUsername = usernameRef.current;
		if (!currentUsername) return;
		const token = await keystore.loadOwnSealToken(currentUsername);
		if (!token) return;
		const payload = buildDeliveryTokenPayload(token);
		for (const contact of await keystore.listContacts(currentUsername)) {
			const session = await ensureSession(currentUsername, contact.username);
			if (session.status !== 'ok') continue;
			if (session.pendingHandshake) pendingHandshakes.current.set(contact.username, session.pendingHandshake);
			await sendPayloadRaw(contact.username, payload, null);
		}
	}, [sendPayloadRaw]);

	// Creator-only: re-distribute another member's sender key to the rest of
	// the group. RAW (called from an inbound handler already on the chain).
	const relaySenderKeyRaw = useCallback(async (group: GroupRecord, keyOwner: string) => {
		const currentUsername = usernameRef.current;
		if (!currentUsername || currentUsername !== group.creator) return;
		const payload = await buildRelayDistribution(currentUsername, group.id, keyOwner);
		if (!payload) return;
		for (const member of group.members) {
			if (member === currentUsername || member === keyOwner) continue;
			const session = await ensureSession(currentUsername, member);
			if (session.status !== 'ok') continue;
			if (session.pendingHandshake) pendingHandshakes.current.set(member, session.pendingHandshake);
			await sendPayloadRaw(member, payload, null);
		}
	}, [sendPayloadRaw]);

	// Acks any inbound envelope (1:1 or group) by id/from — the ack that gates
	// offline-queue deletion and fires the delivered receipt. `from` is absent
	// for a sealed (from-less) message: `to` is then omitted, so the DO deletes
	// our queued copy without a reverse hop (and no sender leaks).
	const sendAck = useCallback((frame: { id: string; from?: string }) => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: 'ack', messageId: frame.id, to: frame.from }));
		}
	}, []);

	const handleIncomingMessage = useCallback(
		async (frame: WsMessageFrame) => {
			const currentUsername = usernameRef.current;
			if (!currentUsername) return;

			// decryptIncoming persists the message + marks it processed; the
			// UI here only mirrors that into React state and acks the server.
			const result = await decryptIncoming(currentUsername, frame);

			switch (result.status) {
				case 'retry':
					// Arrived before its session-establishing handshake — leave it
					// queued (no ack); the server redelivers after the handshake.
					return;
				case 'duplicate':
					// Already handled on a prior delivery; ack so the server stops
					// resending, but don't surface it again.
					sendAck(frame);
					return;
				case 'failed':
					// Permanently undecryptable — ack it away (redelivery won't
					// help) and surface once.
					sendAck(frame);
					showToast(result.error, 'error');
					return;
				case 'control':
					// A timer change, sender-key distribution, or membership change —
					// already applied to the keystore. NOTE: we're already running as
					// a task on the session-op chain, so we call the RAW
					// (non-enqueuing) variants here — enqueuing again self-deadlocks.
					await refreshContacts();
					if (result.senderKeyGroupId) {
						await refreshGroups();
						const group = await keystore.getGroup(currentUsername, result.senderKeyGroupId);
						if (group) {
							// Reciprocate: if we just learned about this group, generate
							// our own sender key and distribute it (creator → all members,
							// non-creator → creator only).
							const created = await ensureOwnSenderKey(currentUsername, result.senderKeyGroupId);
							if (created) await distributeOwnSenderKeyRaw(group);
							// Creator-relay: forward a member's key to the rest.
							if (result.senderKeySender && result.senderKeySender !== currentUsername) {
								await relaySenderKeyRaw(group, result.senderKeySender);
							}
						}
					}
					if (result.membership) {
						const m = result.membership;
						await refreshGroups();
						if (m.removedMe) {
							// We were removed — drop the view if it's open.
							setActiveGroup((prev) => (prev?.id === m.groupId ? null : prev));
							showToast(`You were removed from a group.`, 'error');
						} else {
							const group = await keystore.getGroup(currentUsername, m.groupId);
							if (group) {
								if (m.action === 'remove') {
									// Remaining member: ROTATE our sender key (kills the removed
									// member's retained keys) and redistribute the fresh one.
									await rotateOwnSenderKey(currentUsername, m.groupId);
									await distributeOwnSenderKeyRaw(group);
								} else if (m.action === 'add' && m.target === currentUsername) {
									// We're the newly-added member — set up + distribute our key.
									const created = await ensureOwnSenderKey(currentUsername, m.groupId);
									if (created) await distributeOwnSenderKeyRaw(group);
								}
							}
						}
					}
					if (result.deleteTarget) {
						// The peer retracted one of their messages — mirror the tombstone
						// into our in-memory view (the keystore was already updated).
						const { convoKey, messageId } = result.deleteTarget;
						setMessagesByContact((prev) => {
							const conv = prev[convoKey];
							if (!conv) return prev;
							return {
								...prev,
								[convoKey]: conv.map((m) => (m.id === messageId ? { ...m, deleted: true, text: '', media: undefined, replyTo: undefined } : m)),
							};
						});
					}
					if (result.keyChanged) {
						// keyChanged only fires on an x3dh (normal-path) message, so
						// frame.from is present; the fallback just satisfies the type.
						showToast(`${frame.from ?? 'A contact'}'s safety number changed — verify before trusting this chat.`, 'error');
					}
					sendAck(frame);
					return;
				case 'ok': {
					// The sender the ratchet authenticated (server-stamped on the normal
					// path, or trial-decrypt-identified for a sealed message).
					const sender = result.displayMessage.from;
					setMessagesByContact((prev) => ({
						...prev,
						[sender]: [...(prev[sender] ?? []), result.displayMessage],
					}));
					// Pick up a newly auto-added contact or a raised key-change flag.
					await refreshContacts();
					if (result.keyChanged) {
						showToast(`${sender}'s safety number changed — verify before trusting this chat.`, 'error');
					}
					sendAck(frame);
					// Sealed delivered-receipt (increment 6): this message arrived
					// from-less and decrypted OK, so the WS-ack reverse hop was skipped
					// server-side (no sender to notify). Send a receipt back over the
					// SEALED path instead, using the sender's OWN token from the wrapper
					// (fresh by construction) and referencing `rid` (never the wire id).
					// Best-effort + random jitter to blunt the tight →R/→S temporal pair a
					// same-operator gateway could otherwise observe (docs/SEALED_SENDER.md).
					if (result.sealedReceipt) {
						const { sender: receiptTo, st, rid } = result.sealedReceipt;
						const jitterMs = 1000 + Math.floor(Math.random() * 4000);
						setTimeout(() => {
							void apiSealedSend(receiptTo, st, deliveredReceiptEnvelope(rid)).catch(() => {});
						}, jitterMs);
					}
					return;
				}
			}
		},
		[sendAck, showToast, refreshContacts, refreshGroups, distributeOwnSenderKeyRaw, relaySenderKeyRaw]
	);

	// Inbound group content message: verify + decrypt with the sender's sender
	// key, append to the group's history. 'retry' if the sender's key hasn't
	// arrived yet (it rides a separate pairwise channel).
	const handleIncomingGroupMessage = useCallback(
		async (frame: WsGroupMessageFrame) => {
			const currentUsername = usernameRef.current;
			if (!currentUsername) return;
			const result = await decryptGroupMessage(currentUsername, frame);
			switch (result.status) {
				case 'retry':
					return; // sender key not here yet — leave queued
				case 'duplicate':
					sendAck(frame);
					return;
				case 'failed':
					sendAck(frame);
					showToast(result.error, 'error');
					return;
				case 'ok': {
					const convoKey = groupConversationKey(frame.groupId);
					setMessagesByContact((prev) => ({ ...prev, [convoKey]: [...(prev[convoKey] ?? []), result.displayMessage] }));
					await refreshGroups();
					sendAck(frame);
					return;
				}
			}
		},
		[sendAck, showToast, refreshGroups]
	);

	const markDelivered = useCallback((contact: string, messageId: string) => {
		setMessagesByContact((prev) => {
			const conversation = prev[contact];
			if (!conversation) return prev;
			return {
				...prev,
				[contact]: conversation.map((m) => (m.id === messageId ? { ...m, status: 'delivered' } : m)),
			};
		});
	}, []);

	const handleDeliveredFrame = useCallback(
		async (frame: WsDeliveredFrame) => {
			const currentUsername = usernameRef.current;
			if (!currentUsername) return;

			// Sealed delivered-receipt (increment 6): no `from`/`messageId` — it
			// references a per-message random `rid` carried inside the original
			// ciphertext. Resolve rid → {contact, messageId} locally (in-memory map,
			// then an encrypted-history scan for a receipt flushed after a reload).
			if (frame.rid) {
				// Clear our queued copy of the receipt regardless of match (its `id` is
				// fresh; `to` omitted → no reverse hop). Without this it re-flushes
				// every reconnect until TTL, since receipts aren't otherwise acked.
				if (frame.id) sendAck({ id: frame.id });
				const loc = ridToLocationRef.current.get(frame.rid) ?? (await keystore.findMessageByRid(currentUsername, frame.rid));
				if (!loc) return;
				await keystore.updateMessageStatus(currentUsername, loc.contact, loc.messageId, 'delivered');
				markDelivered(loc.contact, loc.messageId);
				return;
			}

			// Normal (from-stamped) path — unchanged.
			const { from, messageId } = frame;
			if (!from || !messageId) return;
			await keystore.updateMessageStatus(currentUsername, from, messageId, 'delivered');
			markDelivered(from, messageId);
		},
		[sendAck, markDelivered]
	);

	// WS connection lifecycle — same shape as M1, but frames are now
	// {type:'message', ...} envelopes carrying ciphertext, not raw echoed
	// text; decryption happens client-side in handleIncomingFrame.
	useEffect(() => {
		if (!username) return;

		// Dev-only StrictMode double-invokes this effect on mount: the first
		// socket gets closed (by this same cleanup) before its handshake
		// finishes, which fires `onerror` on a close WE initiated, not a real
		// connection failure. Guard against surfacing that as a user-facing
		// error — only genuine unexpected errors/closes should toast.
		let intentionalClose = false;

		// Web: same-origin, the SameSite=Strict cookie authenticates the upgrade.
		// Native (capacitor://localhost): cross-origin, no cookie — so target the
		// absolute wss:// API and smuggle the bearer token as a subprotocol offer
		// (the JS WebSocket constructor can't set headers; `protocols` is the one
		// channel, and the Worker reads it at upgrade to route to the mailbox DO).
		// The token is read synchronously from cache, warmed by the startup /me.
		let ws: WebSocket;
		if (isNativePlatform()) {
			const token = cachedNativeToken();
			const url = `${wsOrigin()}/ws`;
			ws = new WebSocket(url, token ? ['flatfold', `flatfold.bearer.${token}`] : ['flatfold']);
		} else {
			const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
			ws = new WebSocket(`${protocol}//${location.host}/ws`);
		}
		wsRef.current = ws;

		ws.onopen = () => {
			setConnecting(false);
			setConnected(true);
			setError(null);
		};

		ws.onmessage = (event) => {
			let frame: WsServerToClientFrame;
			try {
				frame = JSON.parse(event.data as string) as WsServerToClientFrame;
			} catch {
				return; // ignore malformed frames rather than crash the chat view
			}
			// Enqueue on the shared session-op chain so frames process one at a
			// time, in arrival order, and never overlap an outbound send.
			const run =
				frame.type === 'message'
					? () => handleIncomingMessage(frame)
					: frame.type === 'groupMessage'
						? () => handleIncomingGroupMessage(frame)
						: frame.type === 'delivered'
							? () => handleDeliveredFrame(frame)
							: null;
			if (run) {
				enqueueSessionOp(run).catch((err) => console.error('Inbound frame handler failed:', err));
			}
		};

		ws.onerror = () => {
			if (intentionalClose) return;
			const message = 'Connection error. Please try refreshing the page.';
			setError(message);
			showToast(message, 'error');
		};

		ws.onclose = () => {
			setConnected(false);
		};

		return () => {
			intentionalClose = true;
			ws.close();
			wsRef.current = null;
		};
	}, [username, showToast, handleIncomingMessage, handleIncomingGroupMessage, handleDeliveredFrame, enqueueSessionOp]);

	// Sealed sender: on connect, make sure my delivery token exists and both
	// server stores know it (register-token writes the DO validator + the D1
	// bundle copy, DO-first). If it was newly created (a fresh account, or a
	// user predating sealed sender), hand it to my existing contacts over the
	// ratchet so they can reach me on the sealed path. Idempotent and cheap on
	// reconnect — an already-published token just re-registers, no distribution.
	useEffect(() => {
		if (!username || !connected) return;
		let cancelled = false;
		void (async () => {
			try {
				const before = await keystore.loadOwnSealToken(username);
				const token = await ensureOwnSealToken(username);
				await apiRegisterSealToken(token);
				if (!before && !cancelled) await enqueueSessionOp(() => distributeOwnSealTokenRaw());
			} catch {
				// Transient (offline / keystore locked) — retries on the next connect.
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [username, connected, enqueueSessionOp, distributeOwnSealTokenRaw]);

	// Loads a conversation's history into state (keyed by contact username OR
	// groupConversationKey) if not already loaded.
	const loadConversation = useCallback(
		async (convoKey: string) => {
			if (!username || messagesByContact[convoKey]) return;
			const history = await keystore.loadMessages(username, convoKey);
			setMessagesByContact((prev) => (prev[convoKey] ? prev : { ...prev, [convoKey]: history }));
		},
		[username, messagesByContact]
	);

	const handleSelectContact = useCallback(
		async (contactUsername: string) => {
			setActiveGroup(null);
			setActiveContact(contactUsername);
			await loadConversation(contactUsername);
		},
		[loadConversation]
	);

	const handleSelectGroup = useCallback(
		async (group: GroupRecord) => {
			setActiveContact(null);
			setActiveGroup(group);
			await loadConversation(groupConversationKey(group.id));
		},
		[loadConversation]
	);

	const handleCreateGroup = useCallback(
		async (name: string, members: string[]) => {
			if (!username) return;
			const groupId = crypto.randomUUID();
			await createGroupLocal(username, groupId, name, members);
			await refreshGroups();
			const group = await keystore.getGroup(username, groupId);
			if (group) {
				await distributeOwnSenderKey(group);
				await handleSelectGroup(group);
			}
		},
		[username, refreshGroups, distributeOwnSenderKey, handleSelectGroup]
	);

	// Creator-only. Adds a member: establish a session, update the roster,
	// broadcast the change, and relay every existing member's sender key to
	// the newcomer. No rotation — forward secrecy already keeps pre-join
	// messages unreadable to them.
	const handleAddMember = useCallback(
		async (group: GroupRecord, newMember: string) => {
			if (!username || username !== group.creator) return;
			if (group.members.includes(newMember)) return;

			const session = await enqueueSessionOp(() => ensureSession(username, newMember));
			if (session.status !== 'ok') {
				showToast('No such user, or they have not set up encryption.', 'error');
				return;
			}
			if (session.pendingHandshake) pendingHandshakes.current.set(newMember, session.pendingHandshake);

			const updated: GroupRecord = { ...group, members: [...group.members, newMember] };
			await keystore.saveGroup(username, updated);
			await refreshGroups();

			// Roster broadcast to everyone (existing + new).
			const membership = buildMembershipPayload(updated, 'add', newMember);
			for (const m of updated.members) {
				if (m === username) continue;
				await sendPayload(m, membership, null);
			}
			// Relay every existing member's current sender key to the newcomer.
			for (const m of group.members) {
				if (m === newMember) continue;
				const payload = m === username ? await buildSenderKeyDistribution(username, group.id) : await buildRelayDistribution(username, group.id, m);
				if (payload) await sendPayload(newMember, payload, null);
			}
			await handleSelectGroup(updated);
		},
		[username, showToast, refreshGroups, enqueueSessionOp, sendPayload, handleSelectGroup]
	);

	// Creator-only. Removes a member: the creator can't be removed (its relay
	// role would collapse the group). Update the roster, tell the removed
	// member and the remaining members, then EVERY remaining member (including
	// the creator) rotates its sender key so the removed member's retained keys
	// are dead.
	const handleRemoveMember = useCallback(
		async (group: GroupRecord, target: string) => {
			if (!username || username !== group.creator) return;
			if (target === group.creator) {
				showToast("You can't remove the group creator.", 'error');
				return;
			}
			if (!group.members.includes(target)) return;

			const updated: GroupRecord = { ...group, members: group.members.filter((m) => m !== target) };
			await keystore.saveGroup(username, updated);
			await keystore.deleteReceiverSenderKey(username, group.id, target);
			await refreshGroups();

			const membership = buildMembershipPayload(updated, 'remove', target);
			// Remaining members: they rotate on receipt.
			for (const m of updated.members) {
				if (m === username) continue;
				await sendPayload(m, membership, null);
			}
			// The removed member: so their client drops the group cleanly.
			await sendPayload(target, membership, null);

			// The creator is itself a remaining member — rotate + redistribute.
			await enqueueSessionOp(async () => {
				await rotateOwnSenderKey(username, group.id);
				await distributeOwnSenderKeyRaw(updated);
			});
			await handleSelectGroup(updated);
		},
		[username, showToast, refreshGroups, enqueueSessionOp, sendPayload, distributeOwnSenderKeyRaw, handleSelectGroup]
	);

	const handleAddContact = useCallback(
		async (contactUsername: string) => {
			if (!username) return;
			if (contactUsername === username) {
				showToast("You can't message yourself.", 'error');
				return;
			}

			// Validates the user and stores their identity, but deliberately does
			// NOT establish a session — that happens on the first send. Building an
			// initiator ratchet here is what let two people who add each other
			// before either sends end up with colliding sessions (see
			// docs/SESSION_COLLISION_OPTIONS.md). On the shared chain: it writes the
			// identity doc, which an inbound frame could otherwise clobber.
			const result = await enqueueSessionOp(() => ensureContact(username, contactUsername));
			if (result.status === 'not-found') {
				showToast('No such user.', 'error');
				return;
			}
			if (result.status === 'not-published') {
				showToast("That user hasn't set up encryption yet.", 'error');
				return;
			}

			await refreshContacts();
			await handleSelectContact(contactUsername);
		},
		[username, showToast, handleSelectContact, refreshContacts, enqueueSessionOp]
	);

	// Remove a 1:1 contact. Rotate my delivery token so the removed contact's
	// copy goes stale (after the DO's grace window), register the fresh token
	// (DO + D1), purge all local state for the conversation, then redistribute
	// the new token to the REMAINING contacts. Mirrors group member-removal's
	// rotate-and-redistribute. Honest scope: the token also rides my public
	// bundle, so this is anti-spam / passive-cutoff hygiene, not a cryptographic
	// block — a determined removed contact can re-fetch my bundle. See
	// docs/THREAT_MODEL.md.
	const handleRemoveContact = useCallback(
		async (contact: string) => {
			if (!username) return;
			const token = await rotateOwnSealToken(username);
			try {
				await apiRegisterSealToken(token);
			} catch {
				showToast('Removed here; token rotation will sync when you reconnect.', 'error');
			}
			await keystore.removeContact(username, contact);
			// removeContact already dropped this contact, so this reaches only the
			// remaining ones. On the chain (raw send inside).
			await enqueueSessionOp(() => distributeOwnSealTokenRaw());
			setMessagesByContact((prev) => {
				const next = { ...prev };
				delete next[contact];
				return next;
			});
			setSummaries((prev) => {
				const next = { ...prev };
				delete next[contact];
				return next;
			});
			await refreshContacts();
			if (activeContact === contact) {
				setActiveContact(null);
				setMobileView('list');
			}
			showToast('Contact removed.', 'success');
		},
		[username, showToast, enqueueSessionOp, distributeOwnSealTokenRaw, refreshContacts, activeContact]
	);

	// Encrypts and sends a typed payload, optionally appending a local
	// DisplayMessage (null for control payloads like a timer change). On the
	// shared chain so the ratchet advance can't overlap an inbound decrypt;
	// errors propagate to the caller.
	// Sender-key-encrypts a payload once and fans it out to every other group
	// member's mailbox, appending our own local copy. On the shared chain so
	// the sender-chain advance can't overlap an inbound decrypt.
	const sendGroupPayload = useCallback(
		async (group: GroupRecord, payload: ChatPayload, localMessage: DisplayMessage) => {
			const ws = wsRef.current;
			if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected. Please wait and try again.');
			const currentUsername = usernameRef.current;
			if (!currentUsername) throw new Error('Not signed in.');

			await enqueueSessionOp(async () => {
				const frames = await groupEncryptForSend(currentUsername, group.id, localMessage.id, payload);
				for (const frame of frames) ws.send(JSON.stringify(frame));
				await appendLocalMessage(groupConversationKey(group.id), localMessage);
			});
		},
		[appendLocalMessage, enqueueSessionOp]
	);

	const handleSendMessage = useCallback(
		async (text: string) => {
			if (!username) throw new Error('Not signed in.');
			const id = crypto.randomUUID();
			const now = Date.now();
			// Attach the current reply quote (if any) and clear it — a reply is
			// consumed by the next send.
			const reply = replyingToRef.current ? replyRefFrom(replyingToRef.current) : null;
			const replyField = reply ? { replyTo: reply } : {};
			setReplyingTo(null);

			if (activeGroup) {
				await sendGroupPayload(
					activeGroup,
					{ t: 'text', text, sentAt: now, ...replyField },
					{ id, from: username, text, ts: now, direction: 'sent', status: 'sent', ...replyField }
				);
				return;
			}

			if (!activeContact) throw new Error('No active conversation.');
			const contact = activeContact;
			const seconds = contactsRef.current.find((c) => c.username === contact)?.disappearingSeconds ?? 0;
			const payload: ChatPayload = { t: 'text', text, sentAt: now, ...(seconds ? { expiresInSeconds: seconds } : {}), ...replyField };
			const localMessage: DisplayMessage = {
				id,
				from: username,
				text,
				ts: now,
				direction: 'sent',
				status: 'sent',
				...(seconds ? { expiresAt: now + seconds * 1000 } : {}),
				...replyField,
			};
			await sendPayload(contact, payload, localMessage);
		},
		[username, activeContact, activeGroup, sendPayload, sendGroupPayload]
	);

	const handleSendMedia = useCallback(
		async (input: MediaUploadInput) => {
			if (activeGroup) {
				// Group attachments are deferred: the fetch-ack R2 deletion model
				// is single-recipient, so a shared object would be deleted by the
				// first member to fetch it. Text-only in groups for the slice.
				throw new Error('Attachments in groups are coming soon — text only for now.');
			}
			if (!username || !activeContact) throw new Error('No active conversation.');
			const contact = activeContact;
			const seconds = contactsRef.current.find((c) => c.username === contact)?.disappearingSeconds ?? 0;
			const now = Date.now();

			// Encrypt + upload the ciphertext, then cache the plaintext locally so
			// the sender can re-show it after reload (the R2 copy is deleted once
			// the recipient fetch-acks it).
			const media = await encryptAndUploadMedia(input);
			const id = crypto.randomUUID();
			await keystore.cacheMedia(username, media.id, input.bytes, input.mimeType);

			const reply = replyingToRef.current ? replyRefFrom(replyingToRef.current) : null;
			const replyField = reply ? { replyTo: reply } : {};
			setReplyingTo(null);

			const payload: ChatPayload = { t: 'media', media, sentAt: now, ...(seconds ? { expiresInSeconds: seconds } : {}), ...replyField };
			const localMessage: DisplayMessage = {
				id,
				from: username,
				text: '',
				ts: now,
				direction: 'sent',
				status: 'sent',
				media,
				...(seconds ? { expiresAt: now + seconds * 1000 } : {}),
				...replyField,
			};
			await sendPayload(contact, payload, localMessage);
		},
		[username, activeContact, activeGroup, sendPayload]
	);

	// Changes the disappearing-messages timer for the active conversation:
	// persist it locally and best-effort notify the peer in-channel so their
	// header syncs. Applies going forward only — existing messages keep the
	// expiry they were stamped with.
	const handleSetTimer = useCallback(
		async (seconds: number) => {
			if (!username || !activeContact) return;
			const contact = activeContact;
			await enqueueSessionOp(() => keystore.setDisappearingTimer(username, contact, seconds));
			await refreshContacts();
			try {
				await sendPayload(contact, { t: 'timer', expiresInSeconds: seconds }, null);
			} catch {
				showToast('Timer set on this device; it will sync to them when you reconnect.', 'error');
			}
		},
		[username, activeContact, enqueueSessionOp, refreshContacts, sendPayload, showToast]
	);

	const handleLogout = useCallback(async () => {
		try {
			await logout();
			navigate('/login');
		} catch (err) {
			console.error('Failed to logout:', err);
		}
	}, [logout, navigate]);

	// The active conversation key: a group's namespaced key, or a contact
	// username. Sorted by ts (belt-and-suspenders alongside the server-side
	// flush-order fix) and filtered for disappearing expiry. See messageOrder.ts
	// for why `ts` is the sender's clock, not the envelope's.
	const activeConversationKey = activeGroup ? groupConversationKey(activeGroup.id) : activeContact;
	const activeMessages = activeConversationKey
		? orderedVisibleMessages(messagesByContact[activeConversationKey] ?? [], nowTick)
		: [];
	const activeContactRecord = activeContact ? contacts.find((c) => c.username === activeContact) : undefined;

	const acknowledgeKeyChange = useCallback(async () => {
		if (!username || !activeContact) return;
		// On the shared chain — a whole-record identity-doc write, same as the
		// key-change/addContact writes an inbound frame can make.
		await enqueueSessionOp(() => keystore.acknowledgeKeyChange(username, activeContact));
		await refreshContacts();
	}, [username, activeContact, refreshContacts, enqueueSessionOp]);

	const handleSetVerified = useCallback(
		async (contactUsername: string, verified: boolean) => {
			if (!username) return;
			await enqueueSessionOp(() => keystore.setVerified(username, contactUsername, verified));
			await refreshContacts();
		},
		[username, refreshContacts, enqueueSessionOp]
	);

	return (
		<div
			className="h-dvh flex flex-col overflow-hidden"
			style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
		>
			<header className="bg-graph-card border-b border-crease-line flex-shrink-0 env-safe-top env-safe-x">
				<div className="px-4 py-3">
					<div className="flex items-center justify-between gap-2">
						<div className="flex items-center gap-3 min-w-0">
							<LogoMark size={32} />
							<div className="min-w-0">
								<h1 className="font-display text-xl font-bold text-graphite leading-tight">FlatFold</h1>
								<p className="text-xs text-graphite-60 font-mono flex items-center gap-1.5 truncate">
									<span
										className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${connected ? 'bg-sax' : 'bg-crane'}`}
										aria-hidden="true"
									/>
									<span className="truncate">
										{connected ? 'connected' : 'connecting…'} · {username}
									</span>
								</p>
							</div>
						</div>
						<div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
							<button
								onClick={() => setSearchOpen(true)}
								className="flex items-center justify-center gap-2 min-w-11 min-h-11 sm:px-3 sm:min-w-0 border border-crease-line-bold hover:border-crease text-graphite rounded-lg transition-colors text-sm"
								title="Search your messages (local only)"
								aria-label="Search"
							>
								<Search className="w-4 h-4" />
								<span className="hidden sm:inline">Search</span>
							</button>
							<button
								onClick={() => setSettingsOpen(true)}
								className="flex items-center justify-center min-w-11 min-h-11 border border-crease-line-bold hover:border-crease text-graphite rounded-lg transition-colors text-sm"
								title="Settings"
								aria-label="Settings"
							>
								<Settings className="w-4 h-4" />
							</button>
							<ThemeToggle />
							<button
								onClick={() => requestPanicWipe()}
								className="flex items-center justify-center gap-2 min-w-11 min-h-11 sm:px-3 sm:min-w-0 border border-crane/40 hover:border-crane text-crane rounded-lg transition-colors text-sm"
								title="Destroy all local data on this device (triple-tap Esc also triggers this)"
								aria-label="Panic wipe"
							>
								<ShieldOff className="w-4 h-4" />
								<span className="hidden sm:inline">Panic</span>
							</button>
							<button
								onClick={handleLogout}
								className="flex items-center justify-center gap-2 min-w-11 min-h-11 sm:px-3 sm:min-w-0 border border-crease-line-bold hover:border-crease text-graphite rounded-lg transition-colors text-sm"
								aria-label="Log out"
							>
								<LogOut className="w-4 h-4" />
								<span className="hidden sm:inline">Logout</span>
							</button>
						</div>
					</div>
				</div>
			</header>

			{error && (
				<div className="bg-graph-card border-b border-crane px-4 py-3">
					<p className="text-sm text-crane">{error}</p>
				</div>
			)}

			<div className="flex-1 flex min-h-0">
				{/* List pane — full-width on phones, a fixed ~320px sidebar at ≥900px.
				    Hidden on phones while a conversation is open (master/detail). */}
				<div
					className={`${mobileView === 'conversation' ? 'hidden' : 'flex'} min-[900px]:flex w-full min-[900px]:w-80 min-[900px]:flex-shrink-0 min-h-0`}
				>
					<ContactList
						contacts={contacts}
						groups={groups}
						summaries={summaries}
						currentUsername={username ?? ''}
						activeContact={activeContact}
						activeGroupId={activeGroup?.id ?? null}
						onSelectContact={(u) => {
							setMobileView('conversation');
							setReplyingTo(null);
							void handleSelectContact(u);
						}}
						onSelectGroup={(g) => {
							setMobileView('conversation');
							setReplyingTo(null);
							void handleSelectGroup(g);
						}}
						onAddContact={handleAddContact}
						onNewGroup={() => setCreateGroupOpen(true)}
					/>
				</div>

				{/* Conversation pane — hidden on phones while the list is showing. */}
				<div
					className={`${mobileView === 'list' ? 'hidden' : 'flex'} min-[900px]:flex flex-1 flex-col min-h-0`}
				>
					{activeGroup ? (
						<>
							<div className="flex items-center justify-between px-2 sm:px-4 py-2 border-b border-crease-line bg-graph-card flex-shrink-0">
								<span className="text-sm text-graphite flex items-center gap-1 sm:gap-2 min-w-0">
									<button
										onClick={() => setMobileView('list')}
										className="min-[900px]:hidden flex items-center justify-center w-11 h-11 -ml-1 text-graphite hover:text-crease flex-shrink-0"
										aria-label="Back to conversations"
									>
										<ChevronLeft className="w-5 h-5" />
									</button>
									<Users className="w-4 h-4 opacity-70 flex-shrink-0" />
									<span className="font-medium truncate">{activeGroup.name}</span>
									<span className="hidden sm:inline text-xs text-graphite-40 font-mono truncate">{activeGroup.members.join(', ')}</span>
								</span>
								{username === activeGroup.creator && (
									<button
										onClick={() => setManageGroupOpen((v) => !v)}
										className="text-xs flex items-center gap-1 px-2 py-1 border border-crease-line-bold hover:border-crease text-graphite rounded transition-colors flex-shrink-0"
									>
										<Users className="w-3.5 h-3.5" /> Manage
									</button>
								)}
							</div>

							{manageGroupOpen && username === activeGroup.creator && (
								<div className="px-4 py-3 border-b border-crease-line bg-inset flex-shrink-0 space-y-2">
									<form
										onSubmit={(e) => {
											e.preventDefault();
											const m = addMemberInput.trim();
											if (m) void handleAddMember(activeGroup, m);
											setAddMemberInput('');
										}}
										className="flex gap-2"
									>
										<input
											value={addMemberInput}
											onChange={(e) => setAddMemberInput(e.target.value)}
											placeholder="Add member by username"
											className="flex-1 rounded-lg border border-crease-line-bold bg-graph-card text-graphite placeholder-graphite-40 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-crease"
										/>
										<button type="submit" className="bg-crane text-white px-3 py-1.5 rounded-lg text-sm hover:bg-crane-dark transition-colors">
											Add
										</button>
									</form>
									<div className="flex flex-wrap gap-2">
										{activeGroup.members.map((m) => (
											<span key={m} className="inline-flex items-center gap-1 text-xs font-mono bg-graph-card border border-crease-line rounded-full px-2 py-1">
												{m}
												{m === activeGroup.creator ? (
													<span className="text-graphite-40">(creator)</span>
												) : (
													<button
														onClick={() => void handleRemoveMember(activeGroup, m)}
														aria-label={`Remove ${m}`}
														className="text-crane hover:text-crane-dark"
													>
														×
													</button>
												)}
											</span>
										))}
									</div>
								</div>
							)}

							<MessageList
								/* Remount per conversation: resets the message window, the
								   scroll position and the fold-animation seed, so switching
								   chats doesn't carry an expanded window or replay folds. */
								key={activeConversationKey ?? ''}
								messages={activeMessages}
								currentUsername={username ?? ''}
								loading={connecting}
								onReply={handleStartReply}
								onLongPress={handleLongPressMessage}
							/>
							<MessageInput
								onSendMessage={handleSendMessage}
								onSendMedia={handleSendMedia}
								disabled={connecting || !!error}
								replyingTo={replyingTo}
								onCancelReply={() => setReplyingTo(null)}
								currentUsername={username ?? ''}
							/>
						</>
					) : activeContact && activeContactRecord ? (
						<>
							{/* Per-conversation verification bar */}
							<div className="flex items-center justify-between px-2 sm:px-4 py-2 border-b border-crease-line bg-graph-card flex-shrink-0">
								<span className="font-mono text-sm text-graphite flex items-center gap-1 sm:gap-2 min-w-0">
									<button
										onClick={() => setMobileView('list')}
										className="min-[900px]:hidden flex items-center justify-center w-11 h-11 -ml-1 text-graphite hover:text-crease flex-shrink-0"
										aria-label="Back to conversations"
									>
										<ChevronLeft className="w-5 h-5" />
									</button>
									<span className="truncate">{activeContactRecord.username}</span>
									{activeContactRecord.verified && (
										<span className="flex items-center gap-1 text-sax text-xs flex-shrink-0">
											<ShieldCheck className="w-3.5 h-3.5" /> verified
										</span>
									)}
								</span>
								<div className="flex items-center gap-2">
									<DisappearingTimerMenu seconds={activeContactRecord.disappearingSeconds} onChange={(s) => void handleSetTimer(s)} />
									<button
										onClick={() => setVerifyDialogOpen(true)}
										className="text-xs flex items-center gap-1 px-2 py-1 border border-crease-line-bold hover:border-crease text-graphite rounded transition-colors"
									>
										<ShieldCheck className="w-3.5 h-3.5" />
										{activeContactRecord.verified ? 'Safety number' : 'Verify'}
									</button>
									<ContactMenu
										contactUsername={activeContactRecord.username}
										onRemoveContact={() => void handleRemoveContact(activeContactRecord.username)}
									/>
								</div>
							</div>

							{/* Non-dismissable-until-acknowledged key-change warning */}
							{activeContactRecord.keyChangeUnacknowledged && (
								<div className="bg-crane/10 border-b border-crane px-4 py-3 flex items-start gap-3 flex-shrink-0">
									<ShieldAlert className="w-5 h-5 text-crane flex-shrink-0 mt-0.5" />
									<div className="flex-1">
										<p className="text-sm text-crane font-medium">
											{activeContactRecord.username}&rsquo;s safety number has changed.
										</p>
										<p className="text-xs text-graphite-60 mt-0.5">
											This happens if they reinstalled or switched devices — but it can also mean someone is
											intercepting your messages. Verify before you trust this conversation.
										</p>
										<div className="flex gap-3 mt-2">
											<button
												onClick={() => setVerifyDialogOpen(true)}
												className="text-xs font-medium text-crane underline"
											>
												Verify now
											</button>
											<button onClick={() => void acknowledgeKeyChange()} className="text-xs text-graphite-60 underline">
												Dismiss
											</button>
										</div>
									</div>
								</div>
							)}

							<MessageList
								/* Remount per conversation: resets the message window, the
								   scroll position and the fold-animation seed, so switching
								   chats doesn't carry an expanded window or replay folds. */
								key={activeConversationKey ?? ''}
								messages={activeMessages}
								currentUsername={username ?? ''}
								loading={connecting}
								onReply={handleStartReply}
								onLongPress={handleLongPressMessage}
							/>
							<MessageInput
								onSendMessage={handleSendMessage}
								onSendMedia={handleSendMedia}
								disabled={connecting || !!error}
								replyingTo={replyingTo}
								onCancelReply={() => setReplyingTo(null)}
								currentUsername={username ?? ''}
							/>
						</>
					) : (
						<div className="flex-1 flex items-center justify-center text-graphite-40 text-sm">
							Select or add a contact to start a conversation.
						</div>
					)}
				</div>
			</div>

			{verifyDialogOpen && activeContactRecord && username && (
				<SafetyNumberDialog
					selfUsername={username}
					contact={activeContactRecord}
					onClose={() => setVerifyDialogOpen(false)}
					onSetVerified={handleSetVerified}
					keyChanged={activeContactRecord.keyChangeUnacknowledged}
				/>
			)}

			{actionSheetMessage && username && (
				<MessageActionSheet
					message={actionSheetMessage}
					isOwnMessage={actionSheetMessage.from === username}
					// Delete-for-everyone: our own, non-deleted, 1:1 messages only.
					canDeleteForEveryone={actionSheetMessage.from === username && !actionSheetMessage.deleted && !!activeContact && !activeGroup}
					currentUsername={username}
					onClose={() => setActionSheetMessage(null)}
					onReply={handleStartReply}
					onDeleteForMe={(m) => void handleDeleteForMe(m)}
					onDeleteForEveryone={(m) => void handleDeleteForEveryone(m)}
				/>
			)}

			{searchOpen && username && (
				<SearchDialog
					username={username}
					onClose={() => setSearchOpen(false)}
					onSelectResult={(contact) => {
						setSearchOpen(false);
						void handleSelectContact(contact);
					}}
				/>
			)}

			{createGroupOpen && (
				<CreateGroupDialog
					contacts={contacts.map((c) => c.username)}
					onClose={() => setCreateGroupOpen(false)}
					onCreate={handleCreateGroup}
				/>
			)}

			{settingsOpen && username && (
				<SettingsDialog
					username={username}
					onClose={() => setSettingsOpen(false)}
					onSignOut={() => {
						setSettingsOpen(false);
						void handleLogout();
					}}
				/>
			)}
		</div>
	);
};
