import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import timeline from './timeline-demo.json';
import {C, ease, F, rise} from './theme';
import {DEMO_SCENES} from './demo/scenes';
import {Outro} from './Pitch';
import {makeVideo, type Segment, type Timeline} from './Video';

const tl = timeline as Timeline;
const seg = (id: string) => tl.segments.find((s) => s.id === id) as Segment;

const Intro: React.FC = () => {
	const f = useCurrentFrame();
	const out = 1 - ease(f, tl.introEnd - 12, tl.introEnd);
	return (
		<AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: out}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 36}}>
				<Img src={staticFile('brand/lemma-mark-dark.svg')} style={{width: 170, ...rise(f, 2, 20, 20)}} />
				<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 160, letterSpacing: -4, ...rise(f, 10, 30)}}>Lemma</div>
			</div>
			<div style={{fontFamily: F.head, fontSize: 52, color: C.muted, marginTop: 20, ...rise(f, 26)}}>
				the <span style={{color: C.mint}}>demo</span>, in sixteen questions
			</div>
			<div style={{display: 'flex', gap: 20, marginTop: 50, ...rise(f, 44)}}>
				<span style={{padding: '10px 24px', borderRadius: 999, border: `2px solid ${C.mint}`, color: C.mint, fontSize: 26, fontFamily: F.head}}>
					Real purchases on Arbitrum Sepolia · 1 Oct 2026
				</span>
				<span style={{padding: '10px 24px', borderRadius: 999, border: `2px solid ${C.line}`, color: C.muted, fontSize: 26, fontFamily: F.head}}>
					Captured live · 4 Oct 2026
				</span>
			</div>
		</AbsoluteFill>
	);
};

/**
 * The balances the 1 October run moved, from the deployment record (and
 * matching the chain on 2026-10-04): the buyer started with 1 USDC, the
 * provider's bond was 1 USDC, and each purchase cost 0.25.
 */
const StateTracker: React.FC = () => {
	const f = useCurrentFrame();
	const d8 = seg('d8');
	const d10 = seg('d10');
	const d11 = seg('d11');
	const card = tl.segments.find((s) => f >= s.questionStart - 6 && f < s.answerStart + 4);
	const hide = card ? Math.min(1, Math.min(f - (card.questionStart - 6), card.answerStart + 4 - f) / 6) : 0;
	const show = ease(f, d8.answerStart, d8.answerStart + 15) * (1 - ease(f, d11.end - 10, d11.end + 5)) * (1 - hide);
	if (show <= 0) return null;
	const pay1 = d8.phrases[1].start + 10;
	const pay2 = d10.phrases[0].start + 40;
	const refund = d10.phrases[2].start + 30;
	const rows: {label: string; steps: [number, number][]}[] = [
		{label: 'Buyer', steps: [[0, 1], [pay1, 0.75], [pay2, 0.5]]},
		{label: 'Registry (bond)', steps: [[0, 1], [refund, 0.75]]},
		{label: 'Refund address', steps: [[0, 0], [refund, 0.25]]},
	];
	return (
		<div
			style={{
				position: 'absolute',
				left: 1475,
				top: 140,
				width: 365,
				padding: '22px 24px',
				borderRadius: 18,
				background: C.surface,
				border: `2px solid ${C.line}`,
				opacity: show,
				transform: `translateX(${(1 - show) * 30}px)`,
			}}
		>
			<div style={{fontFamily: F.head, fontSize: 22, color: C.mint, letterSpacing: 2, textTransform: 'uppercase'}}>Testnet USDC</div>
			<div style={{fontSize: 20, color: C.muted, marginTop: 4}}>Arbitrum Sepolia, 1 Oct 2026</div>
			{rows.map((row) => {
				let value = row.steps[0][1];
				let changedAt = -1;
				let delta = 0;
				for (const [at, v] of row.steps) {
					if (f >= at && at > 0) {
						delta = v - value;
						value = v;
						changedAt = at;
					}
				}
				const flash = changedAt < 0 ? 0 : Math.max(0, 1 - (f - changedAt) / 45);
				const up = delta > 0;
				return (
					<div key={row.label} style={{marginTop: 22, padding: '12px 14px', borderRadius: 12, background: flash > 0 ? `${up ? C.mintDeep : '#7a2e2e'}${Math.round(flash * 120).toString(16).padStart(2, '0')}` : 'transparent'}}>
						<div style={{fontSize: 22, color: C.muted}}>{row.label}</div>
						<div style={{display: 'flex', alignItems: 'baseline', gap: 14}}>
							<span style={{fontFamily: F.mono, fontSize: 44, color: C.text}}>{value.toFixed(2)}</span>
							{flash > 0 ? (
								<span style={{fontFamily: F.mono, fontSize: 28, color: up ? C.mint : C.red, opacity: flash}}>
									{up ? '+' : '−'}
									{Math.abs(delta).toFixed(2)}
								</span>
							) : null}
						</div>
					</div>
				);
			})}
			<div style={{marginTop: 18, fontSize: 18, color: C.faint, lineHeight: 1.35}}>A demo release with made-up benchmark numbers; the payments and refund are real.</div>
		</div>
	);
};

export const Demo = makeVideo({name: 'demo', timeline: tl, scenes: DEMO_SCENES, Intro, Outro, Overlay: StateTracker});
