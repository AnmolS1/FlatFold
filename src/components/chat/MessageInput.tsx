import { useState, useCallback, useEffect, useRef, memo, type FormEvent, type KeyboardEvent, type ChangeEvent } from 'react';
import { Send, AlertCircle, Plus, Mic, Square, Reply, X, Image as ImageIcon, Paperclip } from 'lucide-react';
import type { MediaUploadInput } from '../../lib/media';
import type { DisplayMessage } from '../../types';
import { haptic } from '../../lib/haptics';
import { replySnippet } from '../../lib/reply';
import { isApplePlayable, pickRecordingMimeType } from '../../lib/audioFormat';
import { describeMicrophoneError, microphoneUnavailableReason, readMediaEnvironment } from '../../lib/mediaErrors';
import { nativeRecordingSupported, recordNatively } from '../../lib/nativeAudio';
import { nativeLog, timed } from '../../lib/nativeLog';
import { isIOSAppOnMac } from '../../lib/platform';

interface MessageInputProps {
	onSendMessage: (text: string) => Promise<void>;
	onSendMedia: (input: MediaUploadInput) => Promise<void>;
	disabled?: boolean;
	/** The message being replied to (shows a quote chip above the input). */
	replyingTo?: DisplayMessage | null;
	onCancelReply?: () => void;
	currentUsername?: string;
}

const MessageInputComponent = ({
	onSendMessage,
	onSendMedia,
	disabled = false,
	replyingTo = null,
	onCancelReply,
	currentUsername,
}: MessageInputProps) => {
	const [message, setMessage] = useState('');
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [recording, setRecording] = useState(false);
	// The attach bottom-sheet (D2 §Composer/§Media): one "+" control opens a
	// sheet of Photo / File / Voice, instead of the "+" firing the file picker
	// directly. Keeps the composer's visible footprint to two controls.
	const [attachOpen, setAttachOpen] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const photoInputRef = useRef<HTMLInputElement>(null);

	// Collapse the attach sheet when the native file/photo picker is dismissed.
	// The `cancel` DOM event fires on a file input on dismiss, but @types/react
	// doesn't expose it as an `onCancel` prop — so bind it imperatively.
	useEffect(() => {
		const collapse = () => setAttachOpen(false);
		const file = fileInputRef.current;
		const photo = photoInputRef.current;
		file?.addEventListener('cancel', collapse);
		photo?.addEventListener('cancel', collapse);
		return () => {
			file?.removeEventListener('cancel', collapse);
			photo?.removeEventListener('cancel', collapse);
		};
	}, []);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	// Live native recording session (Mac only, where the WebView has no
	// mediaDevices); null on every other platform, which uses recorderRef above.
	const nativeSessionRef = useRef<{ stop: () => Promise<{ bytes: Uint8Array; mimeType: string; durationMs: number }> } | null>(null);
	const recordStartRef = useRef<number>(0);
	// Double-submit guard. A ref, not the `sending` state: two synchronous
	// submits (Enter held down, a double-tap on Send) both read the same stale
	// `sending === false` from this closure before React re-renders, so a state
	// check would let both through. A ref mutates immediately.
	const sendingRef = useRef(false);

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		setMessage(e.target.value);
	}, []);

	const handleFilePick = useCallback(
		async (e: ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			e.target.value = ''; // allow re-picking the same file
			setAttachOpen(false); // picker returned — collapse the attach sheet
			if (!file) return;
			setError(null);
			setSending(true);
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				await onSendMedia({
					bytes,
					mimeType: file.type || 'application/octet-stream',
					mediaKind: file.type.startsWith('image/') ? 'image' : 'file',
					name: file.name,
				});
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Failed to send attachment');
			} finally {
				setSending(false);
			}
		},
		[onSendMedia]
	);

	const startRecording = useCallback(async () => {
		setError(null);

		// Mac first: there `navigator.mediaDevices` does not exist at all, so the
		// only route to the microphone is the native plugin. Everywhere else
		// getUserMedia works and stays the path — it needs no native surface.
		if (await nativeRecordingSupported()) {
			try {
				const session = await recordNatively.start();
				nativeSessionRef.current = session;
				recordStartRef.current = Date.now();
				setRecording(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : 'Could not start recording.');
			}
			return;
		}

		// Capability BEFORE permission. On the Mac build `navigator.mediaDevices`
		// is absent entirely, so the old code threw a bare TypeError here and the
		// failure looked like a permission problem for several rounds. See
		// lib/mediaErrors; SafetyNumberDialog has guarded its camera path this way
		// all along.
		const unavailable = microphoneUnavailableReason(readMediaEnvironment(navigator, window));
		if (unavailable) {
			setError(unavailable);
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			// Pick the container explicitly. Left to the browser, Chrome picks WebM,
			// which Safari and WKWebView cannot decode — so the note was unplayable on
			// every Apple device, silently, on the RECEIVING end. See lib/audioFormat.
			const mimeType = pickRecordingMimeType();
			const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
			const chunks: BlobPart[] = [];
			recorder.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
			recorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				const durationMs = Date.now() - recordStartRef.current;
				const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
				// Firefox can only produce Opus, which Apple devices cannot play. Tell the
				// SENDER here rather than letting it fail silently on someone else's phone.
				if (!isApplePlayable(blob.type)) {
					setError('Heads up: this browser records audio in a format Apple devices cannot play. The note will send, but iPhone and Mac recipients will not hear it.');
				}
				setSending(true);
				try {
					await onSendMedia({
						bytes: new Uint8Array(await blob.arrayBuffer()),
						mimeType: blob.type,
						mediaKind: 'voice',
						durationMs,
					});
				} catch (err) {
					setError(err instanceof Error ? err.message : 'Failed to send voice note');
				} finally {
					setSending(false);
				}
			};
			recorderRef.current = recorder;
			recordStartRef.current = Date.now();
			recorder.start();
			setRecording(true);
		} catch (err) {
			// Name the failure. A bare catch here made the Mac microphone bug
			// undiagnosable for several rounds — see lib/mediaErrors.
			setError(describeMicrophoneError(err, isIOSAppOnMac()));
		}
	}, [onSendMedia]);

	const stopRecording = useCallback(() => {
		// Native path (Mac): the plugin hands back finished bytes, which then go
		// down exactly the same send path as a browser-recorded note.
		const session = nativeSessionRef.current;
		if (session) {
			nativeSessionRef.current = null;
			setRecording(false);
			void (async () => {
				setSending(true);
				try {
					const rec = await timed('session.stop', () => session.stop());
					nativeLog(`got ${rec.bytes.length} bytes`);
					await timed('onSendMedia', () =>
						onSendMedia({
							bytes: rec.bytes,
							mimeType: rec.mimeType,
							mediaKind: 'voice',
							durationMs: rec.durationMs || Date.now() - recordStartRef.current,
						})
					);
				} catch (err) {
					setError(err instanceof Error ? err.message : 'Failed to send voice note');
				} finally {
					setSending(false);
				}
			})();
			return;
		}
		recorderRef.current?.stop();
		recorderRef.current = null;
		setRecording(false);
	}, [onSendMedia]);

	const handleSubmit = useCallback(
		async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			setError(null);

			const trimmedMessage = message.trim();
			if (!trimmedMessage || sendingRef.current) {
				return;
			}

			haptic(); // a brief tick as the message folds away
			sendingRef.current = true;
			setSending(true);

			try {
				await onSendMessage(trimmedMessage);
				setMessage('');
				// Put the caret straight back in the composer so you can keep
				// typing. Synchronous, inside the submit handler's user-gesture
				// context — that's what lets mobile Safari/Chrome reopen the
				// keyboard. Usually a no-op (the field is never disabled now), but
				// it matters when the user tapped Send, which moves focus to the
				// button.
				textareaRef.current?.focus();
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
				setError(errorMessage);
			} finally {
				sendingRef.current = false;
				setSending(false);
			}
		},
		[message, onSendMessage]
	);

	const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
		// Send on Enter (without Shift)
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			const form = e.currentTarget.form;
			if (form) {
				form.requestSubmit();
			}
		}
	}, []);

	const MAX_LENGTH = 2000;
	const characterCount = message.length;
	const hasText = message.trim().length > 0;
	const isDisabled = disabled || sending || !message.trim() || characterCount > MAX_LENGTH;
	const isNearLimit = characterCount >= 1800;
	const isAtLimit = characterCount >= 1950;

	return (
		<div className="bg-graph-card border-t border-crease-line env-safe-bottom env-safe-x flex-shrink-0">
			<div className="px-3 py-3 sm:p-4">
				{error && (
					<div className="mb-3 bg-graph-card border border-crane-ink text-crane-ink px-4 py-2 rounded-lg flex items-start gap-2">
						<AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
						<span className="text-sm">{error}</span>
					</div>
				)}

				{characterCount > MAX_LENGTH && (
					<div className="mb-3 bg-graph-card border border-crane-ink text-crane-ink px-4 py-2 rounded-lg flex items-start gap-2">
						<AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
						<span className="text-sm">Message exceeds maximum length of {MAX_LENGTH} characters</span>
					</div>
				)}

				{/* Reply quote chip — the message we're about to reply to. */}
				{replyingTo && (
					<div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-crease bg-crease/5 pl-2 pr-1 py-1.5">
						<Reply className="w-4 h-4 text-crease flex-shrink-0" aria-hidden="true" />
						<div className="min-w-0 flex-1">
							<p className="text-xs font-mono font-semibold text-crease">
								Replying to {replyingTo.from === currentUsername ? 'yourself' : replyingTo.from}
							</p>
							<p className="text-xs text-graphite-60 truncate">{replySnippet(replyingTo)}</p>
						</div>
						<button
							type="button"
							onClick={onCancelReply}
							aria-label="Cancel reply"
							className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-graphite-40 hover:text-graphite"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				)}

				{/* plus (attach) — pill input — mic/send. The trailing control morphs:
				    mic when the field is empty (tap to record a voice note), send
				    when there's text. */}
				{/* Attach sheet — one control opens Photo / File / Voice, in normal
				    flow above the input row (a bottom sheet, never a floating menu:
				    D2 §Media). The sheet stays up while the native picker is open and
				    closes only once a file is chosen (handleFilePick) or the picker is
				    cancelled (the input's `cancel` event) — so it doesn't flash away
				    before the picker appears. Voice starts recording immediately. */}
				{attachOpen && (
					<div
						role="menu"
						aria-label="Attach"
						className="mb-2 grid grid-cols-3 gap-2 rounded-2xl border border-crease-line-bold bg-inset p-2"
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => photoInputRef.current?.click()}
							className="flex flex-col items-center justify-center gap-1 min-h-[64px] rounded-xl hover:bg-graph-card text-graphite transition-colors"
						>
							<ImageIcon className="w-6 h-6 text-crease" aria-hidden="true" />
							<span className="text-xs font-medium">Photo</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => fileInputRef.current?.click()}
							className="flex flex-col items-center justify-center gap-1 min-h-[64px] rounded-xl hover:bg-graph-card text-graphite transition-colors"
						>
							<Paperclip className="w-6 h-6 text-crease" aria-hidden="true" />
							<span className="text-xs font-medium">File</span>
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => {
								setAttachOpen(false);
								void startRecording();
							}}
							className="flex flex-col items-center justify-center gap-1 min-h-[64px] rounded-xl hover:bg-graph-card text-graphite transition-colors"
						>
							<Mic className="w-6 h-6 text-crease" aria-hidden="true" />
							<span className="text-xs font-medium">Voice</span>
						</button>
					</div>
				)}

				<form onSubmit={handleSubmit} className="flex gap-2 items-end">
					<input
						ref={fileInputRef}
						type="file"
						className="hidden"
						onChange={(e) => void handleFilePick(e)}
					/>
					<input
						ref={photoInputRef}
						type="file"
						accept="image/*"
						className="hidden"
						onChange={(e) => void handleFilePick(e)}
					/>
					<button
						type="button"
						onClick={() => setAttachOpen((v) => !v)}
						disabled={disabled || sending || recording}
						aria-label="Attach"
						aria-expanded={attachOpen}
						aria-haspopup="menu"
						title="Attach a photo, file, or voice note"
						className={`h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
							attachOpen ? 'border-crease bg-crease/10 text-crease rotate-45' : 'border-crease-line-bold text-graphite hover:border-crease'
						}`}
					>
						<Plus className="w-5 h-5 transition-transform" />
					</button>
					<textarea
						ref={textareaRef}
						value={message}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						placeholder={recording ? 'Recording…' : 'Message'}
						// Deliberately NOT disabled on `sending`: disabling blurs the
						// field mid-send, which drops the mobile keyboard and forces a
						// tap back into the box for every message. Sends are optimistic
						// and near-instant, so there's nothing to lock — the
						// double-submit guard in handleSubmit covers the race instead.
						disabled={disabled || recording}
						rows={1}
						className="flex-1 resize-none rounded-3xl border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] max-h-[120px]"
					/>
					{hasText ? (
						<button
							type="submit"
							disabled={isDisabled}
							// Keep the tap from moving focus off the textarea at all.
							// The refocus in handleSubmit runs after `await
							// onSendMessage(...)`, which is outside the user-gesture
							// context — enough to restore the caret on desktop, but iOS
							// will not reopen the keyboard from there. Never losing
							// focus is what actually keeps the mobile keyboard up.
							onPointerDown={(e) => e.preventDefault()}
							aria-label="Send message"
							className="h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full bg-crane text-white hover:bg-crane-dark focus:outline-none focus:ring-2 focus:ring-crane-ink focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							<Send className="w-5 h-5" />
						</button>
					) : (
						<button
							type="button"
							onClick={() => (recording ? stopRecording() : void startRecording())}
							disabled={disabled || sending}
							title={recording ? 'Stop recording' : 'Record a voice note'}
							aria-label={recording ? 'Stop recording' : 'Record a voice note'}
							className={`h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
								recording ? 'border-crane-ink text-crane-ink animate-pulse' : 'border-crease-line-bold text-graphite hover:border-crease'
							}`}
						>
							{recording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
						</button>
					)}
				</form>

				{/* Character counter — only surfaces as you approach the cap, so the
				    composer stays clean at rest. */}
				{isNearLimit && (
					<div className="flex justify-end mt-1.5 text-xs font-mono">
						<p className={`font-medium ${characterCount > MAX_LENGTH || isAtLimit ? 'text-crane-ink' : 'text-sax-ink'}`}>
							{characterCount} / {MAX_LENGTH}
						</p>
					</div>
				)}
			</div>
		</div>
	);
};

export const MessageInput = memo(MessageInputComponent);
