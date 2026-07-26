import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

// FULL_AUDIT_2 A4. The five themes (D3) were verified against the pairings the
// D3 doc enumerated, but the components use pairings D3 never listed —
// `text-white` on the orbit panel, `text-white` on a sax fill, `text-sax` over a
// `bg-sax/20` chip. Three of five themes shipped AA failures because of it, and
// one of them (Vellum's safety-number sheet, 1.27:1) made the app's most
// trust-critical screen unreadable.
//
// So this test encodes the pairings that COMPONENTS ACTUALLY RENDER, taken from
// a grep of the token utilities in src/, and computes the numbers rather than
// quoting them. Two rules make it honest:
//
//  1. Token values are parsed out of src/index.css at run time. A hand-copied
//     table would keep passing while the stylesheet drifted underneath it,
//     which is the exact failure mode A4 exists to prevent.
//  2. Alpha is composited BEFORE the WCAG maths. `bg-sax/20` is not `sax`; a
//     ratio computed against the un-composited token is simply a different
//     number from the one on screen.
//
// Add a row here whenever a component introduces a new foreground/background
// pairing. That is cheaper than another round of "the theme looked fine".
//
// A LIMIT worth knowing, found by checking these numbers against a real browser
// (Chrome, painting to a canvas and reading the pixel back): the composite()
// below models a Tailwind `/NN` modifier as straight sRGB alpha, but Tailwind v4
// emits `color-mix(in oklab, …)`, and the two disagree — measured 4.61 where
// this file computed 4.99. Optimistic, i.e. in the unsafe direction.
//
// So no TEXT that has to clear 4.5 uses an opacity modifier any more. Where
// something needed to look de-emphasised it gets a token whose value is
// precomputed per theme (`--color-orbit-fg-dim`, `--color-on-crease-dim`), which
// is an exact colour with no mixing at render time — nothing left to model, and
// this file and the browser agree by construction. `/NN` survives only on fills
// and boundaries at the 3.0 bar, where the margin swallows the difference. A
// grep below enforces that.

// Read off disk, from the repo root (vitest's cwd). Not via Vite's `?raw`:
// index.css would come back COMPILED by Tailwind, with the token blocks gone —
// and under jsdom `import.meta.url` isn't a file: URL, so the usual
// fileURLToPath dance doesn't work either.
const fromRoot = (path: string) => readFileSync(resolvePath(process.cwd(), path), 'utf8');

const CSS = fromRoot('src/index.css');

/** Every .ts/.tsx under src/, for the "do components actually use the tokens" greps. */
const SOURCES: [path: string, body: string][] = [];
(function walk(dir: string) {
	for (const entry of readdirSync(resolvePath(process.cwd(), dir), { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) walk(path);
		else if (/\.tsx?$/.test(entry.name)) SOURCES.push([path, fromRoot(path)]);
	}
})('src');

// ---- token parsing -------------------------------------------------------

type Tokens = Record<string, string>;

/** Pull one `:root…{ … }` block's custom properties out of the stylesheet. */
function tokensForSelector(selector: string): Tokens {
	const at = CSS.indexOf(selector);
	if (at === -1) throw new Error(`No such selector in src/index.css: ${selector}`);
	const open = CSS.indexOf('{', at);
	const close = CSS.indexOf('\n}', open);
	const body = CSS.slice(open + 1, close);
	const tokens: Tokens = {};
	for (const [, name, value] of body.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) {
		tokens[name] = value.trim();
	}
	return tokens;
}

const THEMES = {
	paper: ":root,\n:root[data-theme='paper']",
	ink: ":root[data-theme='ink']",
	vellum: ":root[data-theme='vellum']",
	graphite: ":root[data-theme='graphite']",
	'midnight-crane': ":root[data-theme='midnight-crane']",
} as const;

type ThemeName = keyof typeof THEMES;

// ---- colour maths --------------------------------------------------------

type Rgb = [number, number, number];

function parseColor(value: string): { rgb: Rgb; alpha: number } {
	const hex = value.match(/^#([0-9a-f]{6})$/i);
	if (hex) {
		const n = parseInt(hex[1], 16);
		return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
	}
	const rgba = value.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
	if (rgba) {
		return {
			rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])],
			alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
		};
	}
	throw new Error(`Cannot parse colour: ${value}`);
}

/** Flatten a translucent colour onto an opaque one — sRGB, as a browser does. */
function composite(fg: { rgb: Rgb; alpha: number }, bg: Rgb): Rgb {
	return fg.rgb.map((c, i) => fg.alpha * c + (1 - fg.alpha) * bg[i]) as Rgb;
}

function relativeLuminance([r, g, b]: Rgb): number {
	const lin = [r, g, b].map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/**
 * A layer in a component's paint stack, written the way the class name reads:
 * `sax/20` is the `--color-sax` token at 20% alpha, `white/70` is literal white
 * at 70%. Layers are composited bottom-up before the ratio is taken.
 */
function resolve(layer: string, tokens: Tokens): { rgb: Rgb; alpha: number } {
	const [name, pct] = layer.split('/');
	const raw = name === 'white' ? '#FFFFFF' : name === 'black' ? '#000000' : tokens[`--color-${name}`];
	if (raw === undefined) throw new Error(`Unknown token: --color-${name}`);
	const parsed = parseColor(raw);
	// A Tailwind opacity modifier REPLACES the token's own alpha, matching how
	// `text-graphite-40/50` would render — the tokens carrying rgba() already
	// bake their alpha in, so only apply the modifier when one is written.
	return pct === undefined ? parsed : { rgb: parsed.rgb, alpha: parsed.alpha * (Number(pct) / 100) };
}

/** Ratio of `fg` over a background painted bottom-up from `bg` layers. */
function ratio(fg: string, bg: string[], tokens: Tokens): number {
	let surface = resolve(bg[0], tokens).rgb;
	for (const layer of bg.slice(1)) surface = composite(resolve(layer, tokens), surface);
	return contrast(composite(resolve(fg, tokens), surface), surface);
}

// ---- the pairings components actually render -----------------------------

const TEXT = 4.5; // WCAG 1.4.3, body-sized text
const GRAPHIC = 3.0; // WCAG 1.4.11, icons and component boundaries

interface Pairing {
	where: string;
	fg: string;
	bg: string[];
	bar: number;
}

const PAIRINGS: Pairing[] = [
	// --- the orbit panel: SafetyNumberDialog, the verification surface -------
	{ where: 'SafetyNumberDialog:155 sheet body', fg: 'orbit-fg', bg: ['orbit'], bar: TEXT },
	{ where: 'SafetyNumberDialog:170/176/194/208/229 de-emphasis', fg: 'orbit-fg-dim', bg: ['orbit'], bar: TEXT },
	{ where: 'SafetyNumberDialog:179 safety digits', fg: 'orbit-fg', bg: ['orbit', 'black/25'], bar: TEXT },
	{ where: 'SafetyNumberDialog:205 "Verified"', fg: 'sax-on-orbit', bg: ['orbit'], bar: TEXT },
	{ where: 'SafetyNumberDialog:217 scan button border', fg: 'orbit-fg/40', bg: ['orbit'], bar: GRAPHIC },
	{ where: 'SafetyNumberDialog:224 "Mark as verified"', fg: 'on-sax', bg: ['sax'], bar: TEXT },
	{ where: 'SafetyNumberDialog:160 key-change banner', fg: 'white', bg: ['crane'], bar: TEXT },

	// --- crane, the primary-action fill: 18 sites, every button in the app ----
	// Not in the audit's table, but the same defect as A2 in a different hue —
	// `bg-crane text-white` was 3.86:1 in three of five themes.
	{ where: 'LoginForm:141 / SignupForm:108 / 16 more', fg: 'white', bg: ['crane'], bar: TEXT },
	{ where: 'ConfirmationDialog:98 + 4 more crease buttons', fg: 'on-crease', bg: ['crease'], bar: TEXT },
	// Own-message bubbles are bg-crease. The most-rendered text in the app, and
	// `text-white` on crease was 2.47:1 in both dark themes.
	{ where: 'MessageItem:106 own bubble body', fg: 'on-crease', bg: ['crease'], bar: TEXT },
	{ where: 'MessageItem:129/143 own-bubble meta', fg: 'on-crease-dim', bg: ['crease'], bar: TEXT },
	// Inside the reply quote the surface is crease LIGHTENED by a 10% on-crease
	// wash, not bare crease. Omitting that layer is how this row read 4.97 here
	// while a real browser measured 3.81 — see the note on opacity below.
	{ where: 'MessageItem:119/122 reply-quote text', fg: 'on-crease-dim', bg: ['crease', 'on-crease/10'], bar: TEXT },
	{ where: 'MessageItem:116 own-bubble reply rule', fg: 'on-crease/60', bg: ['crease'], bar: GRAPHIC },
	{ where: 'VoiceNote:88 own waveform accent', fg: 'on-crease', bg: ['crease'], bar: GRAPHIC },
	// GRAPHIC, not TEXT: it is a play/pause glyph in a button that carries its own
	// aria-label, so nothing here is read as text. The 20% chip behind it lightens
	// toward the glyph's own colour, which is what costs the ratio.
	{ where: 'VoiceNote:114 own play button glyph', fg: 'on-crease', bg: ['crease', 'on-crease/20'], bar: GRAPHIC },
	{ where: 'MessageInput:186 + every error line', fg: 'crane-ink', bg: ['graph-card'], bar: TEXT },
	{ where: 'MessageInput:186 error-box border', fg: 'crane-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'ContactList:207 key-change shield', fg: 'crane-ink', bg: ['graph-card'], bar: GRAPHIC },
	// crane as a small GRAPHIC on the card, not a fill behind white text. Darkening
	// --color-crane so it could carry white text pushed these the wrong way: the
	// unread dot fell to 2.91 in Ink. They take crane-ink, same call as the sax dot.
	{ where: 'ContactList:212 unread dot', fg: 'crane-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'TabBar:64 unread badge', fg: 'crane-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'Chat:1372 disconnected dot', fg: 'crane-ink', bg: ['graph-card'], bar: GRAPHIC },

	// --- sax as a fill with text on it --------------------------------------
	{ where: 'SettingsDialog:386 recovery-code button', fg: 'on-sax', bg: ['sax'], bar: TEXT },

	// --- sax as text on the card surface ------------------------------------
	{ where: 'SettingsDialog:312 "Password changed"', fg: 'sax-ink', bg: ['graph-card'], bar: TEXT },
	{ where: 'MessageInput:347 character counter', fg: 'sax-ink', bg: ['graph-card'], bar: TEXT },
	{ where: 'ContactsPane:148 "verified"', fg: 'sax-ink', bg: ['graph-card'], bar: TEXT },
	{ where: 'DisappearingTimerMenu:23 active timer', fg: 'sax-ink', bg: ['graph-card'], bar: TEXT },
	{ where: 'Transparency:103 caveat heading icon', fg: 'sax-ink', bg: ['graph', 'sax/10'], bar: GRAPHIC },

	// --- sax as text on the sax/20 chip (composited, not on card) -----------
	{ where: 'SettingsDialog:467 notifications ON', fg: 'sax-ink', bg: ['graph-card', 'sax/20'], bar: TEXT },
	{ where: 'BiometricSection:70 ON', fg: 'sax-ink', bg: ['graph-card', 'sax/20'], bar: TEXT },
	{ where: 'PasskeySection:79 ON', fg: 'sax-ink', bg: ['graph-card', 'sax/20'], bar: TEXT },
	{ where: 'TwoFactorSection:87 ON', fg: 'sax-ink', bg: ['graph-card', 'sax/20'], bar: TEXT },

	// --- gold as a graphic on the card surface ------------------------------
	// These take `sax-ink` too, not the fill token: an icon or a 6px status dot
	// still has to be seen against the card, and the fill gold is tuned to carry
	// dark ink on top of it, not to be legible sitting on parchment.
	{ where: 'ContactList:209 verified shield', fg: 'sax-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'Toast.tsx:31 success icon', fg: 'sax-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'Toast.tsx:29 success border', fg: 'sax-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'Chat:1372 connected dot', fg: 'sax-ink', bg: ['graph-card'], bar: GRAPHIC },
	{ where: 'DisappearingTimerMenu:23 active border', fg: 'sax-ink', bg: ['graph-card'], bar: GRAPHIC },
];

// Deliberately NOT asserted, so the omission is a decision rather than an
// oversight: the translucent gold boundaries — `border-sax/40` on the recovery
// and 2FA panels, `border-sax/50` on the verify button, `bg-sax/10` on the
// Transparency caveat — are decorative tinting. None of them is the only way to
// tell what a control is or what state it is in: each panel is titled, and the
// verify button carries an opaque `sax-ink` shield glyph plus an aria-label that
// says "verified". Holding a 40%-alpha wash to 3:1 would force the gold dark
// enough to stop reading as a tint at all.

describe('theme contrast', () => {
	for (const theme of Object.keys(THEMES) as ThemeName[]) {
		describe(theme, () => {
			const tokens = tokensForSelector(THEMES[theme]);

			for (const { where, fg, bg, bar } of PAIRINGS) {
				const label = `${fg} on ${bg.join(' + ')} — ${where}`;
				it(`meets ${bar}:1 — ${label}`, () => {
					const measured = ratio(fg, bg, tokens);
					// Round the way a contrast checker reports, so a 4.497 doesn't
					// pass on a floating-point technicality.
					expect(Math.floor(measured * 100) / 100).toBeGreaterThanOrEqual(bar);
				});
			}
		});
	}

	// Everything above proves the TOKENS are sound. It proves nothing about
	// whether components use them — a stylesheet full of AA-passing values is
	// worth nothing if `SafetyNumberDialog` still says `text-white`. These greps
	// close that gap: they are the half of A4 that the arithmetic can't reach.
	describe('components use the split tokens', () => {
		it('no `text-sax` — on-card uses take sax-ink, on-orbit uses take sax-on-orbit', () => {
			// The negative lookahead keeps `text-sax-ink` / `text-sax-on-orbit`
			// from matching their own prefix.
			const offenders = SOURCES.filter(([, body]) => /\btext-sax(?!-)/.test(body)).map(([path]) => path);
			expect(offenders).toEqual([]);
		});

		it('no white or orbit foreground on a sax fill — sax fills take on-sax', () => {
			const offenders = SOURCES.filter(([, body]) => /\bbg-sax\b[^"'`]*\btext-(white|orbit)\b/.test(body)).map(([path]) => path);
			expect(offenders).toEqual([]);
		});

		it('no white foreground on a crease fill — crease fills take on-crease', () => {
			// crease is a LIGHT blue/apricot in the dark themes, so white on it is
			// 2.47:1 there. Own-message bubbles are the biggest instance.
			const offenders = SOURCES.filter(([, body]) => /\bbg-crease\b[^"'`]*\btext-white\b/.test(body)).map(([path]) => path);
			expect(offenders).toEqual([]);
		});

		it('no opacity-modified TEXT — de-emphasis uses a precomputed -dim token', () => {
			// The sRGB model above disagrees with Tailwind v4's oklab color-mix by
			// enough to matter (4.99 computed vs 4.61 measured), always optimistic.
			// Fills and borders may still use /NN; text may not.
			const offenders = SOURCES.filter(([, body]) => /\btext-[a-z-]+\/\d+/.test(body)).flatMap(([path, body]) =>
				(body.match(/\btext-[a-z-]+\/\d+/g) ?? []).map((cls) => `${path}: ${cls}`)
			);
			expect(offenders).toEqual([]);
		});

		it('no bare `bg-crane` status dot — a dot is a graphic on the card, so crane-ink', () => {
			// `bg-crane` behind white text is the fill role and stays. A dot has no
			// text on it: it is a graphic sitting ON the card, and crane was darkened
			// for the fill role, which took the Ink dot to 2.91.
			const offenders = SOURCES.flatMap(([path, body]) =>
				(body.match(/'[^']*\bbg-crane\b(?![-/])[^']*'|"[^"]*\bbg-crane\b(?![-/])[^"]*"/g) ?? [])
					.filter((cls) => !/\btext-/.test(cls))
					.map((cls) => `${path}: ${cls.slice(0, 60)}`)
			);
			expect(offenders).toEqual([]);
		});

		it('no `text-crane` — crane is a fill; foregrounds on card take crane-ink', () => {
			// `bg-crane` is exempt — that IS the fill role — except as a bare status
			// dot, which is a graphic on the card and belongs to crane-ink.
			const offenders = SOURCES.filter(([, body]) => /\b(text|border|ring)-crane(?![-\w])/.test(body)).map(([path]) => path);
			expect(offenders).toEqual([]);
		});

		it('the safety-number sheet has no hardcoded white foreground left', () => {
			// The opacity variants specifically: `text-white/70` is the de-emphasis
			// case, and it is exactly the one a partial fix leaves behind. The one
			// bare `text-white` that survives is on the crane banner, which is a
			// pairing asserted above, so it is spelled out rather than banned.
			const src = fromRoot('src/components/chat/SafetyNumberDialog.tsx');
			expect(src).not.toMatch(/(text|border)-white\//);
			expect(src.match(/\btext-white\b/g) ?? []).toHaveLength(1);
		});
	});
});
