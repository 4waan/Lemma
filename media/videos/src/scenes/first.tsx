import React from 'react';
import {C, ease, F, lin, rise, type SceneProps} from '../theme';
import {at, Card, Pill, Stage, Terminal} from './ui';

// Q1. What's changing in software? Agents connect and pay each other.
const NODES = [
	[120, 140],
	[360, 60],
	[560, 220],
	[300, 330],
	[90, 470],
	[460, 520],
	[700, 420],
	[720, 100],
];
const EDGES = [
	[0, 1],
	[1, 2],
	[0, 3],
	[3, 2],
	[3, 4],
	[3, 5],
	[5, 6],
	[2, 6],
	[1, 7],
	[2, 7],
];

export const Q1: React.FC<SceneProps> = ({t, ph}) => {
	const lines = ['Agents write code.', 'Agents can pay.', 'What should they buy?'];
	const paying = at(t, ph, 2);
	return (
		<Stage>
			<svg width={820} height={640} style={{position: 'absolute', left: -20, top: 20, transform: 'scale(0.9)', transformOrigin: 'top left'}}>
				{EDGES.map(([a, b], i) => {
					const [x1, y1] = NODES[a];
					const [x2, y2] = NODES[b];
					const p = ease(t, 4 + i * 3, 24 + i * 3);
					return <line key={i} x1={x1} y1={y1} x2={x1 + (x2 - x1) * p} y2={y1 + (y2 - y1) * p} stroke={C.line} strokeWidth={3} />;
				})}
				{paying > 0
					? EDGES.map(([a, b], i) => {
							const [x1, y1] = NODES[a];
							const [x2, y2] = NODES[b];
							const p = (((t - ph[2]) / 50 + i * 0.37) % 1 + 1) % 1;
							const [sx, sy, ex, ey] = i % 2 ? [x2, y2, x1, y1] : [x1, y1, x2, y2];
							return (
								<g key={`coin-${i}`} opacity={paying * Math.sin(p * Math.PI)}>
									<circle cx={sx + (ex - sx) * p} cy={sy + (ey - sy) * p} r={16} fill={C.mint} />
									<text x={sx + (ex - sx) * p} y={sy + (ey - sy) * p + 7} textAnchor="middle" fontSize={20} fontWeight={700} fill={C.bg} fontFamily="Lexend">
										$
									</text>
								</g>
							);
						})
					: null}
				{NODES.map(([x, y], i) => {
					const p = ease(t, i * 3, i * 3 + 14);
					return (
						<g key={i} opacity={p} transform={`translate(${x} ${y}) scale(${0.6 + 0.4 * p})`}>
							<circle r={40} fill={C.surface2} stroke={C.mint} strokeWidth={3} />
							<rect x={-16} y={-12} width={32} height={24} rx={6} fill="none" stroke={C.text} strokeWidth={3} />
							<circle cx={-6} cy={0} r={3} fill={C.mint} />
							<circle cx={6} cy={0} r={3} fill={C.mint} />
							<line x1={0} y1={-12} x2={0} y2={-20} stroke={C.text} strokeWidth={3} />
						</g>
					);
				})}
			</svg>
			<div style={{position: 'absolute', left: 820, top: 80, display: 'flex', flexDirection: 'column', gap: 30}}>
				{lines.map((line, i) => (
					<div
						key={line}
						style={{
							fontFamily: F.head,
							fontWeight: 500,
							fontSize: i === 2 ? 80 : 70,
							whiteSpace: 'nowrap',
							color: i === 2 ? C.mint : C.text,
							...rise(t, ph[i + 1] ?? 0, 30),
						}}
					>
						{line}
					</div>
				))}
			</div>
			<div style={{position: 'absolute', left: 820, top: 470, ...rise(t, ph[4] ?? 0)}}>
				<Pill color={C.muted}>Aryan Singh Rathore · Co-founder</Pill>
			</div>
		</Stage>
	);
};

// Q2. What's the problem? The same integration, rebuilt everywhere.
const LINES = ['› add x402 payment gating', '  reading docs…', '  writing src/x402.ts', '  writing src/paywall.ts', '  npm test'];

export const Q2: React.FC<SceneProps> = ({t, ph}) => {
	const toFour = ph[1] + 20;
	const toSixteen = ph[1] + 70;
	const count = t < toFour ? 1 : t < toSixteen ? 4 : 16;
	const phaseStart = count === 1 ? 0 : count === 4 ? toFour : toSixteen;
	const fail = at(t, ph, 2, 10);
	const stat = at(t, ph, 3);
	const cols = count === 1 ? 1 : count === 4 ? 2 : 4;
	const w = count === 1 ? 980 : count === 4 ? 820 : 405;
	const h = count === 1 ? 330 : count === 4 ? 290 : 150;
	const scale = count === 1 ? 1.35 : count === 4 ? 1 : 0.62;
	const failing = new Set([2, 5, 11, 14]);
	return (
		<Stage>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'grid',
					gridTemplateColumns: `repeat(${cols}, ${w}px)`,
					gap: count === 16 ? 14 : 24,
					justifyContent: 'center',
					alignContent: 'center',
					opacity: 1 - 0.75 * stat,
					filter: `blur(${stat * 4}px)`,
				}}
			>
				{Array.from({length: count}, (_, i) => {
					const local = t - phaseStart - (count === 16 ? i * 2 : i * 5);
					const failed = count === 16 && failing.has(i) && fail > 0.5;
					return (
						<Terminal
							key={`${count}-${i}`}
							title={`team-${String(i + 1).padStart(2, '0')} · agent`}
							lines={LINES}
							progress={lin(local, 0, 60)}
							tokens={4000 + Math.max(0, t - i * 4) * 380}
							failed={failed}
							scale={scale}
							style={{height: h, ...rise(local, 0, 16, 10)}}
						/>
					);
				})}
			</div>
			{stat > 0 ? (
				<div style={{position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center'}}>
					<Card style={{padding: '48px 80px', textAlign: 'center', opacity: stat, transform: `scale(${0.92 + 0.08 * stat})`}}>
						<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 220, lineHeight: 1, color: C.mint}}>84%</div>
						<div style={{fontSize: 44, marginTop: 20}}>of developers use or plan to use AI tools</div>
						<div style={{fontSize: 24, marginTop: 18, color: C.muted}}>Source: Stack Overflow Developer Survey 2025</div>
					</Card>
				</div>
			) : null}
		</Stage>
	);
};

// Q3. Who feels it first? One user; the same files in every repository.
const FILES = ['src/x402.ts', 'src/paywall.ts', 'test/payments.test.ts'];
const REPOS = ['weather-mcp', 'search-mcp', 'docs-mcp'];

export const Q3: React.FC<SceneProps> = ({t, ph}) => {
	const rows = ['TypeScript MCP server', 'Claude Code or Cursor', 'Needs x402 payments'];
	return (
		<Stage>
			<Card style={{position: 'absolute', left: 40, top: 40, width: 720, ...rise(t, 0, 30)}} glow={at(t, ph, 1)}>
				<div style={{display: 'flex', alignItems: 'center', gap: 24}}>
					<div style={{width: 96, height: 96, borderRadius: 999, background: C.surface2, border: `3px solid ${C.mint}`, display: 'grid', placeItems: 'center'}}>
						<svg width={52} height={52} viewBox="0 0 52 52">
							<circle cx={26} cy={18} r={10} fill="none" stroke={C.text} strokeWidth={4} />
							<path d="M6 48 C8 34 44 34 46 48" fill="none" stroke={C.text} strokeWidth={4} />
						</svg>
					</div>
					<div>
						<div style={{fontSize: 24, color: C.mint, fontFamily: F.head, letterSpacing: 2, textTransform: 'uppercase'}}>First user</div>
						<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 40, lineHeight: 1.2}}>Developers building paid agent tools</div>
					</div>
				</div>
				<div style={{marginTop: 30, display: 'flex', flexDirection: 'column', gap: 16}}>
					{rows.map((row, i) => (
						<div key={row} style={{display: 'flex', alignItems: 'center', gap: 16, fontSize: 34, ...rise(t, ph[1] + i * 10, 16)}}>
							<span style={{color: C.mint}}>✓</span>
							{row}
						</div>
					))}
				</div>
			</Card>
			<div style={{position: 'absolute', left: 860, top: 10, display: 'flex', flexDirection: 'column', gap: 22}}>
				{REPOS.map((repo, r) => (
					<div
						key={repo}
						style={{
							width: 780,
							padding: '18px 26px',
							borderRadius: 18,
							border: `2px solid ${C.line}`,
							background: C.surface,
							opacity: 0.55 + 0.45 * at(t, ph, 1, r * 8),
							...rise(t, ph[1] + r * 8, 20),
						}}
					>
						<div style={{fontFamily: F.mono, fontSize: 24, color: C.muted, marginBottom: 8}}>repo · {repo}</div>
						<div style={{display: 'flex', gap: 14, flexWrap: 'wrap'}}>
							{FILES.map((file, i) => {
								const lit = ease(t, ph[2] + (r * 3 + i) * 4, ph[2] + (r * 3 + i) * 4 + 10);
								const wrong = r === 1 && i === 1 && t > ph[2] + 50;
								return (
									<span
										key={file}
										style={{
											fontFamily: F.mono,
											fontSize: 24,
											padding: '6px 14px',
											borderRadius: 10,
											background: wrong ? `${C.red}33` : lit > 0 ? `${C.mintDeep}${Math.round(40 + lit * 60).toString(16)}` : C.surface2,
											color: wrong ? C.red : lit > 0.5 ? C.text : C.muted,
										}}
									>
										{wrong ? '✗ ' : ''}
										{file}
									</span>
								);
							})}
						</div>
					</div>
				))}
				<div style={{fontFamily: F.head, fontSize: 34, color: C.mint, ...rise(t, ph[2] + 30)}}>Same files. Every time.</div>
			</div>
		</Stage>
	);
};

// Q4. What is Lemma? Four steps.
const STEPS = [
	{label: 'Ask', sub: 'free check, no code sent'},
	{label: 'Buy', sub: 'cents, in USDC'},
	{label: 'Apply & test', sub: 'on your machine'},
	{label: 'Money back', sub: 'if the tests fail'},
];

const StepIcon: React.FC<{i: number; on: number}> = ({i, on}) => {
	const s = on > 0.5 ? C.bg : C.text;
	return (
		<svg width={90} height={90} viewBox="0 0 90 90">
			{i === 0 ? (
				<>
					<path d="M14 18 H76 V58 H40 L24 72 V58 H14 Z" fill="none" stroke={s} strokeWidth={5} strokeLinejoin="round" />
					<text x={45} y={50} textAnchor="middle" fontSize={32} fontWeight={700} fill={s} fontFamily="Lexend">
						?
					</text>
				</>
			) : i === 1 ? (
				<>
					<circle cx={45} cy={45} r={28} fill="none" stroke={s} strokeWidth={5} />
					<text x={45} y={57} textAnchor="middle" fontSize={34} fontWeight={700} fill={s} fontFamily="Lexend">
						$
					</text>
				</>
			) : i === 2 ? (
				<>
					<rect x={16} y={16} width={58} height={58} rx={12} fill="none" stroke={s} strokeWidth={5} />
					<path d="M30 46 L41 57 L61 34" fill="none" stroke={s} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" />
				</>
			) : (
				<>
					<path d="M68 45 A23 23 0 1 1 58 26" fill="none" stroke={s} strokeWidth={5} strokeLinecap="round" />
					<path d="M50 16 L62 26 L50 36" fill="none" stroke={s} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
					<text x={45} y={56} textAnchor="middle" fontSize={26} fontWeight={700} fill={s} fontFamily="Lexend">
						$
					</text>
				</>
			)}
		</svg>
	);
};

export const Q4: React.FC<SceneProps> = ({t, ph}) => (
	<Stage>
		<div style={{position: 'absolute', left: 0, top: 0, ...rise(t, ph[0])}}>
			<Pill color={C.muted}>Awaan Mustafa Siddiqui · Co-founder</Pill>
		</div>
		<div style={{position: 'absolute', left: 0, right: 0, top: 90, textAlign: 'center', fontFamily: F.head, fontWeight: 500, fontSize: 66, ...rise(t, ph[1])}}>
			Solved work, <span style={{color: C.mint}}>ready for an agent to buy</span>
		</div>
		<div style={{position: 'absolute', left: 0, right: 0, top: 290, display: 'flex', justifyContent: 'center', alignItems: 'center'}}>
			{STEPS.map((step, i) => {
				const on = at(t, ph, i + 2);
				const shown = at(t, ph, 1, 10 + i * 4);
				return (
					<React.Fragment key={step.label}>
						{i > 0 ? (
							<div style={{width: 90, height: 6, borderRadius: 3, background: C.line, overflow: 'hidden', opacity: shown}}>
								<div style={{width: `${on * 100}%`, height: '100%', background: C.mint}} />
							</div>
						) : null}
						<div style={{width: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0.35 + 0.65 * Math.max(on, shown * 0.4), ...rise(t, ph[1] + 10 + i * 4)}}>
							<div
								style={{
									width: 170,
									height: 170,
									borderRadius: 40,
									display: 'grid',
									placeItems: 'center',
									background: on > 0.5 ? C.mint : C.surface,
									border: `3px solid ${on > 0 ? C.mint : C.line}`,
									boxShadow: on > 0.5 ? `0 0 70px ${C.mint}66` : 'none',
									transform: `scale(${1 + 0.08 * Math.sin(on * Math.PI)})`,
								}}
							>
								<StepIcon i={i} on={on} />
							</div>
							<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 40, marginTop: 24}}>{step.label}</div>
							<div style={{fontSize: 26, color: C.muted, marginTop: 6}}>{step.sub}</div>
						</div>
					</React.Fragment>
				);
			})}
		</div>
	</Stage>
);

// Q5. Why now, and why Arbitrum? Three tiles.
export const Q5: React.FC<SceneProps> = ({t, ph}) => {
	const tiles = [
		{
			head: 'MCP',
			sub: 'Agents plug into tools in every major editor',
			body: (
				<div style={{display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 24}}>
					{['Cursor', 'VS Code', 'Claude Code', 'Codex', 'Goose'].map((e, i) => (
						<span key={e} style={{fontSize: 24, padding: '6px 14px', borderRadius: 10, background: C.surface2, ...rise(t, ph[0] + 12 + i * 5, 10)}}>
							{e}
						</span>
					))}
				</div>
			),
		},
		{
			head: 'x402 + USDC',
			sub: 'Agents pay per request, in dollars',
			body: (
				<div style={{fontFamily: F.mono, fontSize: 26, marginTop: 24, lineHeight: 1.7}}>
					<div style={{color: C.amber, ...rise(t, ph[1] + 8, 10)}}>402 Payment Required</div>
					<div style={{color: C.muted, ...rise(t, ph[1] + 16, 10)}}>→ pay 0.25 USDC</div>
					<div style={{color: C.mint, ...rise(t, ph[1] + 24, 10)}}>200 OK</div>
				</div>
			),
		},
		{
			head: 'Arbitrum',
			sub: 'Cheap enough to settle every purchase on chain',
			body: (
				<div style={{display: 'flex', flexDirection: 'column', gap: 12, marginTop: 24}}>
					{['Settle the purchase', 'Hold the bond', 'Pay the refund'].map((e, i) => {
						const lit = i === 0 ? at(t, ph, 2, 8) : at(t, ph, 3, (i - 1) * 8);
						return (
							<span key={e} style={{fontSize: 28, display: 'flex', gap: 12, alignItems: 'center', opacity: 0.3 + 0.7 * lit}}>
								<span style={{width: 14, height: 14, borderRadius: 99, background: lit > 0.5 ? C.mint : C.line}} />
								{e}
							</span>
						);
					})}
				</div>
			),
		},
	];
	return (
		<Stage style={{display: 'flex', gap: 36, justifyContent: 'center', alignItems: 'flex-start', paddingTop: 50}}>
			{tiles.map((tile, i) => {
				const p = at(t, ph, i);
				return (
					<Card key={tile.head} glow={i === 2 ? at(t, ph, 3) : 0} style={{width: 500, minHeight: 470, ...rise(t, ph[i], 40, 16), opacity: p}}>
						<div style={{fontSize: 24, color: C.mint, fontFamily: F.head, letterSpacing: 3, textTransform: 'uppercase'}}>{['Why now', 'Why now', 'Why Arbitrum'][i]}</div>
						<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 62, marginTop: 10}}>{tile.head}</div>
						<div style={{fontSize: 30, color: C.muted, marginTop: 10, lineHeight: 1.3}}>{tile.sub}</div>
						{tile.body}
					</Card>
				);
			})}
		</Stage>
	);
};

