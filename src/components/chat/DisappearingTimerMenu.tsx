import { memo } from 'react';
import { Timer } from 'lucide-react';

interface DisappearingTimerMenuProps {
	seconds: number;
	onChange: (seconds: number) => void;
}

// off / 1h / 1d / 1w, per the spec. Off is 0. The timer icon is the label, so
// the collapsed control reads compactly as just the value (e.g. "Off", "1 hour")
// instead of "Disappearing: off" crowding the chat header.
const OPTIONS: { label: string; seconds: number }[] = [
	{ label: 'Off', seconds: 0 },
	{ label: '1 hour', seconds: 60 * 60 },
	{ label: '1 day', seconds: 24 * 60 * 60 },
	{ label: '1 week', seconds: 7 * 24 * 60 * 60 },
];

const DisappearingTimerMenuComponent = ({ seconds, onChange }: DisappearingTimerMenuProps) => {
	return (
		<label
			className={`text-xs flex items-center gap-1 px-2 py-1 border rounded transition-colors cursor-pointer ${
				seconds > 0 ? 'border-sax text-sax' : 'border-crease-line-bold text-graphite hover:border-crease'
			}`}
			title="Disappearing messages"
		>
			<Timer className="w-3.5 h-3.5" />
			<span className="sr-only">Disappearing messages timer</span>
			<select
				value={seconds}
				onChange={(e) => onChange(Number(e.target.value))}
				className="bg-transparent text-inherit outline-none cursor-pointer"
			>
				{OPTIONS.map((o) => (
					<option key={o.seconds} value={o.seconds} className="text-graphite bg-inset">
						{o.label}
					</option>
				))}
			</select>
		</label>
	);
};

export const DisappearingTimerMenu = memo(DisappearingTimerMenuComponent);
