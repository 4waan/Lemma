import React from 'react';
import {C, ease, F, lin, rise, type SceneProps} from '../theme';
import {at, Card, Pill, Stage, Terminal} from '../scenes/ui';
import {Browser, type PageShot} from './Browser';
import {stagger, Term, type Line} from './Term';
import benchmark from '../../public/demo/pages/benchmark.json';
import home from '../../public/demo/pages/home.json';
import registryDeploy from '../../public/demo/pages/registry-deploy.json';
import p1Pay from '../../public/demo/pages/p1-pay.json';
import p1Act from '../../public/demo/pages/p1-act.json';
import p1OutLogs from '../../public/demo/pages/p1-out-logs.json';
import p2Out from '../../public/demo/pages/p2-out.json';
import p2Refund from '../../public/demo/pages/p2-refund.json';
import terminal from '../../public/demo/terminal.json';

const page = (p: unknown) => p as PageShot;

/** Where the main panel sits; segments with the state tracker leave the right column free. */
const FULL = {x: 100, y: 140, width: 1720, height: 770};
const LEFT = {x: 80, y: 140, width: 1370, height: 770};

const Stamp: React.FC<{p: number; children: React.ReactNode; x: number; y: number; color?: string; rotate?: number}> = ({p, children, x, y, color = C.mint, rotate = -6}) => (
	<div
		style={{
			position: 'absolute',
			left: x,
			top: y,
			padding: '14px 30px',
			border: `5px solid ${color}`,
			borderRadius: 16,
			color,
			background: `${C.bg}e6`,
			fontFamily: F.head,
			fontWeight: 700,
			fontSize: 48,
			letterSpacing: 1,
			opacity: p,
			transform: `rotate(${rotate}deg) scale(${1.4 - 0.4 * p})`,
			whiteSpace: 'nowrap',
		}}
	>
		{children}
	</div>
);

// d1. What's the problem? The same integration rebuilt three times.
const BUILD = ['› add x402 payment gating', '  reading the x402 docs…', '  writing src/x402.ts', '  writing src/paywall.ts', '  npm test'];
export const D1: React.FC<SceneProps> = ({t, ph}) => (
	<Stage style={{top: 150}}>
		<div style={{display: 'flex', gap: 30, justifyContent: 'center', marginTop: 70}}>
			{['team A', 'team B', 'team C'].map((team, i) => (
				<Terminal
					key={team}
					title={`${team} · agent`}
					lines={BUILD}
					progress={lin(t, i * 8, ph[1] + 30 + i * 8)}
					tokens={6000 + Math.max(0, t - i * 6) * (420 + i * 90)}
					failed={i === 2 && t > ph[2] + 20}
					scale={1.15}
					style={{width: 540, height: 360, ...rise(t, i * 6, 30)}}
				/>
			))}
		</div>
		<div style={{textAlign: 'center', marginTop: 60, fontFamily: F.head, fontSize: 50, ...rise(t, ph[2])}}>
			Same integration. <span style={{color: C.amber}}>Paid for three times.</span>
		</div>
	</Stage>
);

// d2. Who has it? The weather-mcp repository.
export const D2: React.FC<SceneProps> = ({t, ph}) => {
	const lines: Line[] = [
		{text: 'find . -type f', at: 4, kind: 'cmd'},
		...stagger(terminal.repo.files, 30, 3),
		{text: 'cat package.json', at: ph[1] - 10, kind: 'cmd'},
		...stagger(terminal.repo.packageJson, ph[1] + 16, 2).map((l) => (/sdk|typescript|"module"/.test(l.text) ? {...l, mark: [ph[1] + 40, 9999] as [number, number]} : l)),
	];
	return (
		<>
			<Term title="~/weather-mcp" lines={lines} t={t} x={100} y={140} width={1000} height={770} fontSize={24} />
			<Card style={{position: 'absolute', left: 1150, top: 200, width: 660, ...rise(t, ph[0] + 10, 30)}} glow={at(t, ph, 2)}>
				<div style={{fontSize: 24, color: C.mint, fontFamily: F.head, letterSpacing: 3, textTransform: 'uppercase'}}>Our first user</div>
				<div style={{fontFamily: F.head, fontWeight: 500, fontSize: 42, marginTop: 10, lineHeight: 1.2}}>A developer whose agent must add x402 payments</div>
				<div style={{display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 24}}>
					{['TypeScript', 'MCP server', 'Node 22', 'npm'].map((tag, i) => (
						<Pill key={tag} style={rise(t, ph[1] + i * 6, 12)}>
							{tag}
						</Pill>
					))}
				</div>
				<div style={{marginTop: 26, fontSize: 30, color: C.muted, ...rise(t, ph[2])}}>A few files, easy to get wrong, already built by someone else.</div>
			</Card>
		</>
	);
};

// d3. What's missing today? The comparison grid.
const ROWS = ['Checks fit before you pay', 'Price capped by measured saving', 'Refund from a bond if tests fail'];
const COLS = [
	{name: 'Code search', marks: [false, false, false]},
	{name: 'Coverage after failure', marks: [false, false, true]},
	{name: 'Lemma', marks: [true, true, true]},
];
export const D3: React.FC<SceneProps> = ({t, ph}) => (
	<Stage style={{top: 170}}>
		<div style={{display: 'grid', gridTemplateColumns: '560px repeat(3, 330px)', gap: 0, margin: '0 auto', width: 560 + 990}}>
			<div />
			{COLS.map((c, i) => (
				<div
					key={c.name}
					style={{
						fontFamily: F.head,
						fontWeight: 600,
						fontSize: 34,
						textAlign: 'center',
						padding: '18px 10px',
						color: i === 2 ? C.bg : C.text,
						background: i === 2 ? C.mint : 'transparent',
						borderRadius: '18px 18px 0 0',
						...rise(t, i === 0 ? 0 : i === 1 ? ph[1] : ph[2], 20),
					}}
				>
					{c.name}
				</div>
			))}
			{ROWS.map((row, r) => (
				<React.Fragment key={row}>
					<div style={{fontSize: 34, padding: '26px 0', borderTop: `1px solid ${C.line}`, ...rise(t, ph[2] + r * 10, 16)}}>{row}</div>
					{COLS.map((c, i) => {
						const p = ease(t, (i === 0 ? ph[0] + 20 : i === 1 ? ph[1] + 20 : ph[3]) + r * 8, (i === 0 ? ph[0] + 32 : i === 1 ? ph[1] + 32 : ph[3] + 12) + r * 8);
						return (
							<div
								key={c.name}
								style={{
									display: 'grid',
									placeItems: 'center',
									borderTop: `1px solid ${C.line}`,
									background: i === 2 ? `${C.mintDeep}22` : 'transparent',
									fontSize: 46,
									fontWeight: 700,
									color: c.marks[r] ? C.mint : C.red,
									opacity: p,
									transform: `scale(${0.6 + 0.4 * p})`,
								}}
							>
								{c.marks[r] ? '✓' : '✗'}
							</div>
						);
					})}
				</React.Fragment>
			))}
		</div>
	</Stage>
);

// d4. What's our insight? The live pricing calculator.
export const D4: React.FC<SceneProps> = ({t, ph}) => (
	<>
		<Browser
			page={page(benchmark)}
			t={t}
			{...FULL}
			stops={[
				{at: 0, box: 'math', zoom: 1.05, y: 0},
				{at: ph[1], box: 'rule30', zoom: 1.6},
				{at: ph[2], box: 'allowed', zoom: 1.35},
			]}
			marks={[
				{box: 'rule30', from: ph[1] + 12},
				{box: 'sellable', from: ph[2] + 6, label: 'checked in code', side: 'below'},
				{box: 'keep', from: ph[2] + 24},
			]}
		/>
		<Stamp p={at(t, ph, 3)} x={160} y={760}>
			No evidence, no sale
		</Stamp>
	</>
);

// d5. What leaves your machine? The agent's call and the one request it causes.
export const D5: React.FC<SceneProps> = ({t, ph}) => {
	const args = terminal.sent.arguments;
	const profile = args.profile;
	const json: {text: string; key?: string}[] = [
		{text: '{'},
		{text: '  "task": {'},
		{text: `    "capability": "${args.task.capability}"`, key: 'task'},
		{text: '  },'},
		{text: '  "profile": {'},
		{text: `    "language": "${profile.language}",`, key: 'language'},
		{text: `    "runtime": { "name": "node", "major": ${profile.runtime.major} },`, key: 'runtime'},
		{text: `    "packageManager": { "name": "npm", "lockfile": "${profile.packageManager.lockfile}" },`, key: 'pm'},
		{text: `    "moduleSystem": "${profile.moduleSystem}",`, key: 'module'},
		{text: `    "dependencies": { "@modelcontextprotocol/sdk": "${profile.dependencies['@modelcontextprotocol/sdk']}" },`, key: 'deps'},
		{text: `    "frameworks": []`},
		{text: '  }'},
		{text: '}'},
	];
	const order = ['task', 'language', 'runtime', 'pm', 'module', 'deps'];
	const agent: Line[] = [
		{text: 'claude  # in ~/weather-mcp', at: 2, kind: 'cmd'},
		{text: '> Add x402 payment gating to this MCP server.', at: 26, kind: 'title'},
		{text: '', at: 30},
		{text: '● lemma_preview', at: ph[0] + 30, kind: 'ok'},
		{text: `  capability: "${terminal.preview[0].args.capability}"`, at: ph[0] + 34},
	];
	const lit = (key: string) => {
		const i = order.indexOf(key);
		const from = ph[2] + i * 14;
		return ease(t, from, from + 8);
	};
	return (
		<>
			<Term title="agent · weather-mcp" lines={agent} t={t} x={80} y={140} width={760} height={420} fontSize={23} />
			<div
				style={{
					position: 'absolute',
					left: 80,
					top: 590,
					width: 760,
					padding: '22px 28px',
					borderRadius: 18,
					background: C.surface,
					border: `2px solid ${C.line}`,
					...rise(t, ph[3] - 10, 20),
				}}
			>
				<div style={{fontFamily: F.head, fontSize: 30}}>
					<span style={{fontSize: 34}}>🔒</span> src/, tests and file paths <span style={{color: C.mint}}>stay on this machine</span>
				</div>
			</div>
			<div
				style={{
					position: 'absolute',
					left: 880,
					top: 140,
					width: 960,
					height: 770,
					borderRadius: 18,
					background: '#070C0E',
					border: `2px solid ${C.mint}`,
					overflow: 'hidden',
					...rise(t, ph[1], 30),
				}}
			>
				<div style={{height: 46, display: 'flex', alignItems: 'center', padding: '0 20px', background: C.surface2, fontFamily: F.mono, fontSize: 18, color: C.muted}}>
					recorded at a relay · POST {terminal.sent.url} · tools/call lemma_preview
				</div>
				<div style={{padding: '18px 24px', fontFamily: F.mono, fontSize: 19, lineHeight: '36px'}}>
					{json.map((l, i) => {
						const p = l.key ? lit(l.key) : 0;
						return (
							<div key={i} style={{whiteSpace: 'pre', color: l.key ? (p > 0.5 ? C.text : C.muted) : C.faint, background: `rgba(23, 144, 107, ${0.5 * p})`, borderRadius: 6}}>
								{l.text}
							</div>
						);
					})}
				</div>
				<div style={{position: 'absolute', left: 24, bottom: 22, fontSize: 24, color: C.muted, ...rise(t, ph[3])}}>
					Everything about the project that leaves the machine. Captured 2026-10-04.
				</div>
			</div>
		</>
	);
};

// d6. What if nothing fits? Two real free answers.
export const D6: React.FC<SceneProps> = ({t, ph}) => {
	const [facilitator, js] = terminal.noFit;
	const wrap = (s: string) => s.replace('Build it yourself;', '\n  Build it yourself;').split('\n');
	const lines: Line[] = [
		{text: '# weather-mcp, a capability Lemma has no release for yet', at: 2, kind: 'muted'},
		{text: `lemma_preview ${JSON.stringify(facilitator.args)}`, at: 8, kind: 'cmd'},
		...wrap(facilitator.answer).map((text, i) => ({text, at: ph[1] - 4 + i * 3, kind: 'ok' as const, mark: [ph[2], ph[2] + 50] as [number, number]})),
		{text: '', at: ph[1]},
		{text: '# weather-js, a JavaScript project', at: ph[1] + 14, kind: 'muted'},
		{text: `lemma_preview ${JSON.stringify(js.args)}`, at: ph[1] + 20, kind: 'cmd'},
		...wrap(js.answer).map((text, i) => ({text, at: ph[2] - 6 + i * 3, kind: 'ok' as const, mark: [ph[2] + 6, ph[2] + 56] as [number, number]})),
	];
	return (
		<>
			<Term title="lemma-mcp · answers from the hosted server, 2026-10-04" lines={lines} t={t} {...FULL} height={560} fontSize={25} />
			<Stamp p={at(t, ph, 2, 20)} x={1260} y={700}>
				0 USDC charged
			</Stamp>
			<div style={{position: 'absolute', left: 120, top: 760, display: 'flex', gap: 18, ...rise(t, ph[3])}}>
				<Pill>Deterministic matching</Pill>
				<Pill color={C.muted}>no model decides a match or a price</Pill>
			</div>
		</>
	);
};

// d7. Why on chain, why Arbitrum, why Stylus?
export const D7: React.FC<SceneProps> = ({t, ph}) => {
	const crate = at(t, ph, 3);
	const split = at(t, ph, 4);
	return (
		<>
			<Browser
				page={page(registryDeploy)}
				t={t}
				x={80}
				y={140}
				width={1000}
				height={560}
				stops={[{at: 0, y: 0, zoom: 1.6}, {at: ph[1], box: 'created', zoom: 1.9}]}
				marks={[{box: 'created', from: ph[1] + 10, label: 'Warranty registry (Solidity)', side: 'below'}, {box: 'status', from: ph[1] + 24}]}
				opacity={ease(t, 0, 12)}
			/>
			<div style={{position: 'absolute', left: 80, top: 730, width: 1000, display: 'flex', gap: 16, ...rise(t, ph[2])}}>
				<Pill>USDC payment</Pill>
				<Pill>the agent holds no ETH</Pill>
				<Pill color={C.muted}>gas paid by Lemma's facilitator</Pill>
			</div>
			<div style={{position: 'absolute', left: 1130, top: 150, width: 700}}>
				<Card style={{...rise(t, ph[0], 24)}} glow={at(t, ph, 1) * (1 - crate)}>
					<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 36}}>The bond lives in a contract</div>
					<div style={{fontSize: 27, color: C.muted, marginTop: 8}}>not with the seller, so the refund does not depend on trusting us.</div>
				</Card>
				<div style={{marginTop: 30, ...rise(t, ph[3], 24)}}>
					<div style={{display: 'flex', justifyContent: 'center'}}>
						<div style={{padding: '16px 30px', borderRadius: 16, border: `3px solid ${C.amber}`, fontFamily: F.mono, fontSize: 28, color: C.amber}}>lemma-confidence (Rust)</div>
					</div>
					<svg width={700} height={90}>
						<path d={`M350 0 C350 50 175 40 175 90`} stroke={C.mint} strokeWidth={4} fill="none" strokeDasharray="300" strokeDashoffset={300 * (1 - split)} />
						<path d={`M350 0 C350 50 525 40 525 90`} stroke={C.mint} strokeWidth={4} fill="none" strokeDasharray="300" strokeDashoffset={300 * (1 - split)} />
					</svg>
					<div style={{display: 'flex', gap: 24, opacity: split}}>
						{[
							['Stylus contract', 'on Arbitrum'],
							['Lemma server', 'as wasm'],
						].map(([a, b]) => (
							<Card key={a} style={{flex: 1, padding: 22, textAlign: 'center'}}>
								<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 32}}>{a}</div>
								<div style={{fontSize: 24, color: C.muted}}>{b}</div>
								<div style={{marginTop: 10, fontFamily: F.mono, fontSize: 24, color: C.mint}}>same score</div>
							</Card>
						))}
					</div>
				</div>
			</div>
		</>
	);
};

// d8. Show the transaction: purchase 1's payment.
export const D8: React.FC<SceneProps> = ({t, ph}) => {
	const cut = ph[1] - 6;
	return (
		<>
			{t < cut + 10 ? (
				<Browser
					page={page(home)}
					t={t}
					{...LEFT}
					stops={[{at: 0, box: 'purchases', zoom: 1.1}, {at: 12, box: 'p1', zoom: 1.5}]}
					marks={[{box: 'p1pay', from: 30}]}
					opacity={1 - ease(t, cut, cut + 10)}
				/>
			) : null}
			{t >= cut ? (
				<Browser
					page={page(p1Pay)}
					t={t - cut}
					{...LEFT}
					stops={[
						{at: 0, box: 'action', zoom: 1.25},
						{at: ph[2] - cut, box: 'from', zoom: 1.5},
					]}
					marks={[
						{box: 'action', from: 8, label: '0.25 USDC, buyer → provider', side: 'above'},
						{box: 'status', from: 20},
						{box: 'from', from: ph[2] - cut + 10, label: "sent by Lemma's facilitator", side: 'right'},
						{box: 'fee', from: ph[2] - cut + 30, label: 'gas paid by the facilitator, not the agent', side: 'right'},
					]}
					opacity={ease(t, cut, cut + 10)}
				/>
			) : null}
		</>
	);
};

// d9. Show the state change: activation, then the recorded result.
export const D9: React.FC<SceneProps> = ({t, ph}) => {
	const cut = ph[1] - 4;
	return (
		<>
			{t < cut + 10 ? (
				<Browser
					page={page(p1Act)}
					t={t}
					{...LEFT}
					stops={[{at: 0, box: 'status', zoom: 1.3}, {at: 24, box: 'from', zoom: 1.4}]}
					marks={[
						{box: 'from', from: 20, label: 'the provider', side: 'right'},
						{box: 'to', from: 34, label: 'registry · ResolutionActivated: 0.25 of the bond reserved', side: 'right'},
					]}
					opacity={1 - ease(t, cut, cut + 10)}
				/>
			) : null}
			{t >= cut ? (
				<Browser
					page={page(p1OutLogs)}
					t={t - cut}
					{...LEFT}
					stops={[
						{at: 0, box: 'log1', zoom: 1.05},
						{at: ph[2] - cut, box: 'log2', zoom: 1.35},
					]}
					marks={[
						{box: 'log1', from: 14, label: 'decoded: registry · OutcomeFinalized, passed', side: 'below'},
						{box: 'log2', from: ph[2] - cut + 12, label: 'decoded: Stylus engine · OutcomeRecorded', side: 'right'},
					]}
					opacity={ease(t, cut, cut + 10)}
				/>
			) : null}
		</>
	);
};

// d10. What happens when it fails? Purchase 2, failed, refunded.
export const D10: React.FC<SceneProps> = ({t, ph}) => {
	const cut1 = ph[1] - 6;
	const cut2 = ph[2] - 6;
	return (
		<>
			{t < cut1 + 10 ? (
				<Browser
					page={page(home)}
					t={t}
					{...LEFT}
					stops={[{at: 0, box: 'p2', zoom: 1.5}]}
					marks={[{box: 'p2', from: 10, label: 'tests failed', side: 'right', color: '#B7791F'}]}
					opacity={1 - ease(t, cut1, cut1 + 10)}
				/>
			) : null}
			{t >= cut1 && t < cut2 + 10 ? (
				<Browser
					page={page(p2Out)}
					t={t - cut1}
					{...LEFT}
					stops={[{at: 0, box: 'from', zoom: 1.4}]}
					marks={[
						{box: 'from', from: 10, label: 'the evaluator', side: 'right'},
						{box: 'to', from: 22, label: 'registry · OutcomeFinalized: failed', side: 'right', color: '#B7791F'},
					]}
					opacity={ease(t, cut1, cut1 + 10) * (1 - ease(t, cut2, cut2 + 10))}
				/>
			) : null}
			{t >= cut2 ? (
				<Browser
					page={page(p2Refund)}
					t={t - cut2}
					{...LEFT}
					stops={[{at: 0, box: 'action', zoom: 1.3}, {at: 40, box: 'transfers', zoom: 1.45}]}
					marks={[
						{box: 'action', from: 10, label: '0.25 USDC, registry → refund address', side: 'above'},
						{box: 'status', from: 24},
					]}
					opacity={ease(t, cut2, cut2 + 10)}
				/>
			) : null}
		</>
	);
};

// d11. Does it hold today? The read-only check against the chain.
export const D11: React.FC<SceneProps> = ({t, ph}) => {
	const lines: Line[] = [
		{text: 'npm run sepolia:check', at: 2, kind: 'cmd'},
		...terminal.sepoliaCheck.map((text, i) => {
			const kind: Line['kind'] = text.startsWith('warn') ? 'warn' : text.startsWith('conformance') ? 'ok' : 'out';
			const markFrom = /registry\.code|engine\.code/.test(text)
				? ph[2]
				: /registry\.engine|engine\.registry/.test(text)
					? ph[2] + 20
					: /solvency/.test(text)
						? ph[2] + 40
						: /engine\.stats|engine\.confidence/.test(text)
							? ph[3]
							: /every check passed/.test(text)
								? ph[4]
								: undefined;
			return {text, at: ph[1] + i * 3, kind, mark: markFrom === undefined ? undefined : ([markFrom, 9999] as [number, number])};
		}),
	];
	return <Term title="read-only check against Arbitrum Sepolia · 2026-10-04" lines={lines} t={t} {...LEFT} fontSize={17} />;
};

// d12. Is it durable? The purchase-safety tests and the contract tests.
export const D12: React.FC<SceneProps> = ({t, ph}) => {
	const short = (s: string) => s.replace('apps/bridge/test/buy.test.ts > lemma_buy_resolution in the bridge > ', '');
	const [lost, caps, signer, expired, terms] = terminal.tests.slice(0, 5);
	const lines: Line[] = [
		{text: 'npx vitest run apps/bridge/test/buy.test.ts', at: 2, kind: 'cmd'},
		{text: short(lost), at: ph[1], kind: 'ok', mark: [ph[1] + 4, ph[2]]},
		{text: short(caps), at: ph[2], kind: 'ok', mark: [ph[2] + 4, ph[3]]},
		{text: short(signer), at: ph[2] + 16, kind: 'ok'},
		{text: short(expired), at: ph[3] - 10, kind: 'ok'},
		{text: short(terms), at: ph[3], kind: 'ok', mark: [ph[3] + 4, ph[4]]},
		{text: terminal.tests.find((l) => l.startsWith('Tests')) ?? '', at: ph[3] + 24, kind: 'title'},
		{text: '', at: ph[4] - 8},
		{text: 'ls contracts/test contracts/test/invariant', at: ph[4] - 6, kind: 'cmd'},
		...terminal.contractTests.map((f, i) => ({
			text: f,
			at: ph[4] + 14 + i * 3,
			kind: 'out' as const,
			mark: /Fuzz|Invariant/.test(f) ? ([ph[4] + 34, 9999] as [number, number]) : undefined,
		})),
	];
	return <Term title="~/Lemma" lines={lines} t={t} {...FULL} fontSize={22} />;
};

// d13. What did we cut?
export const D13: React.FC<SceneProps> = ({t, ph}) => {
	const cuts = ['Marketplace of providers', 'Mainnet', 'Fee split'];
	return (
		<Stage style={{top: 180}}>
			<div style={{display: 'flex', flexDirection: 'column', gap: 26, marginLeft: 220}}>
				{cuts.map((c, i) => {
					const strike = ease(t, ph[0] + 20 + i * 12, ph[0] + 34 + i * 12);
					return (
						<div key={c} style={{position: 'relative', fontFamily: F.head, fontWeight: 500, fontSize: 66, color: strike > 0.5 ? C.faint : C.text, alignSelf: 'flex-start', ...rise(t, i * 6)}}>
							{c}
							<div style={{position: 'absolute', left: -10, right: -10, top: '52%', height: 6, background: C.red, transformOrigin: 'left', transform: `scaleX(${strike})`}} />
						</div>
					);
				})}
			</div>
			<div style={{marginLeft: 220, marginTop: 50, fontFamily: F.head, fontSize: 48, ...rise(t, ph[1])}}>
				First, the whole loop: <span style={{color: C.mint}}>pay → apply → test → refund</span>
			</div>
		</Stage>
	);
};

// d14. What did we trade off?
const TRADES = [
	['A team key judges failures', 'ship a working loop now', 'independent evaluators'],
	['Matching reads only metadata', 'your code never leaves', 'covers fewer projects'],
	['One owner key on the contracts', 'ship now', 'a multisig'],
];
export const D14: React.FC<SceneProps> = ({t, ph}) => (
	<Stage style={{top: 170}}>
		<div style={{display: 'grid', gridTemplateColumns: '640px 480px 480px', margin: '0 auto', width: 1600}}>
			{['Trade-off', 'Why', 'Cost or next step'].map((h, i) => (
				<div key={h} style={{fontFamily: F.head, fontSize: 28, color: C.mint, letterSpacing: 2, textTransform: 'uppercase', padding: '0 0 16px', ...rise(t, i * 4)}}>
					{h}
				</div>
			))}
			{TRADES.map((row, r) =>
				row.map((cell, c) => (
					<div
						key={`${r}-${c}`}
						style={{
							fontSize: c === 0 ? 38 : 32,
							fontFamily: c === 0 ? F.head : F.body,
							color: c === 0 ? C.text : c === 1 ? C.muted : C.amber,
							padding: '26px 20px 26px 0',
							borderTop: `1px solid ${C.line}`,
							...rise(t, ph[r + 1] + c * 8, 16),
						}}
					>
						{cell}
					</div>
				)),
			)}
		</div>
	</Stage>
);

// d15. What isn't covered yet?
export const D15: React.FC<SceneProps> = ({t, ph}) => {
	const items = ['Independent evaluators', 'Mainnet custody', 'Reorg detection in our indexer', 'Sandboxed tests on macOS'];
	return (
		<Stage style={{top: 190}}>
			<div style={{marginLeft: 220, display: 'flex', flexDirection: 'column', gap: 26}}>
				{items.map((it, i) => (
					<div key={it} style={{display: 'flex', alignItems: 'center', gap: 26, fontFamily: F.head, fontSize: 58, ...rise(t, (i < 2 ? ph[0] : ph[1]) + (i % 2) * 14, 20)}}>
						<span style={{width: 26, height: 26, borderRadius: 99, background: C.amber}} />
						{it}
					</div>
				))}
			</div>
		</Stage>
	);
};

// d16. What comes next?
const NEXT = ['Measured benchmarks', 'Outside providers', 'Independent evaluators', 'Audit', 'Arbitrum One'];
export const D16: React.FC<SceneProps> = ({t, ph}) => {
	const close = at(t, ph, 1, -2);
	const fade = 1 - ease(t, ph[1] - 10, ph[1] + 2);
	return (
		<Stage style={{top: 200}}>
			<div style={{opacity: fade}}>
				<div style={{position: 'relative', height: 260, margin: '40px 60px 0'}}>
					<div style={{position: 'absolute', left: 40, right: 40, top: 40, height: 6, background: C.line}} />
					<div style={{position: 'absolute', left: 40, top: 40, height: 6, background: C.mint, width: `${ease(t, 0, ph[1] - 10) * 92}%`}} />
					<div style={{display: 'flex', justifyContent: 'space-between'}}>
						{NEXT.map((n, i) => {
							const p = ease(t, i * ((ph[1] - 20) / NEXT.length), i * ((ph[1] - 20) / NEXT.length) + 10);
							return (
								<div key={n} style={{width: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', opacity: 0.3 + 0.7 * p}}>
									<div style={{width: 86, height: 86, borderRadius: 99, background: p > 0.5 ? C.mint : C.surface, border: `4px solid ${C.mint}`}} />
									<div style={{marginTop: 22, fontFamily: F.head, fontSize: 34, textAlign: 'center'}}>{n}</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>
			<div style={{position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', opacity: close}}>
				<div style={{fontFamily: F.head, fontWeight: 600, fontSize: 88, textAlign: 'center', maxWidth: 1500, lineHeight: 1.15}}>
					Agents stop paying to <span style={{color: C.mint}}>rediscover solved work.</span>
				</div>
			</div>
		</Stage>
	);
};

export const DEMO_SCENES: Record<string, React.FC<SceneProps>> = {
	d1: D1,
	d2: D2,
	d3: D3,
	d4: D4,
	d5: D5,
	d6: D6,
	d7: D7,
	d8: D8,
	d9: D9,
	d10: D10,
	d11: D11,
	d12: D12,
	d13: D13,
	d14: D14,
	d15: D15,
	d16: D16,
};

