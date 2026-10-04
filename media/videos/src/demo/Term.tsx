import React from 'react';
import {C, ease, F} from '../theme';

/** One terminal line: a command (typed out) or output (appears at once). */
export type Line = {text: string; at: number; kind?: 'cmd' | 'out' | 'ok' | 'warn' | 'muted' | 'title'; mark?: [number, number]};

/**
 * Replays captured terminal output: each command types out from its `at`
 * frame, each output line appears at its `at`, and `mark` gives a line a
 * mint background between two frames.
 */
export const Term: React.FC<{
	title: string;
	lines: Line[];
	t: number;
	x: number;
	y: number;
	width: number;
	height: number;
	fontSize?: number;
	note?: string;
	opacity?: number;
}> = ({title, lines, t, x, y, width, height, fontSize = 24, note, opacity = 1}) => {
	const shown = lines.filter((l) => t >= l.at);
	const lineHeight = fontSize * 1.5;
	const visible = Math.floor((height - 60) / lineHeight);
	const start = Math.max(0, shown.length - visible);
	const last = shown[shown.length - 1];
	return (
		<div
			style={{
				position: 'absolute',
				left: x,
				top: y,
				width,
				height,
				borderRadius: 18,
				overflow: 'hidden',
				background: '#070C0E',
				border: `2px solid ${C.line}`,
				boxShadow: '0 30px 80px #000a',
				opacity,
			}}
		>
			<div style={{height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px', background: C.surface2, fontFamily: F.mono, fontSize: 18, color: C.muted}}>
				{['#FF5F57', '#FEBC2E', '#28C840'].map((c) => (
					<span key={c} style={{width: 12, height: 12, borderRadius: 99, background: c, opacity: 0.85}} />
				))}
				<span style={{marginLeft: 12}}>{title}</span>
				{note ? <span style={{marginLeft: 'auto', color: C.amber}}>{note}</span> : null}
			</div>
			<div style={{padding: '12px 22px', fontFamily: F.mono, fontSize, lineHeight: `${lineHeight}px`}}>
				{shown.slice(start).map((l, i) => {
					const typed = l.kind === 'cmd' ? Math.min(l.text.length, Math.floor((t - l.at) * 1.6)) : l.text.length;
					const marked = l.mark ? ease(t, l.mark[0], l.mark[0] + 8) * (1 - ease(t, l.mark[1], l.mark[1] + 8)) : 0;
					const color =
						l.kind === 'cmd' ? C.text : l.kind === 'ok' ? C.mint : l.kind === 'warn' ? C.amber : l.kind === 'muted' ? C.faint : l.kind === 'title' ? C.text : C.muted;
					return (
						<div
							key={start + i}
							style={{
								color,
								whiteSpace: 'pre',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								background: marked > 0 ? `rgba(23, 144, 107, ${0.45 * marked})` : 'transparent',
								borderRadius: 6,
								fontWeight: l.kind === 'title' ? 700 : 400,
							}}
						>
							{l.kind === 'cmd' ? <span style={{color: C.mint}}>$ </span> : null}
							{l.text.slice(0, typed)}
							{l === last && l.kind === 'cmd' && typed < l.text.length ? <span style={{background: C.text, color: C.bg}}> </span> : null}
						</div>
					);
				})}
			</div>
		</div>
	);
};

/** Lines that start `gap` frames apart from `from`. */
export const stagger = (texts: string[], from: number, gap: number, kind: Line['kind'] = 'out'): Line[] => texts.map((text, i) => ({text, at: from + i * gap, kind}));
