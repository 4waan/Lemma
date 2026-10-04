import React from 'react';
import {AbsoluteFill, Audio, Img, Sequence, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import timeline from './timeline.json';
import {C, ease, F, lin, rise, useFonts} from './theme';
import {SCENES} from './scenes';

type Segment = (typeof timeline.segments)[number];

export type PitchProps = {
	/** Show the teleprompter and timecode instead of captions, for recording the voice-over. */
	guide: boolean;
	/** Voice files in public/voice, by segment id (for example { "q1": "q1.m4a" }). */
	voices: Record<string, string>;
};

const QUESTION_EXIT = 10;

export const Pitch: React.FC<PitchProps> = ({guide, voices}) => {
	useFonts();
	const frame = useCurrentFrame();
	const hasVoices = Object.keys(voices).length > 0;
	const current = timeline.segments.find((s) => frame >= s.questionStart && frame < s.end) ?? null;

	return (
		<AbsoluteFill style={{background: C.bg, fontFamily: F.body, color: C.text}}>
			<Backdrop />
			<Sequence durationInFrames={timeline.introEnd} name="Intro">
				<Intro />
			</Sequence>
			{timeline.segments.map((s) => (
				<Sequence key={s.id} from={s.questionStart} durationInFrames={s.end - s.questionStart} name={`${s.id}: ${s.question}`}>
					<SegmentView segment={s} />
				</Sequence>
			))}
			<Sequence from={timeline.outroStart} name="Outro">
				<Outro />
			</Sequence>
			<Progress segment={current} />
			{guide ? <Teleprompter segment={current} /> : <Captions segment={current} />}
			<Audio src={staticFile('music.wav')} volume={hasVoices ? 0.55 : 1} />
			{timeline.segments.map((s) =>
				voices[s.id] ? (
					<Sequence key={`voice-${s.id}`} from={s.answerStart} name={`voice ${s.id}`}>
						<Audio src={staticFile(`voice/${voices[s.id]}`)} />
					</Sequence>
				) : null,
			)}
		</AbsoluteFill>
	);
};

const Backdrop: React.FC = () => {
	const frame = useCurrentFrame();
	const drift = Math.sin(frame / 240) * 60;
	return (
		<AbsoluteFill>
			<AbsoluteFill
				style={{
					backgroundImage: `linear-gradient(${C.line}33 1px, transparent 1px), linear-gradient(90deg, ${C.line}33 1px, transparent 1px)`,
					backgroundSize: '64px 64px',
					maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 80%)',
				}}
			/>
			<div
				style={{
					position: 'absolute',
					width: 1400,
					height: 1400,
					left: 260 + drift,
					top: -520,
					borderRadius: '50%',
					background: `radial-gradient(circle, ${C.mintDeep}2e 0%, transparent 60%)`,
				}}
			/>
		</AbsoluteFill>
	);
};

const SegmentView: React.FC<{segment: Segment}> = ({segment}) => {
	const f = useCurrentFrame();
	const qLen = segment.answerStart - segment.questionStart;
	const dur = segment.end - segment.answerStart;
	const t = f - qLen;
	const Scene = SCENES[segment.id];
	const ph = segment.phrases.map((p) => p.start - segment.answerStart);
	const out = 1 - lin(f, segment.end - segment.questionStart - 8, segment.end - segment.questionStart);

	// The question card: in over 10 frames, holds, then shrinks away as the chip slides in.
	const cardIn = ease(f, 0, 10);
	const cardOut = ease(f, qLen - QUESTION_EXIT, qLen + 2);
	const chipIn = ease(f, qLen - 4, qLen + 10);

	return (
		<AbsoluteFill style={{opacity: out}}>
			{t >= -4 ? (
				<AbsoluteFill style={{opacity: ease(t, -4, 10)}}>
					<Scene t={Math.max(0, t)} dur={dur} ph={ph} />
				</AbsoluteFill>
			) : null}
			{cardOut < 1 ? (
				<AbsoluteFill
					style={{
						justifyContent: 'center',
						alignItems: 'center',
						opacity: cardIn * (1 - cardOut),
						transform: `scale(${0.94 + 0.06 * cardIn - 0.25 * cardOut}) translateY(${-140 * cardOut}px)`,
					}}
				>
					<div style={{fontFamily: F.head, fontSize: 34, letterSpacing: 6, color: C.mint, textTransform: 'uppercase', marginBottom: 28}}>
						Question {segment.index + 1} of 10
					</div>
					<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 104, lineHeight: 1.1, textAlign: 'center', maxWidth: 1500}}>
						{segment.question}
					</div>
				</AbsoluteFill>
			) : null}
			<div
				style={{
					position: 'absolute',
					left: 72,
					top: 56,
					display: 'flex',
					alignItems: 'center',
					gap: 16,
					padding: '12px 26px 12px 14px',
					borderRadius: 999,
					border: `2px solid ${C.mint}`,
					background: `${C.surface}e6`,
					opacity: chipIn,
					transform: `translateX(${(1 - chipIn) * -40}px)`,
				}}
			>
				<span
					style={{
						fontFamily: F.head,
						fontWeight: 600,
						fontSize: 24,
						color: C.bg,
						background: C.mint,
						borderRadius: 999,
						padding: '4px 14px',
					}}
				>
					Q{segment.index + 1}
				</span>
				<span style={{fontFamily: F.head, fontWeight: 500, fontSize: 30}}>{segment.question}</span>
			</div>
		</AbsoluteFill>
	);
};

const Progress: React.FC<{segment: Segment | null}> = ({segment}) => {
	const frame = useCurrentFrame();
	const show = ease(frame, timeline.introEnd - 10, timeline.introEnd + 10) * (1 - ease(frame, timeline.outroStart, timeline.outroStart + 15));
	return (
		<div style={{position: 'absolute', right: 72, top: 74, display: 'flex', gap: 12, opacity: show}}>
			{timeline.segments.map((s) => {
				const done = frame >= s.end;
				const active = segment?.id === s.id;
				return (
					<div
						key={s.id}
						style={{
							width: active ? 40 : 14,
							height: 14,
							borderRadius: 999,
							background: active || done ? C.mint : C.line,
							opacity: done && !active ? 0.55 : 1,
						}}
					/>
				);
			})}
		</div>
	);
};

const Captions: React.FC<{segment: Segment | null}> = ({segment}) => {
	const frame = useCurrentFrame();
	if (!segment) return null;
	const phrase = segment.phrases.find((p) => frame >= p.start && frame < p.end + 18 && frame < segment.end - 4);
	if (!phrase) return null;
	const p = ease(frame, phrase.start, phrase.start + 8);
	return (
		<div style={{position: 'absolute', left: 0, right: 0, bottom: 64, display: 'flex', justifyContent: 'center'}}>
			<div
				style={{
					maxWidth: 1500,
					padding: '16px 34px',
					borderRadius: 18,
					background: `${C.bg}d9`,
					border: `1px solid ${C.line}`,
					textAlign: 'center',
					opacity: p,
					transform: `translateY(${(1 - p) * 10}px)`,
				}}
			>
				<span style={{fontFamily: F.head, fontWeight: 600, fontSize: 26, color: C.mint, marginRight: 16}}>{segment.speaker}</span>
				<span style={{fontSize: 40, lineHeight: 1.3}}>{phrase.text}</span>
			</div>
		</div>
	);
};

const Teleprompter: React.FC<{segment: Segment | null}> = ({segment}) => {
	const frame = useCurrentFrame();
	const {fps} = useVideoConfig();
	const clock = `${Math.floor(frame / fps / 60)}:${String(Math.floor((frame / fps) % 60)).padStart(2, '0')}.${Math.floor(((frame % fps) / fps) * 10)}`;
	const next = timeline.segments.find((s) => s.questionStart > frame);
	const waiting = !segment || frame < segment.answerStart;
	const target = segment ?? next ?? null;
	const countdown = target ? Math.max(0, (target.answerStart - frame) / fps) : 0;

	return (
		<>
			<div style={{position: 'absolute', right: 72, top: 112, fontFamily: F.mono, fontSize: 30, color: C.amber}}>{clock}</div>
			<div
				style={{
					position: 'absolute',
					left: 60,
					right: 60,
					bottom: 30,
					padding: '22px 34px',
					borderRadius: 20,
					background: '#000000d0',
					border: `2px solid ${waiting ? C.amber : C.red}`,
				}}
			>
				{target ? (
					<>
						<div style={{display: 'flex', alignItems: 'center', gap: 16, fontFamily: F.head, fontSize: 30, marginBottom: 10}}>
							<span style={{width: 18, height: 18, borderRadius: 999, background: waiting ? C.amber : C.red}} />
							{waiting ? (
								<span style={{color: C.amber}}>
									{target.speaker}: get ready, speak in {countdown.toFixed(1)} s
								</span>
							) : (
								<span style={{color: C.red}}>{target.speaker}: speak now</span>
							)}
						</div>
						<div style={{fontSize: 34, lineHeight: 1.35}}>
							{target.phrases.map((p, i) => {
								const now = frame >= p.start && frame < p.end;
								const said = frame >= p.end;
								return (
									<span key={i} style={{color: now ? C.text : said ? C.faint : C.muted, background: now ? `${C.mintDeep}55` : 'transparent', borderRadius: 6}}>
										{p.text}{' '}
									</span>
								);
							})}
						</div>
					</>
				) : (
					<div style={{fontFamily: F.head, fontSize: 30, color: C.muted}}>Music only. Stay silent.</div>
				)}
			</div>
		</>
	);
};

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

const Outro: React.FC = () => {
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
