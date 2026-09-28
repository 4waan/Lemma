// Every modeled number in the profitability analysis comes from this file.
// Run: node model.mjs  -> writes tables.json; build.mjs inlines each table where report.md
// has a {{T:name}} placeholder. No dependencies. All money is USD; the repository treats
// 1 USDC as 1 USD. Every input below is an assumption unless the comment names its source.
import { writeFileSync } from "node:fs";
// This copy backs docs/profitability-analysis.md. It writes tables.json next to itself when run.

const T = {};
const fmt = (n, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const signed = (n, d = 0) => `${n < 0 ? "−" : ""}${fmt(Math.abs(n), d)}`;
const md = (header, rows) => `| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}`;

// ---------------------------------------------------------------------------------------------
// 1. The agent-paid unit, from the repository's worked example (docs/economic-gates.md) and the
//    earlier revenue report's table C. C, S, P and q are the docs' illustrative values.
// ---------------------------------------------------------------------------------------------
const U = { C: 2.5, S: 1.3, P: 0.39, q: 0.1, g: 0.03, facilitator: 0.001, infra: 0.005, support: 0.02 };
const unitVariable = U.q * U.P + U.g + U.facilitator + U.infra + U.support; // 0.095
const unitContribution = U.P - unitVariable; // 0.295
const buyerNet = U.S - U.P - U.g; // what the buyer keeps per purchase, in tokens: 0.88

// ---------------------------------------------------------------------------------------------
// 2. Evidence cost per release-profile-class. The protocol fixes a 20-run matrix per release
//    version (docs/benchmark-protocol.md). Per-task model costs are the earlier report's research
//    range (0.07 to 13.04 USD per task). Labor hours and the loaded rate are assumptions.
// ---------------------------------------------------------------------------------------------
const HOURLY = 100;
const EV = {
  low: { label: "Low", taskCost: 0.5, newHours: 8, refreshHours: 2, refreshes: 2 },
  mid: { label: "Mid", taskCost: 4.1, newHours: 16, refreshHours: 4, refreshes: 3 },
  high: { label: "High", taskCost: 13.04, newHours: 24, refreshHours: 6, refreshes: 4 },
};
const RUNS = 20;
for (const e of Object.values(EV)) {
  e.modelSpend = e.taskCost * RUNS;
  e.kNew = e.modelSpend + e.newHours * HOURLY;
  e.kRefresh = e.modelSpend + e.refreshHours * HOURLY;
  e.annual = e.kNew + e.refreshes * e.kRefresh;
}
const K = EV.mid; // the planning case

T.evidenceCost = md(
  ["Assumption set", "Model cost per task", "Model spend, 20 runs", "Labor, new release", "`K_new`", "Labor, refresh", "`K_refresh`", "Refreshes a year", "Evidence cost a year"],
  Object.values(EV).map((e) => [e.label, fmt(e.taskCost, 2), fmt(e.modelSpend, 0), `${e.newHours} h`, `**${fmt(e.kNew)}**`, `${e.refreshHours} h`, fmt(e.kRefresh), e.refreshes, `**${fmt(e.annual)}**`]),
);

// Break-even sales per release version, against the docs' K = 30 and the three sets.
const breakEven = (k) => Math.ceil(k / unitContribution);
T.breakEvenSales = md(
  ["Evidence cost", "Value", "Sales to pay it back at 0.295 contribution", "Sales a day if the evidence lasts 90 days"],
  [
    ["Docs' worked example (compute only, cheap model)", "30", fmt(breakEven(30)), fmt(breakEven(30) / 90, 1)],
    ["Low: new release", fmt(EV.low.kNew), fmt(breakEven(EV.low.kNew)), fmt(breakEven(EV.low.kNew) / 90, 1)],
    ["Mid: new release", fmt(EV.mid.kNew), fmt(breakEven(EV.mid.kNew)), fmt(breakEven(EV.mid.kNew) / 90, 1)],
    ["Mid: one refresh", fmt(EV.mid.kRefresh), fmt(breakEven(EV.mid.kRefresh)), fmt(breakEven(EV.mid.kRefresh) / 90, 1)],
    ["High: new release", fmt(EV.high.kNew), fmt(breakEven(EV.high.kNew)), fmt(breakEven(EV.high.kNew) / 90, 1)],
  ],
);

// Evidence cost per adoption against the price, mid case.
T.evidencePerAdoption = md(
  ["Adoptions a year in one profile class", "Evidence cost per adoption (mid, 3,128 a year)", "Against the 0.39 price"],
  [100, 500, 2000, 10000, 20000].map((n) => {
    const per = K.annual / n;
    return [fmt(n), fmt(per, 2), per > U.P ? `${fmt(per / U.P, 1)} times the price` : `${pct(per / U.P)} of the price`];
  }),
);

// ---------------------------------------------------------------------------------------------
// 3. The friction tax: what a buyer spends to be able to pay cents.
// ---------------------------------------------------------------------------------------------
T.friction = md(
  ["Setup time", "Developer cost an hour", "Setup cost", "Purchases to pay it back from token savings (0.88 each)"],
  [[30, 60], [60, 100], [120, 150]].map(([min, rate]) => {
    const cost = (min / 60) * rate;
    return [`${min} min`, fmt(rate), fmt(cost, 0), fmt(Math.ceil(cost / buyerNet))];
  }),
);

// ---------------------------------------------------------------------------------------------
// 4. Warranty operations: capital is cheap, review time is not.
// ---------------------------------------------------------------------------------------------
const bondCapital = U.P * 0.1 * (3 / 365);
T.warrantyOps = md(
  ["Cost line", "Per failure", "Per resolution at q = 10%", "Against the 0.39 price"],
  [
    ["Bond capital, 72-hour window, 10% a year", "–", fmt(bondCapital, 5), pct(bondCapital / U.P, 2)],
    ...[2, 5, 10].map((min) => {
      const perFail = (min / 60) * HOURLY;
      const perRes = U.q * perFail;
      return [`Operator review of a failure, ${min} min at ${HOURLY} an hour`, fmt(perFail, 2), fmt(perRes, 2), `${pct(perRes / U.P)} of the price`];
    }),
    ["Refund itself, q × P", fmt(U.P, 2), fmt(U.q * U.P, 3), pct(U.q)],
  ],
);

// ---------------------------------------------------------------------------------------------
// 5. Unit economics of each revenue model. Prices are assumptions anchored on the comparables in
//    the earlier report (Docker Verified Publisher and Hardened Images, Salesforce review fee,
//    Roadie, Port, Cortex). Evidence uses the mid set.
// ---------------------------------------------------------------------------------------------
const models = [];
const push = (m) => models.push({ ...m, contribution: m.revenue - m.variable, margin: (m.revenue - m.variable) / m.revenue });

push({ code: "A", name: "Agent-paid resolution (today's design)", unit: "one resolution", payer: "agent owner, USDC", revenue: U.P, variable: unitVariable, note: "before evidence" });
push({ code: "B", name: "Marketplace fee of 10% on a 0.39 sale", unit: "one resolution", payer: "external provider", revenue: 0.1 * U.P, variable: U.g + U.infra + U.support, note: "if Lemma pays gas, infrastructure and support" });
const vendorAdoptions = 500;
push({ code: "C", name: "Vendor program: agent-ready certification and upkeep", unit: "one product a year", payer: "integration vendor, invoice", revenue: 12000, variable: K.annual + 0.1 * 12000 + vendorAdoptions * (U.g + U.infra + U.support), note: `evidence ${fmt(K.annual)}, support 10%, ${vendorAdoptions} adoptions` });
push({ code: "D", name: "Evidence fee, one frozen benchmark", unit: "one release version", payer: "provider or vendor, invoice", revenue: 2500, variable: K.kNew + 0.1 * 2500, note: "evidence 1,682, overhead 10%; no upkeep" });
push({ code: "E1", name: "Team plan priced per repository (30 a month, 20 repositories, 2 private integrations)", unit: "one team a year", payer: "engineering team, invoice", revenue: 30 * 20 * 12, variable: 2 * K.annual + 0.1 * 30 * 20 * 12, note: "evidence for 2 integrations, support 10%" });
push({ code: "E2", name: "Team plan priced per maintained integration (500 a month each, 2 integrations, platform fee 200)", unit: "one team a year", payer: "engineering team, invoice", revenue: (500 * 2 + 200) * 12, variable: 2 * K.annual + 0.1 * (500 * 2 + 200) * 12, note: "same evidence and support" });
push({ code: "F", name: "Enterprise deployment with audit trail", unit: "one contract a year", payer: "enterprise, invoice", revenue: 40000, variable: 3 * K.annual + 0.2 * 40000, note: "3 private integrations, support 20%" });
push({ code: "G", name: "Agent-platform partnership (white label)", unit: "one platform a year", payer: "agent vendor, invoice", revenue: 36000, variable: 0.15 * 36000, note: "support 15%; evidence shared with the public catalog" });

T.unitEconomics = md(
  ["Code", "Model", "Unit", "Revenue per unit", "Variable cost per unit", "Contribution", "Margin", "Units a month to cover 10,000 of fixed cost"],
  models.map((m) => [
    m.code,
    m.name,
    m.unit,
    fmt(m.revenue, m.revenue < 10 ? 3 : 0),
    fmt(m.variable, m.variable < 10 ? 3 : 0),
    m.contribution < 0 ? `−${fmt(-m.contribution, 3)}` : fmt(m.contribution, m.contribution < 10 ? 3 : 0),
    m.contribution < 0 ? "negative" : pct(m.margin),
    m.contribution <= 0 ? "never" : m.unit.includes("a year") ? `${fmt(Math.ceil(10000 / (m.contribution / 12)))} customers` : fmt(Math.ceil(10000 / m.contribution)),
  ]),
);

// ---------------------------------------------------------------------------------------------
// 6. Fixed cost bases (monthly), all assumptions.
// ---------------------------------------------------------------------------------------------
const BASES = {
  lean: { label: "Lean: one founder, no salary beyond living costs", people: 8000, infra: 300, chain: 100, tools: 100, legal: 500 },
  small: { label: "Small team: 2.5 FTE", people: 30000, infra: 600, chain: 200, tools: 300, legal: 1700 },
  funded: { label: "Funded: 5 FTE", people: 60000, infra: 1500, chain: 500, tools: 1000, legal: 4000 },
};
for (const b of Object.values(BASES)) b.total = b.people + b.infra + b.chain + b.tools + b.legal;
T.costBases = md(
  ["Cost base", "People", "Infrastructure", "Chain operations (RPC, keys, monitoring)", "Tools", "Legal, audit and insurance (amortized)", "Total a month"],
  Object.values(BASES).map((b) => [b.label, fmt(b.people), fmt(b.infra), fmt(b.chain), fmt(b.tools), fmt(b.legal), `**${fmt(b.total)}**`]),
);

// Customers needed per model to cover each base (recurring models only).
const recurring = models.filter((m) => m.unit.includes("a year") && m.contribution > 0);
T.breakEvenCustomers = md(
  ["Model", "Contribution a month per customer", ...Object.values(BASES).map((b) => `Customers for ${b.label.split(":")[0].toLowerCase()} (${fmt(b.total)} a month)`)],
  recurring.map((m) => {
    const monthly = m.contribution / 12;
    return [`${m.code}: ${m.name.split(" (")[0].split(":")[0]}`, fmt(monthly), ...Object.values(BASES).map((b) => fmt(Math.ceil(b.total / monthly)))];
  }).concat([[
    "A: agent-paid resolutions (units a month)", fmt(unitContribution, 3), ...Object.values(BASES).map((b) => fmt(Math.ceil(b.total / unitContribution))),
  ]]),
);

// ---------------------------------------------------------------------------------------------
// 7. Sensitivity: vendor programs and price against the cost bases.
// ---------------------------------------------------------------------------------------------
const vendorContribution = (price) => price - K.annual - 0.1 * price - vendorAdoptions * (U.g + U.infra + U.support);
T.vendorSensitivity = md(
  ["Vendor programs", ...[6000, 12000, 24000].map((p) => `At ${fmt(p)} a year each: contribution a month`)],
  [2, 4, 8, 12, 20].map((n) => [n, ...[6000, 12000, 24000].map((p) => {
    const monthly = (n * vendorContribution(p)) / 12;
    const covers = monthly >= BASES.small.total ? "covers the small team" : monthly >= BASES.lean.total ? "covers the lean base" : "covers neither";
    return `${fmt(monthly)} (${covers})`;
  })]),
);

T.vendorEvidenceSensitivity = md(
  ["Evidence assumption set", "Evidence cost a year", "Contribution of a 12,000 program", "Margin", "Programs to cover the lean base"],
  Object.values(EV).map((e) => {
    const c = 12000 - e.annual - 1200 - vendorAdoptions * (U.g + U.infra + U.support);
    return [e.label, fmt(e.annual), fmt(c), pct(c / 12000), fmt(Math.ceil(BASES.lean.total / (c / 12)))];
  }),
);

// ---------------------------------------------------------------------------------------------
// 8. Twelve-month scenarios. Month 1 is October 2026. Every count and price is an assumption.
// ---------------------------------------------------------------------------------------------
const SCEN = {
  downside: {
    label: "Downside",
    story: "No vendor signs beyond one paid pilot; one team pays for six months; grants are the main income; the agent-paid rail sees a trickle.",
    vendors: [],
    pilots: [{ month: 4, fee: 1500 }],
    teams: [{ start: 5, end: 10, monthly: 300, releases: 1 }],
    evidenceFees: [],
    enterprise: [],
    platform: [],
    grants: { 2: 20000 },
    agentPaid: (m) => (m >= 4 ? 20 : 0),
  },
  base: {
    label: "Base",
    story: "Three vendor programs and four team customers close over the year; two one-off evidence jobs; grants; a few hundred agent-paid resolutions a month by year end.",
    vendors: [{ start: 4, monthly: 1000 }, { start: 6, monthly: 1000 }, { start: 8, monthly: 1000 }],
    pilots: [],
    teams: [{ start: 5, end: 12, monthly: 600, releases: 1 }, { start: 6, end: 12, monthly: 600, releases: 1 }, { start: 8, end: 12, monthly: 600, releases: 1 }, { start: 10, end: 12, monthly: 600, releases: 1 }],
    evidenceFees: [{ month: 5, fee: 2000 }, { month: 9, fee: 2000 }],
    enterprise: [],
    platform: [],
    grants: { 2: 25000, 8: 15000 },
    agentPaid: (m) => (m >= 3 ? Math.min(300, 50 + (m - 3) * 30) : 0),
  },
  upside: {
    label: "Upside",
    story: "Eight vendor programs at a higher price, ten teams, one enterprise contract, one agent-platform deal from month 7, larger grants, and a thousand agent-paid resolutions a month by year end.",
    vendors: [3, 4, 5, 6, 7, 8, 9, 10].map((start) => ({ start, monthly: 1250 })),
    pilots: [],
    teams: [4, 5, 6, 7, 8, 9, 10, 11, 12, 12].map((start) => ({ start, end: 12, monthly: 900, releases: 1 })),
    evidenceFees: [{ month: 4, fee: 2500 }, { month: 6, fee: 2500 }, { month: 9, fee: 2500 }, { month: 11, fee: 2500 }],
    enterprise: [{ start: 9, annual: 40000, releases: 3 }],
    platform: [{ start: 7, monthly: 3000 }],
    grants: { 2: 30000, 7: 30000 },
    agentPaid: (m) => (m >= 3 ? Math.min(1000, 50 + (m - 3) * 105) : 0),
  },
};
const PUBLIC_RELEASES = 2;

function simulate(s) {
  const months = [];
  for (let m = 1; m <= 12; m++) {
    const r = { vendors: 0, pilots: 0, teams: 0, evidenceFees: 0, enterprise: 0, platform: 0, grants: 0, agentPaid: 0 };
    const c = { evidence: 0, support: 0, agentVariable: 0 };
    // The public catalog's own evidence: first benchmarks in month 1, refreshes each quarter.
    if (m === 1) c.evidence += PUBLIC_RELEASES * K.kNew;
    if (m > 1 && (m - 1) % 3 === 0) c.evidence += PUBLIC_RELEASES * K.kRefresh;
    for (const v of s.vendors) if (m >= v.start) {
      r.vendors += v.monthly; c.support += 0.1 * v.monthly;
      if (m === v.start) c.evidence += K.kNew; else if ((m - v.start) % 3 === 0) c.evidence += K.kRefresh;
    }
    for (const p of s.pilots) if (m === p.month) { r.pilots += p.fee; c.evidence += K.kNew; }
    for (const t of s.teams) if (m >= t.start && m <= t.end) {
      r.teams += t.monthly; c.support += 0.1 * t.monthly;
      if (m === t.start) c.evidence += t.releases * K.kNew; else if ((m - t.start) % 3 === 0) c.evidence += t.releases * K.kRefresh;
    }
    for (const f of s.evidenceFees) if (m === f.month) { r.evidenceFees += f.fee; c.evidence += K.kNew; }
    for (const e of s.enterprise) if (m >= e.start) {
      r.enterprise += e.annual / 12; c.support += 0.2 * (e.annual / 12);
      if (m === e.start) c.evidence += e.releases * K.kNew; else if ((m - e.start) % 3 === 0) c.evidence += e.releases * K.kRefresh;
    }
    for (const p of s.platform) if (m >= p.start) { r.platform += p.monthly; c.support += 0.15 * p.monthly; }
    r.grants += s.grants[m] ?? 0;
    const units = s.agentPaid(m);
    r.agentPaid += units * U.P; c.agentVariable += units * unitVariable;
    const revenue = Object.values(r).reduce((a, b) => a + b, 0);
    const variable = Object.values(c).reduce((a, b) => a + b, 0);
    months.push({ m, r, c, revenue, variable, contribution: revenue - variable, units });
  }
  return months;
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const scenarioRows = [];
const scenarioDetail = {};
for (const [key, s] of Object.entries(SCEN)) {
  const ms = simulate(s);
  const revenue = sum(ms, (x) => x.revenue);
  const recurringRevenue = sum(ms, (x) => x.r.vendors + x.r.teams + x.r.enterprise + x.r.platform);
  const oneOff = sum(ms, (x) => x.r.pilots + x.r.evidenceFees + x.r.grants);
  const agent = sum(ms, (x) => x.r.agentPaid);
  const variable = sum(ms, (x) => x.variable);
  const contribution = revenue - variable;
  const last = ms[11];
  const runRate = (last.r.vendors + last.r.teams + last.r.enterprise + last.r.platform) * 12;
  const perBase = {};
  for (const [bk, b] of Object.entries(BASES)) {
    let cum = 0, minCum = 0, firstPositive = null;
    for (const x of ms) {
      const net = x.contribution - b.total;
      cum += net; if (cum < minCum) minCum = cum;
      if (firstPositive === null && x.contribution - (x.r.grants + x.r.pilots + x.r.evidenceFees) >= b.total) firstPositive = x.m;
    }
    perBase[bk] = { net: contribution - 12 * b.total, cashNeed: -minCum, firstPositive };
  }
  scenarioDetail[key] = { ms, revenue, recurringRevenue, oneOff, agent, variable, contribution, runRate, perBase };
  scenarioRows.push([
    s.label,
    fmt(revenue), fmt(recurringRevenue), fmt(oneOff), fmt(agent), fmt(variable), fmt(contribution), fmt(runRate),
    ...Object.values(perBase).map((p) => `${p.net < 0 ? "−" : ""}${fmt(Math.abs(p.net))}`),
  ]);
}
T.scenarios = md(
  ["Scenario", "Revenue, 12 months", "Recurring", "One-off: grants, pilots, evidence fees", "Agent-paid", "Variable cost", "Contribution", "Recurring run-rate at month 12"],
  scenarioRows.map((r) => r.slice(0, 8)),
);
T.scenarioNet = md(
  ["Scenario", "Net against lean (108,000 a year)", "Cash needed on lean", "First month recurring contribution covers lean", "Net against small team (393,600 a year)", "Cash needed on small team", "First month it covers the small team", "Net against funded (804,000 a year)"],
  Object.entries(scenarioDetail).map(([k, d]) => [
    SCEN[k].label,
    signed(d.perBase.lean.net), fmt(d.perBase.lean.cashNeed), d.perBase.lean.firstPositive ? `month ${d.perBase.lean.firstPositive}` : "not within 12 months",
    signed(d.perBase.small.net), fmt(d.perBase.small.cashNeed), d.perBase.small.firstPositive ? `month ${d.perBase.small.firstPositive}` : "not within 12 months",
    signed(d.perBase.funded.net),
  ]),
);
T.scenarioAssumptions = md(
  ["Scenario", "Vendor programs", "Teams", "Enterprise", "Platform deal", "One-off evidence fees", "Grants", "Agent-paid resolutions, month 12", "Story"],
  Object.values(SCEN).map((s) => [
    s.label,
    s.vendors.length ? `${s.vendors.length} at ${fmt(s.vendors[0].monthly * 12)} a year, from month ${s.vendors[0].start}` : (s.pilots.length ? `one paid pilot at ${fmt(s.pilots[0].fee)}` : "none"),
    s.teams.length ? `${s.teams.length} at ${fmt(s.teams[0].monthly)} a month` : "none",
    s.enterprise.length ? `1 at ${fmt(s.enterprise[0].annual)} a year from month ${s.enterprise[0].start}` : "none",
    s.platform.length ? `1 at ${fmt(s.platform[0].monthly)} a month from month ${s.platform[0].start}` : "none",
    s.evidenceFees.length ? `${s.evidenceFees.length} at ${fmt(s.evidenceFees[0].fee)}` : "none",
    fmt(Object.values(s.grants).reduce((a, b) => a + b, 0)),
    fmt(s.agentPaid(12)),
    s.story,
  ]),
);
// Monthly detail for the base scenario.
const baseMs = scenarioDetail.base.ms;
T.baseMonthly = md(
  ["Month", "Vendors", "Teams", "Evidence fees", "Grants", "Agent-paid", "Revenue", "Evidence cost", "Support", "Contribution", "Net, lean base", "Net, small team"],
  baseMs.map((x) => [x.m, fmt(x.r.vendors), fmt(x.r.teams), fmt(x.r.evidenceFees), fmt(x.r.grants), fmt(x.r.agentPaid), fmt(x.revenue), fmt(x.c.evidence), fmt(x.c.support), signed(x.contribution), signed(x.contribution - BASES.lean.total), signed(x.contribution - BASES.small.total)]),
);

// ---------------------------------------------------------------------------------------------
// 9. Evidence reuse levers, mid case: what each saves per release-profile-class a year.
// ---------------------------------------------------------------------------------------------
const levers = [
  ["Vendor supplies fixtures and acceptance tests; Lemma measures", "New-release labor 16 h to 8 h", 8 * HOURLY, "Labor dominates K. The sponsor knows its SDK; Lemma keeps the measurement."],
  ["Outcomes extend freshness: re-run the paired benchmark only when model prices move", "Refreshes 3 to 1.5 a year", 1.5 * K.kRefresh, "Verified receipts keep the pass-rate claim fresh; the savings claim is re-measured less often."],
  ["Profile classes: one benchmark covers a documented class", "No cost cut; more adoptions per evidence", 0, "Raises adoptions per dollar of evidence instead of cutting the dollar."],
  ["Shared control arm across releases for one task", "Half the control runs on the second release", (RUNS / 4) * K.taskCost, "Compute is a small share of K, so this saves little money but some days."],
  ["Sequential design: stop once the interval clears the threshold", "About 30% fewer runs", 0.3 * K.modelSpend, "Same reason: small in money, useful in time."],
];
T.reuseLevers = md(
  ["Lever", "Effect on the mid assumptions", "Saving a year per release-profile-class", "Share of the 3,128 annual evidence cost", "Why it matters"],
  levers.map(([l, e, s, w]) => [l, e, fmt(s), pct(s / K.annual), w]),
);
const combined = 8 * HOURLY + 1.5 * K.kRefresh + (RUNS / 4) * K.taskCost + 0.3 * K.modelSpend;
T.reuseCombined = `With the first two levers, the mid annual evidence cost falls from ${fmt(K.annual)} to about ${fmt(K.annual - 8 * HOURLY - 1.5 * K.kRefresh)} a year per release-profile-class; with all four cost levers, to about ${fmt(K.annual - combined)}.`;

// ---------------------------------------------------------------------------------------------
// 10. Pricing architecture: a vendor program against the vendor's alternatives.
// ---------------------------------------------------------------------------------------------
T.vendorAnchors = md(
  ["What the vendor pays for today", "Price point", "Source"],
  [
    ["Docker Hardened Images, Select tier: compliance builds with a fix-time promise", "5,000 per repository a year", "earlier report, [RESEARCH]"],
    ["Docker Verified Publisher: badge, ranking, reports", "annual plans by consuming domains (price not published)", "earlier report, [RESEARCH]"],
    ["Salesforce AppExchange security review", "999 per attempt", "earlier report, [RESEARCH]"],
    ["Composio: 200,000 tool calls a month", "29 a month", "earlier report, [RESEARCH]"],
    ["One developer-relations engineer", "about 150,000 a year loaded", "[ASSUMED]"],
    ["A Lemma vendor program at 12,000 a year", "8% of one developer-relations salary", "[MODELED]"],
  ],
);

// Pricing tiers for section 9: cost to serve and margin per offer, from the same inputs.
const adoptionCost = U.g + U.infra + U.support;
const tier = (price, classes, refreshes, supportShare, adoptions) => {
  const evidence = classes * (K.kNew + refreshes * K.kRefresh);
  const cost = evidence + supportShare * price + adoptions * adoptionCost;
  return { cost, margin: (price - cost) / price };
};
const tiers = [
  ["Integration vendor", "Verified", "6,000 a year", "One evidenced public release for one profile class, a badge, two refreshes a year", "A developer-relations sample repository", tier(6000, 1, 2, 0.1, 250)],
  ["Integration vendor", "Maintained", "12,000 a year", "One profile class refreshed on SDK and model changes, breakage alerts, an adoption report", "Docker's 5,000-per-repository maintained tier", tier(12000, 1, 3, 0.1, 500)],
  ["Integration vendor", "Premium", "24,000 a year", "Two profile classes, priority re-benchmarks, a named contact, the attester's ERC-8004 record", "A share of one developer-relations salary", tier(24000, 2, 3, 0.1, 1000)],
  ["Engineering team", "Private catalog", "200 a month, plus 500 a month per maintained integration", "Packaging, benchmark, serving, private outcomes; two integrations assumed", "A platform seat (Roadie 24, Port 30 to 40 a seat)", tier(14400, 2, 3, 0.1, 0)],
  ["Enterprise", "Deployment", "40,000 a year and up", "The server and evaluator inside the boundary, an audit trail, three integrations", "Cortex's median contract of about 75,000; a Backstage plugin bundle at 100,000", tier(40000, 3, 3, 0.2, 0)],
  ["Agent platform", "Partnership", "3,000 a month and up", "Verified reuse shipped natively; the public catalog's evidence", "Building it in-house", tier(36000, 0, 0, 0.15, 0)],
  ["Agent's owner", "The public rail", "At most 30% of the measured saving", "One evidenced patch with a warranty", "Rebuilding it", { cost: unitVariable, margin: unitContribution / U.P }],
];
T.pricingTiers = md(
  ["Payer", "Offer", "Price to test", "What it includes", "Alternative they compare with", "Cost to serve a year (mid evidence)", "Margin"],
  tiers.map(([p, o, pr, inc, alt, t]) => [p, o, pr, inc, alt, t.cost < 10 ? fmt(t.cost, 3) : fmt(t.cost), pct(t.margin)]),
);

// Numbers quoted in the prose.
T.n = {
  unitContribution: fmt(unitContribution, 3),
  unitVariable: fmt(unitVariable, 3),
  buyerNet: fmt(buyerNet, 2),
  kNewMid: fmt(K.kNew),
  kRefreshMid: fmt(K.kRefresh),
  annualMid: fmt(K.annual),
  annualLow: fmt(EV.low.annual),
  annualHigh: fmt(EV.high.annual),
  breakEvenMidNew: fmt(breakEven(K.kNew)),
  breakEvenMidRefresh: fmt(breakEven(K.kRefresh)),
  leanTotal: fmt(BASES.lean.total),
  smallTotal: fmt(BASES.small.total),
  fundedTotal: fmt(BASES.funded.total),
  agentUnitsLean: fmt(Math.ceil(BASES.lean.total / unitContribution)),
  agentUnitsSmall: fmt(Math.ceil(BASES.small.total / unitContribution)),
  vendorContribution12k: fmt(vendorContribution(12000)),
  vendorMargin12k: pct(vendorContribution(12000) / 12000),
  baseRevenue: fmt(scenarioDetail.base.revenue),
  baseRunRate: fmt(scenarioDetail.base.runRate),
  baseCashLean: fmt(scenarioDetail.base.perBase.lean.cashNeed),
  baseCashSmall: fmt(scenarioDetail.base.perBase.small.cashNeed),
  upsideRunRate: fmt(scenarioDetail.upside.runRate),
  upsideRevenue: fmt(scenarioDetail.upside.revenue),
  downsideRevenue: fmt(scenarioDetail.downside.revenue),
  downsideCashLean: fmt(scenarioDetail.downside.perBase.lean.cashNeed),
  reviewPerResolution5: fmt(U.q * (5 / 60) * HOURLY, 2),
};

writeFileSync(new URL("./tables.json", import.meta.url), JSON.stringify(T, null, 1));
for (const [k, v] of Object.entries(T)) if (k !== "n") console.log(`\n### ${k}\n\n${v}\n`);
console.log(JSON.stringify(T.n, null, 1));
