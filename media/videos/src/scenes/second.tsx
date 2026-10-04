import React from 'react';
import {C, ease, F, rise, type SceneProps} from '../theme';
import {Arrow, at, Card, Pill, Stage} from './ui';

// Q6. How does it make money? Provider, Lemma, agent, bond and refund.
const Party: React.FC<{x: number; y: number; title: string; sub: string; p: number; badge?: React.ReactNode}> = ({x, y, title, sub, p, badge}) => (
	<div style={{position: 'absolute', left: x - 170, top: y - 70, width: 340, opacity: p, transform: `scale(${0.9 + 0.1 * p})`}}>
		<Card style={{padding: '22px 26px', textAlign: 'center'}}>
			<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 40}}>{title}</div>
			<div style={{fontSize: 24, color: C.muted, marginTop: 4}}>{sub}</div>
		</Card>
		{badge}
	</div>
);

const Label: React.FC<{x: number; y: number; p: number; children: React.ReactNode; color?: string}> = ({x, y, p, children, color = C.mint}) => (
	<div
		style={{
			position: 'absolute',
			left: x,
			top: y,
			transform: 'translateX(-50%)',
			opacity: p,
			fontFamily: F.head,
			fontSize: 26,
			color,
			whiteSpace: 'nowrap',
			padding: '2px 10px',
			borderRadius: 8,
			background: C.bg,
		}}
	>
		{children}
	</div>
);

export const Q6: React.FC<SceneProps> = ({t, ph}) => {
	const provider = at(t, ph, 0);
	const bond = at(t, ph, 0, 18, 24);
	const agent = at(t, ph, 1);
	const pay = at(t, ph, 1, 10, 24);
	const cap = at(t, ph, 1, 30);
	const earn = at(t, ph, 2, 0, 24);
	const fee = at(t, ph, 3);
	const refund = at(t, ph, 4, 0, 30);
	// Stage coordinates: provider left, Lemma centre, agent right, vault below centre.
	const P = {x: 200, y: 130};
	const L = {x: 840, y: 130};
	const A = {x: 1480, y: 130};
	const V = {x: 840, y: 420};
	return (
		<Stage>
			<svg width={1680} height={720} style={{position: 'absolute', left: 0, top: 0, overflow: 'visible'}}>
				<Arrow x1={A.x - 180} y1={A.y} x2={L.x + 180} y2={L.y} progress={pay} t={t} />
				<Arrow x1={L.x - 180} y1={L.y} x2={P.x + 180} y2={P.y} progress={earn} t={t} />
				<Arrow x1={P.x + 40} y1={P.y + 80} x2={V.x - 150} y2={V.y - 10} progress={bond} t={t} color={C.mintMid} />
				<Arrow x1={V.x + 150} y1={V.y - 10} x2={A.x - 40} y2={A.y + 80} progress={refund} t={t} color={C.amber} />
			</svg>
			<Party x={P.x} y={P.y} title="Provider" sub="solved the integration" p={provider} />
			<Party
				x={L.x}
				y={L.y}
				title="Lemma"
				sub="matches, sells, verifies"
				p={Math.max(provider, agent)}
				badge={
					<div style={{display: 'flex', justifyContent: 'center', marginTop: 14, opacity: fee}}>
						<Pill>10% fee · after validation</Pill>
					</div>
				}
			/>
			<Party x={A.x} y={A.y} title="Agent" sub="pays per use" p={agent} />
			<div style={{position: 'absolute', left: V.x - 150, top: V.y - 70, width: 300, opacity: bond}}>
				<Card style={{padding: '20px 24px', textAlign: 'center', borderColor: C.mintMid}} glow={refund * 0.6}>
					<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 34}}>Bond</div>
					<div style={{fontSize: 24, color: C.muted}}>USDC, held on chain</div>
				</Card>
			</div>
			<Label x={(A.x + L.x) / 2} y={A.y - 70} p={pay}>
				pays per use
			</Label>
			<Label x={(L.x + P.x) / 2} y={P.y - 70} p={earn}>
				90% to the provider
			</Label>
			<Label x={(P.x + V.x) / 2 - 150} y={(P.y + V.y) / 2 + 20} p={bond} color={C.mintMid}>
				posts a bond
			</Label>
			<Label x={(A.x + V.x) / 2 + 170} y={(A.y + V.y) / 2 + 20} p={refund} color={C.amber}>
				tests fail → refund
			</Label>
			<div style={{position: 'absolute', left: 260, right: 260, top: 590, opacity: cap}}>
				<div style={{display: 'flex', justifyContent: 'space-between', fontSize: 24, color: C.muted, marginBottom: 10}}>
					<span>What the release saves the agent</span>
					<span>example</span>
				</div>
				<div style={{height: 34, borderRadius: 10, background: C.surface2, overflow: 'hidden', display: 'flex'}}>
					<div style={{width: `${30 * ease(t, ph[1] + 34, ph[1] + 60)}%`, background: C.mint}} />
					<div style={{flex: 1}} />
				</div>
				<div style={{display: 'flex', gap: 40, marginTop: 10, fontSize: 26}}>
					<span style={{color: C.mint}}>price ≤ 30% of the measured saving</span>
					<span style={{color: C.muted}}>the agent keeps the rest</span>
				</div>
			</div>
		</Stage>
	);
};

// Q7. How does it grow? A flywheel.
const WHEEL = ['Free checks', 'Demand', 'New releases', 'Outcomes on chain', 'Better scores', 'More agents'];
const WHEEL_PHRASE = [0, 0, 2, 3, 3, 4];

export const Q7: React.FC<SceneProps> = ({t, ph}) => {
	const cx = 420;
	const cy = 330;
	const r = 250;
	const spin = (t / 90) * Math.PI * 2 * 0.25;
	return (
		<Stage>
			<svg width={900} height={700} style={{position: 'absolute', left: 60, top: 0}}>
				<circle cx={cx} cy={cy} r={r} fill="none" stroke={C.line} strokeWidth={6} />
				<circle
					cx={cx}
					cy={cy}
					r={r}
					fill="none"
					stroke={C.mint}
					strokeWidth={6}
					strokeDasharray={`${2 * Math.PI * r}`}
					strokeDashoffset={`${2 * Math.PI * r * (1 - ease(t, 0, (ph[4] ?? 200) + 30))}`}
					transform={`rotate(-90 ${cx} ${cy})`}
				/>
				<circle cx={cx + r * Math.cos(spin - Math.PI / 2)} cy={cy + r * Math.sin(spin - Math.PI / 2)} r={12} fill={C.mint} />
				<text x={cx} y={cy - 6} textAnchor="middle" fontFamily="Lexend" fontWeight={600} fontSize={52} fill={C.text}>
					Lemma
				</text>
				<text x={cx} y={cy + 40} textAnchor="middle" fontFamily="Instrument Sans" fontSize={26} fill={C.muted}>
					gets better with use
				</text>
			</svg>
			{WHEEL.map((label, i) => {
				const a = -Math.PI / 2 + (i / WHEEL.length) * Math.PI * 2;
				const p = at(t, ph, WHEEL_PHRASE[i], i % 2 ? 14 : 0);
				return (
					<div
						key={label}
						style={{
							position: 'absolute',
							left: 60 + cx + r * Math.cos(a),
							top: cy + r * Math.sin(a),
							transform: `translate(-50%, -50%) scale(${0.85 + 0.15 * p})`,
							padding: '12px 22px',
							borderRadius: 999,
							background: p > 0.5 ? C.mint : C.surface,
							color: p > 0.5 ? C.bg : C.faint,
							border: `2px solid ${p > 0 ? C.mint : C.line}`,
							fontFamily: F.head,
							fontWeight: 500,
							fontSize: 28,
							whiteSpace: 'nowrap',
						}}
					>
						{label}
					</div>
				);
			})}
			<div style={{position: 'absolute', left: 1060, top: 90, display: 'flex', flexDirection: 'column', gap: 26, width: 600}}>
				<Card style={rise(t, ph[1], 24)}>
					<div style={{fontSize: 24, color: C.mint, fontFamily: F.head, letterSpacing: 3, textTransform: 'uppercase'}}>Start</div>
					<div style={{fontFamily: F.head, fontSize: 38, marginTop: 8}}>x402 payments for Arbitrum's agent builders</div>
				</Card>
				<Card style={rise(t, ph[2], 24)}>
					<div style={{fontSize: 24, color: C.mint, fontFamily: F.head, letterSpacing: 3, textTransform: 'uppercase'}}>Next</div>
					<div style={{fontFamily: F.head, fontSize: 38, marginTop: 8}}>Whatever agents ask for most</div>
				</Card>
			</div>
		</Stage>
	);
};

// Q8. What's real today? Live, five editors, two purchases on Arbitrum Sepolia.
const Tx: React.FC<{label: string; hash: string; color?: string}> = ({label, hash, color = C.mint}) => (
	<div style={{display: 'flex', justifyContent: 'space-between', gap: 20, fontSize: 26, marginTop: 10}}>
		<span style={{color: C.muted}}>{label}</span>
		<span style={{fontFamily: F.mono, color}}>{hash}</span>
	</div>
);

export const Q8: React.FC<SceneProps> = ({t, ph}) => {
	const pulse = 0.5 + 0.5 * Math.sin(t / 6);
	return (
		<Stage>
			<div style={{position: 'absolute', left: 0, top: 0, display: 'flex', alignItems: 'center', gap: 26, ...rise(t, ph[0])}}>
				<Pill style={{fontSize: 34, padding: '10px 26px'}}>
					<span style={{width: 16, height: 16, borderRadius: 99, background: C.mint, opacity: 0.4 + 0.6 * pulse}} /> Live
				</Pill>
				<span style={{fontFamily: F.mono, fontSize: 30, color: C.muted}}>lemma-production-8383.up.railway.app</span>
			</div>
			<div style={{position: 'absolute', left: 0, top: 100, display: 'flex', gap: 16}}>
				{['Cursor', 'VS Code', 'Goose', 'Claude Code', 'Codex'].map((e, i) => (
					<span
						key={e}
						style={{
							fontFamily: F.head,
							fontSize: 30,
							padding: '12px 24px',
							borderRadius: 14,
							background: C.surface,
							border: `2px solid ${C.line}`,
							...rise(t, ph[1] + i * 7, 20),
						}}
					>
						<span style={{color: C.mint}}>⤓</span> {e}
					</span>
				))}
				<span style={{fontSize: 26, color: C.muted, alignSelf: 'center', ...rise(t, ph[1] + 40)}}>one-click install</span>
			</div>
			<div style={{position: 'absolute', left: 0, top: 220, ...rise(t, ph[2])}}>
				<Pill color={C.amber}>Arbitrum Sepolia testnet · 2026-10-01</Pill>
			</div>
			<div style={{position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', gap: 40}}>
				<Card style={{flex: 1, ...rise(t, ph[2] + 12, 30)}}>
					<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
						<div style={{fontFamily: F.head, fontSize: 38}}>Purchase 1</div>
						<Pill>✓ Tests passed</Pill>
					</div>
					<Tx label="Paid 0.25 testnet USDC" hash="0x58792e54…e07693" />
					<Tx label="Result recorded" hash="0x08e34b4d…5a060a" />
				</Card>
				<Card style={{flex: 1, ...rise(t, ph[3], 30)}} glow={at(t, ph, 3, 20)}>
					<div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
						<div style={{fontFamily: F.head, fontSize: 38}}>Purchase 2</div>
						<Pill color={C.amber}>✗ Failed → refunded</Pill>
					</div>
					<Tx label="Paid 0.25 testnet USDC" hash="0xb6a9dd4d…d75b14" />
					<Tx label="Refunded 0.25 testnet USDC" hash="0x4d501efa…adf950" color={C.amber} />
				</Card>
			</div>
		</Stage>
	);
};

// Q9. Who's building it?
const Founder: React.FC<{name: string; initials: string; p: React.CSSProperties}> = ({name, initials, p}) => (
	<Card style={{width: 620, display: 'flex', alignItems: 'center', gap: 30, ...p}}>
		<div
			style={{
				width: 130,
				height: 130,
				borderRadius: 999,
				display: 'grid',
				placeItems: 'center',
				background: `linear-gradient(135deg, ${C.mint}, ${C.mintDeep})`,
				color: C.bg,
				fontFamily: F.head,
				fontWeight: 600,
				fontSize: 50,
			}}
		>
			{initials}
		</div>
		<div>
			<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 42, lineHeight: 1.15}}>{name}</div>
			<div style={{fontSize: 30, color: C.mint, marginTop: 8}}>Co-founder</div>
		</div>
	</Card>
);

export const Q9: React.FC<SceneProps> = ({t, ph}) => (
	<Stage>
		<div style={{position: 'absolute', left: 0, right: 0, top: 40, display: 'flex', justifyContent: 'center', gap: 50}}>
			<Founder name="Aryan Singh Rathore" initials="AR" p={rise(t, ph[0], 30)} />
			<Founder name="Awaan Mustafa Siddiqui" initials="AS" p={rise(t, ph[0] + 10, 30)} />
		</div>
		<div style={{position: 'absolute', left: 200, right: 200, top: 360, ...rise(t, ph[1])}}>
			<div style={{height: 6, borderRadius: 3, background: C.line, position: 'relative'}}>
				<div style={{position: 'absolute', left: 0, top: 0, bottom: 0, width: `${100 * ease(t, ph[1], ph[1] + 40)}%`, background: C.mint, borderRadius: 3}} />
			</div>
			<div style={{display: 'flex', justifyContent: 'space-between', marginTop: 20, fontFamily: F.head, fontSize: 32}}>
				<span>First commit · 24 Sep 2026</span>
				<span style={{color: C.mint}}>Live on Arbitrum Sepolia · 1 Oct</span>
			</div>
			<div style={{textAlign: 'center', marginTop: 36, fontFamily: F.head, fontWeight: 500, fontSize: 54, ...rise(t, ph[1] + 30)}}>
				Built in under <span style={{color: C.mint}}>two weeks</span>
			</div>
		</div>
	</Stage>
);

// Q10. What do we need? The ask, then the closing line.
export const Q10: React.FC<SceneProps> = ({t, ph}) => {
	const asks = [
		{text: 'First outside providers', at: ph[0] + 20},
		{text: 'First paying teams', at: ph[0] + 55},
		{text: 'Lemma on Arbitrum One', at: ph[1]},
	];
	const close = at(t, ph, 2);
	return (
		<Stage>
			<div style={{position: 'absolute', left: 120, top: 30, ...rise(t, ph[0]), opacity: (1 - close) * ease(t, ph[0], ph[0] + 14)}}>
				<div style={{fontSize: 28, color: C.mint, fontFamily: F.head, letterSpacing: 3, textTransform: 'uppercase'}}>At Founder House</div>
				<div style={{display: 'flex', flexDirection: 'column', gap: 26, marginTop: 30}}>
					{asks.map((a) => {
						const p = ease(t, a.at, a.at + 14);
						return (
							<div key={a.text} style={{display: 'flex', alignItems: 'center', gap: 26, fontFamily: F.head, fontWeight: 500, fontSize: 62, opacity: 0.25 + 0.75 * p}}>
								<span
									style={{
										width: 64,
										height: 64,
										borderRadius: 16,
										display: 'grid',
										placeItems: 'center',
										border: `3px solid ${C.mint}`,
										background: p > 0.5 ? C.mint : 'transparent',
										color: C.bg,
										fontSize: 40,
									}}
								>
									{p > 0.5 ? '✓' : ''}
								</span>
								{a.text}
							</div>
						);
					})}
				</div>
			</div>
			<div
				style={{
					position: 'absolute',
					inset: 0,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
					alignItems: 'center',
					textAlign: 'center',
					opacity: close,
					transform: `scale(${0.95 + 0.05 * close})`,
				}}
			>
				<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 92, lineHeight: 1.15, maxWidth: 1500}}>
					Agents stop paying to <span style={{color: C.mint}}>rediscover solved work.</span>
				</div>
			</div>
		</Stage>
	);
};
