import { describe, expect, it } from 'vitest';
import { decodeChatPayload, encodeChatPayload, type ChatPayload } from './chatPayload';

describe('chat payload codec', () => {
	it('round-trips a text payload', () => {
		const payload: ChatPayload = { t: 'text', text: 'hello world' };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('round-trips a text payload with an expiry', () => {
		const payload: ChatPayload = { t: 'text', text: 'poof', expiresInSeconds: 3600 };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('round-trips a timer control payload', () => {
		const payload: ChatPayload = { t: 'timer', expiresInSeconds: 86400 };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('round-trips a media payload', () => {
		const payload: ChatPayload = {
			t: 'media',
			caption: 'a photo',
			media: {
				id: 'abc',
				key: 'a2V5',
				nonce: 'bm9uY2U=',
				digest: 'ZGln',
				mediaKind: 'image',
				mimeType: 'image/png',
				size: 1234,
			},
		};
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('round-trips a text payload carrying a reply quote', () => {
		const payload: ChatPayload = { t: 'text', text: 'agreed', replyTo: { id: 'm7', from: 'bob', text: 'shall we?' } };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('round-trips a delivery-token control payload (sealed sender)', () => {
		const payload: ChatPayload = { t: 'deliverytoken', token: 'A1b2C3d4E5f6G7h8' };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('degrades unparseable (non-padded / corrupt) bytes to empty text without crashing', () => {
		const garbage = new TextEncoder().encode('an old unpadded raw-text message');
		expect(decodeChatPayload(garbage)).toEqual({ t: 'text', text: '' });
	});

	it('rejects an unknown payload type (allow-list), degrading to empty text', () => {
		// Hand-build a padded frame whose `t` is not in the decode allow-list.
		const json = new TextEncoder().encode(JSON.stringify({ t: 'evil', boom: true }));
		const bytes = new Uint8Array(256);
		bytes[0] = (json.length >>> 24) & 0xff;
		bytes[1] = (json.length >>> 16) & 0xff;
		bytes[2] = (json.length >>> 8) & 0xff;
		bytes[3] = json.length & 0xff;
		bytes.set(json, 4);
		expect(decodeChatPayload(bytes)).toEqual({ t: 'text', text: '' });
	});
});

describe('message-length padding', () => {
	it('pads every payload to a bucket size, hiding exact length', () => {
		// Two different short messages must encode to the SAME length (same bucket).
		const a = encodeChatPayload({ t: 'text', text: 'hi' });
		const b = encodeChatPayload({ t: 'text', text: 'a much longer but still small message' });
		expect(a.length).toBe(b.length); // both land in the smallest bucket
		expect(a.length).toBe(256);
	});

	it('encoded length depends only on the bucket, not the exact message', () => {
		// Same length input strings → same encoded length (trivially), and lengths
		// within a bucket are indistinguishable.
		const short = encodeChatPayload({ t: 'text', text: 'x'.repeat(10) });
		const short2 = encodeChatPayload({ t: 'text', text: 'y'.repeat(50) });
		expect(short.length).toBe(short2.length);
		expect([256, 512, 1024, 2048, 4096].includes(short.length)).toBe(true);
	});

	it('grows to larger buckets for larger messages and round-trips them', () => {
		const big: ChatPayload = { t: 'text', text: 'z'.repeat(6000) };
		const encoded = encodeChatPayload(big);
		expect(encoded.length % 4096).toBe(0); // large-bucket step
		expect(encoded.length).toBeGreaterThan(6000);
		expect(decodeChatPayload(encoded)).toEqual(big);
	});

	it('round-trips a message whose JSON length exactly hits a bucket boundary', () => {
		// Pick a text that pushes total content right around 256.
		const payload: ChatPayload = { t: 'text', text: 'x'.repeat(240) };
		expect(decodeChatPayload(encodeChatPayload(payload))).toEqual(payload);
	});

	it('the padding bytes are zeros (deterministic, no data leak in the pad)', () => {
		const encoded = encodeChatPayload({ t: 'text', text: 'hi' });
		// After the 4-byte length + JSON, the rest must be zero.
		const jsonLen = encoded[0] * 0x1000000 + (encoded[1] << 16) + (encoded[2] << 8) + encoded[3];
		for (let i = 4 + jsonLen; i < encoded.length; i++) expect(encoded[i]).toBe(0);
	});
});
