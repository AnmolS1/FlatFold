// Which chrome the chat shell shows, extracted from Chat.tsx's JSX so it can be
// enumerated exhaustively (test-ui/chatChrome.test.ts).
//
// It lives here because the rules had a dead end in them and nobody could see
// it: four separate conditions, spread across 300 lines of JSX, that only
// combined into a trap in one corner of the state space. On native at >= 900px,
// opening a conversation hid the tab bar (it wanted `mobileView === 'list'`),
// hid the back chevron (`min-[900px]:hidden`), and the header Settings glyph was
// already hidden on native — so Settings became unreachable with no way back.
// That shipped, and it reproduces on iPad in landscape, not just on a Mac.
//
// As predicates the whole space is 32 states and a test walks all of them. The
// rule worth keeping: chrome visibility belongs in one place where the invariant
// "you can always reach Settings" is checkable, not inline where it is only
// observable by using the app in exactly the right order.

export const WIDE_VIEWPORT_PX = 900;

export interface ChatChromeState {
	native: boolean;
	/** Viewport is at least WIDE_VIEWPORT_PX — both panes render side by side. */
	wide: boolean;
	/** Phone navigation: which of the two stacked panes is showing. Meaningless when `wide`. */
	mobileView: 'list' | 'conversation';
	composeOpen: boolean;
	/**
	 * Mirrors `NativeTab`. 'settings' is in the union because the type says so,
	 * but it is never a resting value — the tab bar intercepts that tab to open a
	 * modal and returns without setting it. Kept wide rather than narrowed with a
	 * cast, so the state enumeration in the test covers what the types allow
	 * rather than what the current call site happens to do.
	 */
	activeTab: 'chats' | 'contacts' | 'settings';
}

/**
 * The header Settings glyph: always on the web, and on native once the window is
 * wide enough to be a desktop layout.
 *
 * The `|| wide` half is the fix. D2 caps header actions on phones, which is why
 * native narrow deliberately has no glyph — there the tab bar is the route. Once
 * both panes are side by side the app is not a phone any more, and the tab bar
 * is gone, so the glyph has to come back or there is nothing left.
 */
export const showHeaderSettings = (s: ChatChromeState): boolean => !s.native || s.wide;

/**
 * The bottom tab bar is phone chrome: native, narrow, on the list, not composing.
 *
 * `!wide` is new. Above the breakpoint the layout is already two panes, so a
 * bottom tab bar has nothing left to switch between — the desktop shape is the
 * header glyph instead.
 */
export const showTabBar = (s: ChatChromeState): boolean =>
	s.native && !s.wide && s.mobileView === 'list' && !s.composeOpen;

/** The back chevron only exists while the panes are stacked, i.e. below the breakpoint. */
export const showBackToList = (s: ChatChromeState): boolean => !s.wide && s.mobileView === 'conversation';

/**
 * The native Contacts pane replaces the conversation list when its tab is
 * selected — and the tab bar is the only thing that can select it.
 *
 * So `!wide` here is load-bearing, not tidiness: without it, a window resized
 * while the Contacts tab was active would render a pane whose only exit had just
 * been hidden. That would have swapped one dead end for another. Wide native
 * falls through to the ordinary contact list, which carries its own add/remove
 * controls — the same thing the web has always done.
 */
export const showContactsPane = (s: ChatChromeState): boolean => s.native && !s.wide && s.activeTab === 'contacts';
