// App Review 1.2. The review notes assert: "messages from anyone not already a
// contact are held as a request with no content shown until the recipient
// approves them, so unsolicited content is never displayed."
//
// This pins the "no content shown" half, which is the part that can regress
// invisibly — a well-meaning change adding a message preview "for context" would
// leave every other test passing while removing the entire property the
// mechanism exists to provide.
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageRequests } from '../src/components/chat/MessageRequests';

describe('message requests show who, never what', () => {
	it('renders the sender but no part of their message', () => {
		render(
			<MessageRequests
				senders={['stranger']}
				groups={[]}
				onAccept={vi.fn()}
				onDecline={vi.fn()}
				onAcceptGroup={vi.fn()}
				onDeclineGroup={vi.fn()}
			/>
		);
		expect(screen.getByText('stranger')).toBeTruthy();
		expect(screen.getByText('wants to message you')).toBeTruthy();
		// There is no prop through which message text could reach this component.
		expect(screen.queryByText(/wants to message you\s*\S/)).toBeNull();
	});

	it('names the inviter for a group, never the sender-supplied group name', () => {
		render(
			<MessageRequests
				senders={[]}
				groups={[{ groupId: 'g1', creator: 'stranger' }]}
				onAccept={vi.fn()}
				onDecline={vi.fn()}
				onAcceptGroup={vi.fn()}
				onDeclineGroup={vi.fn()}
			/>
		);
		// A group NAME is attacker-controlled free text — rendering it would be a
		// message channel to someone who has not agreed to receive anything.
		expect(screen.getByText('stranger')).toBeTruthy();
		expect(screen.getByText('added you to a group')).toBeTruthy();
	});

	it('renders nothing at all when there are no requests', () => {
		const { container } = render(
			<MessageRequests
				senders={[]}
				groups={[]}
				onAccept={vi.fn()}
				onDecline={vi.fn()}
				onAcceptGroup={vi.fn()}
				onDeclineGroup={vi.fn()}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('offers both a decision and its opposite for each request', async () => {
		const onAccept = vi.fn();
		const onDecline = vi.fn();
		render(
			<MessageRequests
				senders={['stranger']}
				groups={[]}
				onAccept={onAccept}
				onDecline={onDecline}
				onAcceptGroup={vi.fn()}
				onDeclineGroup={vi.fn()}
			/>
		);
		await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
		expect(onAccept).toHaveBeenCalledWith('stranger');
		await userEvent.click(screen.getByRole('button', { name: 'Decline' }));
		expect(onDecline).toHaveBeenCalledWith('stranger');
	});
});
