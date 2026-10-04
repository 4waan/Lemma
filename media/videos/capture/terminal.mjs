// Runs the real commands the demo shows and saves what they printed to
// public/demo/terminal.json, which the video replays as typed terminals. Run
// from the repository after `npm run build`; it needs network access to the
// hosted server and to Arbitrum Sepolia, and no key.
//
//   node capture/terminal.mjs
//
// 1. A small TypeScript MCP server repository (weather-mcp).
// 2. The shipped bridge (lemma-mcp) asking the hosted server for a preview,
//    through a relay that records the one request the bridge sends.
// 3. Two previews where nothing fits: a capability with no release, and a
//    JavaScript repository.
// 4. npm run sepolia:check, read-only, against Arbitrum Sepolia.
// 5. The bridge's purchase-safety tests, and the contract test files.
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('../../..', import.meta.url).pathname);
const require = (await import('node:module')).createRequire(path.join(repo, 'package.json'));
const {Client} = await import(require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const {StdioClientTransport} = await import(require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

const API = 'https://lemma-production-8383.up.railway.app';
const RPC = process.env.ARBITRUM_SEPOLIA_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc';
const work = mkdtempSync(path.join(tmpdir(), 'lemma-demo-'));
// The bridge refuses to run tests with a wallet key in its environment; the demo needs none.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/PRIVATE_KEY/.test(k)));

function writeRepo(dir, language) {
	rmSync(dir, {recursive: true, force: true});
	mkdirSync(path.join(dir, 'src'), {recursive: true});
	const ts = language === 'typescript';
	const pkg = {
		name: path.basename(dir),
		private: true,
		type: 'module',
		scripts: ts ? {build: 'tsc', test: 'node --test'} : {test: 'node --test'},
		dependencies: {'@modelcontextprotocol/sdk': '^1.30.0'},
		...(ts ? {devDependencies: {typescript: '5.9.2'}} : {}),
	};
	writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
	const lock = {name: pkg.name, lockfileVersion: 3, requires: true, packages: {'': {name: pkg.name}, 'node_modules/@modelcontextprotocol/sdk': {version: '1.30.1'}}};
	writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
	writeFileSync(path.join(dir, '.nvmrc'), '22\n');
	if (ts) writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({compilerOptions: {module: 'NodeNext', target: 'ES2022', strict: true}}, null, 2) + '\n');
	writeFileSync(path.join(dir, 'src', ts ? 'server.ts' : 'server.js'), '// A weather MCP server.\n');
}

/** A relay in front of the hosted server that records every request body. */
async function startRelay() {
	const requests = [];
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks);
		requests.push({method: req.method, url: req.url, body: body.length ? body.toString('utf8') : ''});
		const headers = {...req.headers};
		delete headers.host;
		delete headers['content-length'];
		const upstream = await fetch(API + req.url, {method: req.method, headers, body: body.length ? body : undefined});
		const text = await upstream.text();
		res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') ?? 'application/json'});
		res.end(text);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	return {url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close()};
}

async function bridgeCalls(workspace, apiUrl, calls) {
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [path.join(repo, 'apps/bridge/dist/main.js')],
		env: {...env, LEMMA_API_URL: apiUrl, LEMMA_WORKSPACE: workspace, LEMMA_STATE_DIR: `${workspace}-state`},
		cwd: workspace,
		stderr: 'pipe',
	});
	const client = new Client({name: 'demo-agent', version: '0.0.0'});
	await client.connect(transport);
	const answers = [];
	for (const [name, args] of calls) {
		const result = await client.callTool({name, arguments: args});
		answers.push({tool: name, args, answer: result.content.map((c) => c.text).join(' ')});
	}
	await client.close();
	return answers;
}

const out = {capturedAt: new Date().toISOString()};

// 1 and 2.
const weather = path.join(work, 'weather-mcp');
writeRepo(weather, 'typescript');
out.repo = {
	files: execFileSync('find', ['.', '-type', 'f', '-not', '-path', './node_modules/*'], {cwd: weather}).toString().trim().split('\n').sort(),
	packageJson: readFileSync(path.join(weather, 'package.json'), 'utf8').trimEnd().split('\n'),
};
const relay = await startRelay();
out.preview = await bridgeCalls(weather, relay.url, [['lemma_preview', {capability: 'mcp-server.add-payment-gating'}]]);
relay.close();
const call = relay.requests.find((r) => r.body.includes('"tools/call"'));
const sent = JSON.parse(call.body);
out.sent = {method: call.method, url: call.url, arguments: sent.params.arguments, others: relay.requests.filter((r) => r !== call).map((r) => `${r.method} ${r.url}`)};
delete out.preview[0].answer; // The demo shows what is sent, not this answer.

// 3.
const js = path.join(work, 'weather-js');
writeRepo(js, 'javascript');
out.noFit = [
	...(await bridgeCalls(weather, API, [['lemma_preview', {capability: 'node-service.add-payment-facilitator'}]])),
	...(await bridgeCalls(js, API, [['lemma_preview', {capability: 'mcp-server.add-payment-gating'}]])),
];

// 4.
out.sepoliaCheck = execFileSync('npm', ['run', '-s', 'sepolia:check'], {cwd: repo, env: {...env, ARBITRUM_SEPOLIA_RPC_URL: RPC}}).toString().trimEnd().split('\n');

// 5.
const tests = execFileSync(
	'npx',
	['vitest', 'run', 'apps/bridge/test/buy.test.ts', '--reporter=verbose', '-t', "recovers a lost answer|refuses over the bridge's caps|never pays a challenge|pays nothing when the signer refuses|charges nothing for a quote"],
	{cwd: repo, env: {...env, NO_COLOR: '1', FORCE_COLOR: '0'}},
).toString();
out.tests = tests.split('\n').filter((l) => /✓|×|Test Files|Tests /.test(l)).map((l) => l.replace(/\s+\d+ms$/, '').trim());
out.contractTests = [
	...readdirSync(path.join(repo, 'contracts/test')).filter((f) => f.endsWith('.t.sol')).map((f) => `contracts/test/${f}`),
	...readdirSync(path.join(repo, 'contracts/test/invariant')).filter((f) => f.endsWith('.t.sol')).map((f) => `contracts/test/invariant/${f}`),
];

rmSync(work, {recursive: true, force: true});
mkdirSync(new URL('../public/demo', import.meta.url), {recursive: true});
writeFileSync(new URL('../public/demo/terminal.json', import.meta.url), JSON.stringify(out, null, '\t') + '\n');
console.log(JSON.stringify(out, null, 2).slice(0, 4000));
