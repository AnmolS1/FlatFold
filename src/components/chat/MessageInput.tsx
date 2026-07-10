import { useState, useCallback, useRef, memo, type FormEvent, type KeyboardEvent, type ChangeEvent } from 'react';
import { Send, AlertCircle, Plus, Mic, Square, Reply, X } from 'lucide-react';
import type { MediaUploadInput } from '../../lib/media';
import type { DisplayMessage } from '../../types';
import { haptic } from '../../lib/haptics';
import { replySnippet } from '../../lib/reply';

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
	const fileInputRef = useRef<HTMLInputElement>(null);
	const recorderRef = useRef<MediaRecorder | null>(null);
	const recordStartRef = useRef<number>(0);

	const handleChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
		setMessage(e.target.value);
	}, []);

	const handleFilePick = useCallback(
		async (e: ChangeEvent<HTMLInputElement>) => {
			const file = e.target.files?.[0];
			e.target.value = ''; // allow re-picking the same file
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
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const recorder = new MediaRecorder(stream);
			const chunks: BlobPart[] = [];
			recorder.ondataavailable = (ev) => ev.data.size > 0 && chunks.push(ev.data);
			recorder.onstop = async () => {
				stream.getTracks().forEach((t) => t.stop());
				const durationMs = Date.now() - recordStartRef.current;
				const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
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
		} catch {
			setError('Could not access the microphone.');
		}
	}, [onSendMedia]);

	const stopRecording = useCallback(() => {
		recorderRef.current?.stop();
		recorderRef.current = null;
		setRecording(false);
	}, []);

	const handleSubmit = useCallback(
		async (e: FormEvent<HTMLFormElement>) => {
			e.preventDefault();
			setError(null);

			const trimmedMessage = message.trim();
			if (!trimmedMessage) {
				return;
			}

			haptic(); // a brief tick as the message folds away
			setSending(true);

			try {
				await onSendMessage(trimmedMessage);
				setMessage('');
			} catch (err) {
				const errorMessage = err instanceof Error ? err.message : 'Failed to send message';
				setError(errorMessage);
			} finally {
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
					<div className="mb-3 bg-graph-card border border-crane text-crane px-4 py-2 rounded-lg flex items-start gap-2">
						<AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
						<span className="text-sm">{error}</span>
					</div>
				)}

				{characterCount > MAX_LENGTH && (
					<div className="mb-3 bg-graph-card border border-crane text-crane px-4 py-2 rounded-lg flex items-start gap-2">
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
				<form onSubmit={handleSubmit} className="flex gap-2 items-end">
					<input ref={fileInputRef} type="file" className="hidden" onChange={(e) => void handleFilePick(e)} />
					<button
						type="button"
						onClick={() => fileInputRef.current?.click()}
						disabled={disabled || sending || recording}
						title="Attach a file"
						aria-label="Attach a file"
						className="h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full border border-crease-line-bold text-graphite hover:border-crease disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						<Plus className="w-5 h-5" />
					</button>
					<textarea
						value={message}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						placeholder={recording ? 'Recording…' : 'Message'}
						disabled={disabled || sending || recording}
						rows={1}
						className="flex-1 resize-none rounded-3xl border border-crease-line-bold bg-inset text-graphite placeholder-graphite-40 px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-crease focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] max-h-[120px]"
					/>
					{hasText ? (
						<button
							type="submit"
							disabled={isDisabled}
							aria-label="Send message"
							className="h-11 w-11 flex-shrink-0 flex items-center justify-center rounded-full bg-crane text-white hover:bg-crane-dark focus:outline-none focus:ring-2 focus:ring-crane focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
								recording ? 'border-crane text-crane animate-pulse' : 'border-crease-line-bold text-graphite hover:border-crease'
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
						<p className={`font-medium ${characterCount > MAX_LENGTH || isAtLimit ? 'text-crane' : 'text-sax'}`}>
							{characterCount} / {MAX_LENGTH}
						</p>
					</div>
				)}
			</div>
		</div>
	);
};

export const MessageInput = memo(MessageInputComponent);
