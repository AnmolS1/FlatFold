// Audit §3: dialogs and sheets must trap focus while open, restore focus to
// whatever opened them on close, close on Escape, and carry dialog semantics.
//
// BottomSheet already did most of this (SafetyNumberDialog and
// MessageActionSheet compose it, so they inherit it), but it never restored
// focus to the trigger — a keyboard user who closes a sheet gets dumped back at
// the top of the document. SettingsDialog and SearchDialog roll their own
// overlays and had none of it.
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { BottomSheet } from '../src/components/common/BottomSheet';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { AuthContext } from '../src/hooks/useAuth';
import type { AuthContextType } from '../src/types';

// SettingsDialog now reads changePassword from auth context — a minimal stub is
// enough for the accessibility harness (it never submits the form).
const stubAuth: AuthContextType = {
	username: 'alice',
	loading: false,
	keystoreLocked: false,
	signup: vi.fn(),
	login: vi.fn(),
	logout: vi.fn(),
	unlockKeystore: vi.fn(),
	changePassword: vi.fn(),
};

vi.mock('../src/lib/api', () => ({
	apiMe: vi.fn().mockResolvedValue(null),
	apiLogoutAll: vi.fn(),
	apiDeleteAccount: vi.fn(),
}));
vi.mock('../src/lib/panicWipe', () => ({ panicWipe: vi.fn(), requestPanicWipe: vi.fn() }));

/** A trigger button plus the dialog it opens — the real open/close cycle. */
function Harness({ render: renderDialog }: { render: (close: () => void) => React.ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button onClick={() => setOpen(true)}>Open it</button>
			{open && renderDialog(() => setOpen(false))}
		</>
	);
}

describe.each([
	{
		name: 'BottomSheet',
		render: (close: () => void) => (
			<BottomSheet onClose={close} labelledBy="sheet-title">
				<h2 id="sheet-title">Sheet title</h2>
				<button>First</button>
				<button>Last</button>
			</BottomSheet>
		),
	},
	{
		name: 'SettingsDialog',
		render: (close: () => void) => (
			<AuthContext.Provider value={stubAuth}>
				<SettingsDialog username="alice" onClose={close} onSignOut={vi.fn()} />
			</AuthContext.Provider>
		),
	},
])('$name accessibility', ({ render: renderDialog }) => {
	it('exposes dialog semantics with an accessible name', async () => {
		const user = userEvent.setup();
		render(<Harness render={renderDialog} />);
		await user.click(screen.getByText('Open it'));

		const dialog = await screen.findByRole('dialog');
		expect(dialog.getAttribute('aria-modal')).toBe('true');
		// Labelled by something, so a screen reader announces what opened.
		expect(dialog.getAttribute('aria-labelledby') || dialog.getAttribute('aria-label')).toBeTruthy();
	});

	it('closes on Escape', async () => {
		const user = userEvent.setup();
		render(<Harness render={renderDialog} />);
		await user.click(screen.getByText('Open it'));
		await screen.findByRole('dialog');

		await user.keyboard('{Escape}');

		await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
	});

	it('moves focus into the dialog on open', async () => {
		const user = userEvent.setup();
		render(<Harness render={renderDialog} />);
		const trigger = screen.getByText('Open it');
		await user.click(trigger);

		const dialog = await screen.findByRole('dialog');
		await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
	});

	it('traps Tab inside the dialog', async () => {
		const user = userEvent.setup();
		render(<Harness render={renderDialog} />);
		await user.click(screen.getByText('Open it'));
		const dialog = await screen.findByRole('dialog');

		// Tab all the way around; focus must never escape to the trigger behind.
		for (let i = 0; i < 12; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
	});

	it('restores focus to the trigger on close', async () => {
		// Without this a keyboard or screen-reader user is dropped at the top of
		// the document every time they dismiss a dialog.
		const user = userEvent.setup();
		render(<Harness render={renderDialog} />);
		const trigger = screen.getByText('Open it');
		await user.click(trigger);
		await screen.findByRole('dialog');

		await user.keyboard('{Escape}');

		await waitFor(() => expect(document.activeElement).toBe(trigger));
	});
});
