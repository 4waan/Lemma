// Unit economics from the repository's own formulas (docs/economic-gates.md):
//   maxPriceFor(S, C, g) = min(floor(0.3 S), S - g - ceil(0.25 C))
//   buyer all-in reduction = (S - P - g) / C
//   provider margin per resolution = P (1 - q) - g_provider - K / N
//   break-even volume N* = K / (P (1 - q) - g_provider)
// Amounts in USDC. Everything here is MODELED from ASSUMED inputs unless noted.
// This script backs section 10 of docs/business-model.md. It has no dependencies:
//   node docs/business-model/unit-econ.mjs
// Floating point appears only in modeled figures. Table A's price ceilings and margins use
// integer atomic USDC, like the product code.
const usd = (n) => (Math.round(n * 1000) / 1000).toFixed(3);
const pct = (n) => `${(n * 100).toFixed(0)}%`;

// Table A works in atomic USDC (6 decimals, bigint) so that ceilings and margins are exact.
// The ceiling uses the same integer rule as maxPriceFor in packages/core/src/pricing.ts:
// min(floor(3 S / 10), S - g - ceil(C / 4)), and 0 when that is not positive.
const atomic = (usdc) => BigInt(Math.round(usdc * 1e6));
const maxPriceAtomic = (s, c, gas) => {
  if (s <= 0n || c <= 0n) return 0n;
  const saleCap = (s * 3n) / 10n;
  const targetCap = s - gas - (c + 3n) / 4n;
  const cap = saleCap < targetCap ? saleCap : targetCap;
  return cap > 0n ? cap : 0n;
};
// An exact amount with at least three decimals: a ceiling is never shown above the cap.
const exact = (a) => {
  const sign = a < 0n ? "−" : "";
  const abs = a < 0n ? -a : a;
  const text = `${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
  return sign + text.replace(/(\.\d{3}\d*?)0+$/, "$1");
};
const ceilDiv = (n, d) => (n + d - 1n) / d;

console.log("## A. The worked example and what happens as models get cheaper\n");
console.log("Ceilings and margins are exact (atomic USDC); nothing in this table is rounded up.\n");
console.log("| Scenario | C | S | g | Ceiling P | Buyer all-in cut at P | Provider margin before evidence (q=0.10) | N* at K=30 | N* at K=150 |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
const rows = [
  ["Worked example (docs)", 2.5, 1.3, 0.01],
  ["Chain cost measured at 0.03", 2.5, 1.3, 0.03],
  ["Model prices halve once", 1.25, 0.65, 0.03],
  ["Model prices halve twice", 0.625, 0.325, 0.03],
  ["Bigger task, same ratio", 10, 5.2, 0.03],
  ["Weak saving (S = 0.3 C)", 2.5, 0.75, 0.03],
];
for (const [name, C, S, g] of rows) {
  const c = atomic(C), s = atomic(S), gas = atomic(g);
  const p = maxPriceAtomic(s, c, gas);
  if ((p * 9n) % 10n !== 0n) throw new Error(`${name}: the margin is not exact in atomic USDC`);
  const margin = (p * 9n) / 10n - gas; // q = 0.10
  const cut = p > 0n ? Number(s - p - gas) / Number(c) : 0;
  const nstar = (K) => (margin > 0n ? ceilDiv(atomic(K), margin).toString() : "never");
  console.log(`| ${name} | ${exact(c)} | ${exact(s)} | ${exact(gas)} | ${p > 0n ? exact(p) : "none (preview only)"} | ${p > 0n ? pct(cut) : "–"} | ${p > 0n ? exact(margin) : "–"} | ${p > 0n ? nstar(30) : "–"} | ${p > 0n ? nstar(150) : "–"} |`);
}

console.log("\n## B. Revenue needed from the agent-paid unit alone\n");
console.log("| Lemma's share per resolution | Resolutions per month for $10k/month | For $100k/month |");
console.log("| --- | --- | --- |");
for (const [label, share] of [["Lemma is the provider: keeps P = 0.39", 0.39], ["Marketplace fee 10% of P = 0.039", 0.039], ["Marketplace fee 20% of P = 0.078", 0.078]]) {
  console.log(`| ${label} | ${Math.ceil(10000 / share).toLocaleString("en-US")} | ${Math.ceil(100000 / share).toLocaleString("en-US")} |`);
}

console.log("\n## C. Contribution per resolution, agent-paid unit (Lemma as provider)\n");
const P = 0.39, q = 0.1, g = 0.03, facil = 0.001, support = 0.02, infra = 0.005;
const lines = [
  ["Price P", P],
  ["Refunds: q × P", -(q * P)],
  ["Chain cost g (four actions, measured later)", -g],
  ["Facilitator fee (hosted tier, if used)", -facil],
  ["Infrastructure per resolution (server, database, amortized)", -infra],
  ["Support and evaluator time per resolution (amortized)", -support],
];
let total = 0;
console.log("| Line | USDC |");
console.log("| --- | --- |");
for (const [k, v] of lines) { total += v; console.log(`| ${k} | ${v >= 0 ? "" : "−"}${usd(Math.abs(v))} |`); }
console.log(`| **Contribution before evidence** | **${usd(total)}** |`);
for (const K of [30, 150, 600]) for (const N of [50, 200, 1000]) {
  console.log(`| Evidence K=${K} spread over N=${N} sales | −${usd(K / N)} → contribution ${usd(total - K / N)} |`);
}

console.log("\n## D. A team plan, per seat per month\n");
for (const [seats, fee, resolutionsPerSeat] of [[10, 15, 2], [10, 25, 4], [50, 15, 3], [50, 25, 6]]) {
  const revenue = seats * fee, res = seats * resolutionsPerSeat, chain = res * g, evidenceBudget = revenue * 0.4;
  console.log(`- ${seats} seats at $${fee}: revenue $${revenue}/month; ${res} resolutions; chain cost $${usd(chain)}; if 40% of revenue funds evidence, that pays for ${(evidenceBudget / 150).toFixed(1)} benchmarks at K=150 per month, or ${(evidenceBudget / 600).toFixed(1)} at K=600.`);
}

console.log("\n## E. A sponsored release\n");
for (const [V, v, adoptions, K] of [[2500, 0, 200, 600], [1500, 1, 500, 600], [5000, 0.5, 2000, 600]]) {
  const revenue = V + v * adoptions, cost = K + adoptions * (g + infra + support);
  console.log(`- Vendor pays $${V} per release version + $${v} per adoption; ${adoptions} adoptions; evidence K=$${K}: revenue $${revenue}, cost $${usd(cost)}, contribution $${usd(revenue - cost)} (${pct((revenue - cost) / revenue)} margin).`);
}

// ---- Warranty pricing (table F) and revenue targets (table G). ----

console.log("\n## F. Warranty priced like insurance, from a 90% lower confidence bound\n");
// Wilson lower bound at 90% two-sided (z = 1.6449), the statistic the planned confidence engine uses.
// Floats here are a model only. The engine uses integer WAD math and a 30-day half-life; here every
// outcome is treated as recent with weight 1. W is the warranty amount (the price in the MVP).
const z = 1.644853626951472;
const wilsonLower = (passes, n) => {
  if (n === 0) return 0;
  const p = passes / n, z2n = (z * z) / n;
  const center = p + z2n / 2, rad = z * Math.sqrt((p * (1 - p)) / n + z2n / (4 * n));
  return Math.max(0, (center - rad) / (1 + z2n));
};
const W = 0.39, theta = 0.5;
console.log("| History | Passes / runs | Point pass rate | 90% lower bound | Failure rate used | Expected refund (W = 0.39) | Premium (50% load) | Premium / P |");
console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
for (const [label, passes, n] of [
  ["Benchmark prior only", 3, 3],
  ["Prior + 30 outcomes", 30, 33],
  ["Prior + 100 outcomes", 98, 103],
  ["Prior + 500 outcomes", 478, 503],
  ["Prior + 2,000 outcomes", 1903, 2003],
]) {
  const lb = wilsonLower(passes, n), qhat = 1 - lb, loss = qhat * W, prem = loss * (1 + theta);
  console.log(`| ${label} | ${passes} / ${n} | ${pct(passes / n)} | ${(lb * 100).toFixed(1)}% | ${(qhat * 100).toFixed(1)}% | ${usd(loss)} | ${usd(prem)} | ${pct(prem / W)} |`);
}
const capital = (rate, days) => W * rate * (days / 365);
console.log(`\nCost of capital for the reserved bond over a 72-hour claim window at 10% a year: ${capital(0.1, 3).toFixed(5)} USDC per resolution (W = 0.39).`);

console.log("\n## G. What it takes to reach a revenue target, by model\n");
// Units needed per month = target / revenue per unit. Revenue, not contribution: sections C and E give costs.
console.log("| Model and assumed price | Revenue per unit (USD) | Units per month for 10,000 | For 100,000 |");
console.log("| --- | --- | --- | --- |");
for (const [label, unit] of [
  ["Agent-paid resolution at 0.39", 0.39],
  ["10% marketplace fee on 0.39", 0.039],
  ["Team seat at 25 a month", 25],
  ["Evidence fee at 999 per release version", 999],
  ["Sponsored release at 2,500 per version", 2500],
  ["Badge at 5,000 per release per year (monthly)", 5000 / 12],
]) {
  console.log(`| ${label} | ${usd(unit)} | ${Math.ceil(10000 / unit).toLocaleString("en-US")} | ${Math.ceil(100000 / unit).toLocaleString("en-US")} |`);
}
