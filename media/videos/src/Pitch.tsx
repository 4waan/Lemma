import React from 'react';
import {AbsoluteFill, Img, staticFile, useCurrentFrame} from 'remotion';
import timeline from './timeline-pitch.json';
import {C, ease, F, rise} from './theme';
import {SCENES} from './scenes';
import {makeVideo, type Timeline} from './Video';

const Intro: React.FC = () => {
	const f = useCurrentFrame();
	const mark = ease(f, 4, 28);
	const out = 1 - ease(f, timeline.introEnd - 12, timeline.introEnd);
	return (
		<AbsoluteFill style={{justifyContent: 'center', alignItems: 'center', opacity: out}}>
			<div style={{display: 'flex', alignItems: 'center', gap: 40}}>
				<Img src={staticFile('brand/lemma-mark-dark.svg')} style={{width: 200, opacity: mark, transform: `scale(${0.8 + 0.2 * mark}) rotate(${(1 - mark) * -8}deg)`}} />
				<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 190, letterSpacing: -4, ...rise(f, 14, 30)}}>Lemma</div>
			</div>
			<div style={{fontFamily: F.head, fontSize: 52, color: C.muted, marginTop: 30, ...rise(f, 34)}}>
				in <span style={{color: C.mint}}>ten questions</span>
			</div>
			<div
				style={{
					marginTop: 54,
					padding: '10px 26px',
					borderRadius: 999,
					border: `1px solid ${C.line}`,
					fontSize: 28,
					color: C.muted,
					...rise(f, 52),
				}}
			>
				Built on <span style={{color: C.text}}>Arbitrum</span> · x402 · USDC · Stylus
			</div>
		</AbsoluteFill>
	);
};

export const Outro: React.FC = () => {
	const f = useCurrentFrame();
	return (
		<AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
			<Img src={staticFile('brand/lemma-logo-dark.png')} style={{width: 640, ...rise(f, 0, 20, 20)}} />
			<div style={{fontFamily: F.head, fontSize: 46, marginTop: 40, ...rise(f, 12)}}>Agents stop paying to rediscover solved work.</div>
			<div style={{display: 'flex', gap: 28, marginTop: 50, fontFamily: F.mono, fontSize: 30, color: C.mint, ...rise(f, 24)}}>
				<span>lemma-production-8383.up.railway.app</span>
				<span style={{color: C.faint}}>·</span>
				<span>github.com/4waan/Lemma</span>
			</div>
			<div style={{marginTop: 36, fontSize: 26, color: C.muted, ...rise(f, 34)}}>Aryan Singh Rathore · Awaan Mustafa Siddiqui</div>
		</AbsoluteFill>
	);
};

export const Pitch = makeVideo({name: 'pitch', timeline: timeline as Timeline, scenes: SCENES, Intro, Outro});
