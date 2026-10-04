// Captures the browser shots for the demo: the live dashboard and the
// 1 October transactions on Arbiscan, as 2x screenshots, plus the box of every
// element the video points at. Remotion pans and zooms over them.
//
//   node capture/pages.mjs [name …]
//
// Needs Chromium (PLAYWRIGHT_BROWSERS_PATH or CHROMIUM) and network access.
import {chromium} from 'playwright-core';
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';

const DASH = 'https://lemma-production-8383.up.railway.app';
const SCAN = 'https://sepolia.arbiscan.io';
export const PAGES = JSON.parse(readFileSync(new URL('./pages.json', import.meta.url), 'utf8'));

const only = process.argv.slice(2);
const executablePath = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const out = new URL('../public/demo/pages/', import.meta.url);
mkdirSync(out, {recursive: true});
const browser = await chromium.launch({executablePath});
const context = await browser.newContext({
	viewport: {width: 1600, height: 900},
	deviceScaleFactor: 2,
	colorScheme: 'dark',
	userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
});
for (const page of PAGES) {
	if (only.length && !only.includes(page.name)) continue;
	const url = page.url.replace('$DASH', DASH).replace('$SCAN', SCAN);
	const p = await context.newPage();
	await p.goto(url, {waitUntil: 'networkidle', timeout: 60000}).catch(() => {});
	await p.waitForTimeout(2500);
	for (let i = 0; i < 12 && /moment|verification|Just a/i.test(await p.title()); i++) await p.waitForTimeout(2500);
	if (/moment|verification|Just a/i.test(await p.title())) console.log(page.name, 'still behind a bot check');
	const cookie = p.getByText('Got it!', {exact: true}).first();
	if (await cookie.isVisible().catch(() => false)) await cookie.click().catch(() => {});
	await p.waitForTimeout(400);
	for (const click of page.click ?? []) {
		await p.getByText(click, {exact: false}).first().click().catch((e) => console.log(page.name, 'click failed', click, e.message.slice(0, 60)));
		await p.waitForTimeout(2500);
	}
	await p.evaluate(() => window.scrollTo(0, 0));
	await p.waitForTimeout(500);
	const height = Math.min(page.height ?? 2400, await p.evaluate(() => document.documentElement.scrollHeight));
	const boxes = {};
	for (const [key, target] of Object.entries(page.targets ?? {})) {
		// "css:<selector>", "up<N>:<text>" (the text's Nth ancestor), or plain text.
		const up = /^up(\d):(.*)$/.exec(target);
		const loc = target.startsWith('css:')
			? p.locator(target.slice(4)).first()
			: up
				? p.getByText(up[2], {exact: false}).first().locator(`xpath=${Array(Number(up[1])).fill('..').join('/')}`)
				: p.getByText(target, {exact: false}).first();
		const box = await loc.boundingBox().catch(() => null);
		if (!box) console.log(page.name, 'missing target', key, target);
		else {
			const scrollY = await p.evaluate(() => window.scrollY);
			boxes[key] = {x: box.x, y: box.y + scrollY, w: box.width, h: box.height};
		}
	}
	await p.evaluate(() => window.scrollTo(0, 0));
	await p.screenshot({path: new URL(`${page.name}.jpg`, out).pathname, type: 'jpeg', quality: 90, fullPage: true, clip: {x: 0, y: 0, width: 1600, height}});
	writeFileSync(new URL(`${page.name}.json`, out), JSON.stringify({name: page.name, url, width: 1600, height, scale: 2, boxes}, null, '\t') + '\n');
	console.log(page.name, height, Object.keys(boxes).join(','));
	await p.close();
}
await browser.close();
