/**
 * Some tools now charge with x402 (protocol version 2, MCP transport): an
 * unpaid call gets an error result carrying the payment requirements, and a
 * paid call carries its payment in _meta["x402/payment"] and gets the
 * settlement back in _meta["x402/payment-response"]. The agent pays in USDC
 * on Arbitrum Sepolia with the exact scheme (an EIP-3009 authorization it
 * signs), within its limits. The stand-in servers here check each signature
 * the way a facilitator would, so nothing leaves this machine.
 *
 * x402 over MCP: https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md
 */
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type Address, type Hex, getAddress, keccak256, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

import { BriefAgent } from "../src/agent.js";
import { buildBrief } from "../src/brief.js";

const ARBITRUM_SEPOLIA = "eip155:421614";
const BASE_SEPOLIA = "eip155:84532";
/** Circle's USDC on Arbitrum Sepolia and on Base Sepolia. */
const USDC = getAddress("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
const BASE_USDC = getAddress("0x036cbd53842c5426634e7929541ec2318f3dcf7e");
/** Another token on Arbitrum Sepolia that signs the same way. */
const OTHER_TOKEN = getAddress("0x1111111111111111111111111111111111111111");
const PAYMENT = "x402/payment";
const PAYMENT_RESPONSE = "x402/payment-response";

const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

interface Requirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

interface Authorization {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
}

interface PaymentPayload {
  x402Version: number;
  accepted: Requirements;
  payload: { signature: Hex; authorization: Authorization };
}

/** Where a price may be paid: Arbitrum Sepolia USDC (the only one the agent may use), Base Sepolia USDC, or another token. */
type Offer = "arbitrum-usdc" | "base-usdc" | "arbitrum-other-token";

const payee = privateKeyToAccount(generatePrivateKey()).address;
const payerKey = generatePrivateKey();
const payer = privateKeyToAccount(payerKey).address;
const now = () => Math.floor(Date.now() / 1000);

function requirement(offer: Offer, amount: string): Requirements {
  const [network, asset, chainName] = offer === "base-usdc" ? [BASE_SEPOLIA, BASE_USDC, "USDC"] : [ARBITRUM_SEPOLIA, offer === "arbitrum-usdc" ? USDC : OTHER_TOKEN, offer === "arbitrum-usdc" ? "USD Coin" : "Other Token"];
  return { scheme: "exact", network, amount, asset, payTo: payee, maxTimeoutSeconds: 300, extra: { name: chainName, version: "2" } };
}

/**
 * A stand-in MCP server with paid tools. It answers an unpaid call with the
 * payment requirements, and runs a paid call only for a valid payment: exact,
 * the full price, to the payee, signed by the payer under the token's EIP-712
 * domain, inside its validity window, with a fresh nonce. It records every
 * payment it receives, and settles only after the tool succeeds.
 */
class PaidServer {
  readonly received: PaymentPayload[] = [];
  readonly settled: Array<{ tool: string; amount: string; transaction: Hex }> = [];
  failSettlement = false;
  askAgain = false;
  private readonly live: McpServer[] = [];
  private readonly nonces = new Set<string>();

  constructor(
    private readonly name: string,
    private readonly tools: ReadonlyArray<{ name: string; price?: string; offers?: readonly Offer[]; answer: (ticker: string) => string | undefined }>,
  ) {}

  /** A new connection to this server: the client end of an in-memory transport. */
  async open(): Promise<InMemoryTransport> {
    const server = new McpServer({ name: this.name, version: "1.0.0" });
    for (const tool of this.tools) {
      server.registerTool(tool.name, { description: tool.name, inputSchema: { ticker: z.string() } }, async ({ ticker }, extra) => {
        const run = (): CallToolResult => {
          const answer = tool.answer(ticker);
          return answer === undefined ? { isError: true, content: [{ type: "text", text: `Unknown ticker ${ticker}.` }] } : { content: [{ type: "text", text: answer }] };
        };
        if (tool.price === undefined) return run();
        const accepts = (tool.offers ?? ["arbitrum-usdc"]).map((o) => requirement(o, tool.price as string));
        const required = (error: string, settlement?: Record<string, unknown>): CallToolResult => {
          const body = { x402Version: 2, error, resource: { url: `mcp://tool/${tool.name}`, description: tool.name, mimeType: "application/json" }, accepts };
          return { isError: true, structuredContent: body, content: [{ type: "text", text: JSON.stringify(body) }], ...(settlement === undefined ? {} : { _meta: { [PAYMENT_RESPONSE]: settlement } }) };
        };
        const payment = extra._meta?.[PAYMENT] as PaymentPayload | undefined;
        if (payment === undefined) return required("Payment required");
        this.received.push(payment);
        const problem = await this.check(payment, accepts);
        if (problem !== undefined || this.askAgain) return required(problem ?? "invalid_payment");
        const result = run();
        if (result.isError === true) return result;
        if (this.failSettlement) return required("settlement failed", { success: false, errorReason: "insufficient_funds", transaction: "", network: ARBITRUM_SEPOLIA, payer });
        const nonce = payment.payload.authorization.nonce;
        this.nonces.add(nonce.toLowerCase());
        const transaction = keccak256(nonce);
        this.settled.push({ tool: tool.name, amount: payment.payload.authorization.value, transaction });
        return { ...result, _meta: { [PAYMENT_RESPONSE]: { success: true, transaction, network: payment.accepted.network, payer: payment.payload.authorization.from } } };
      });
    }
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    this.live.push(server);
    return client;
  }

  async close(): Promise<void> {
    for (const server of this.live.splice(0)) await server.close();
  }

  reset(): void {
    this.received.length = 0;
    this.settled.length = 0;
    this.failSettlement = false;
    this.askAgain = false;
  }

  private async check(payment: PaymentPayload, accepts: readonly Requirements[]): Promise<string | undefined> {
    if (payment.x402Version !== 2) return "invalid_x402_version";
    const accepted = accepts.find((r) => r.network === payment.accepted?.network && r.asset.toLowerCase() === payment.accepted?.asset?.toLowerCase());
    if (accepted === undefined || payment.accepted.scheme !== "exact") return "unsupported_scheme";
    const { authorization, signature } = payment.payload ?? {};
    if (authorization === undefined || signature === undefined) return "invalid_payload";
    if (authorization.to.toLowerCase() !== payee.toLowerCase()) return "invalid_exact_evm_payload_recipient_mismatch";
    if (authorization.value !== accepted.amount) return "invalid_exact_evm_payload_authorization_value";
    if (BigInt(authorization.validAfter) > BigInt(now()) || BigInt(authorization.validBefore) <= BigInt(now())) return "invalid_exact_evm_payload_authorization_valid_window";
    if (this.nonces.has(authorization.nonce.toLowerCase())) return "invalid_exact_evm_payload_authorization_nonce_used";
    const chainId = Number(accepted.network.split(":")[1]);
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: { name: accepted.extra.name, version: accepted.extra.version, chainId, verifyingContract: getAddress(accepted.asset) },
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
      signature,
    }).catch(() => false);
    return valid ? undefined : "invalid_exact_evm_payload_signature";
  }
}

const known = (text: string) => (ticker: string) => (ticker === "ACME" ? text : undefined);

describe("the agent pays for x402 tools within its limits", () => {
  // Tools list Base Sepolia first, as a server may: the agent must still pay on Arbitrum Sepolia.
  const market = new PaidServer("market", [
    { name: "get_quote", price: "20000", offers: ["base-usdc", "arbitrum-usdc"], answer: known("ACME 41.20 USD, +1.3% today") },
    { name: "get_order_book", price: "500000", answer: known("ACME bid 41.19 / ask 41.21") },
    { name: "get_base_only_quote", price: "10000", offers: ["base-usdc"], answer: known("ACME 41.20 USD") },
    { name: "get_token_quote", price: "10000", offers: ["arbitrum-other-token"], answer: known("ACME 41.20 USD") },
    { name: "get_status", answer: () => "market open" },
  ]);
  const filings = new PaidServer("filings", [{ name: "get_filing_summary", price: "50000", answer: known("10-Q for Q2: revenue up 8%") }]);
  const news = new PaidServer("news", [{ name: "search_news", answer: (t) => `- ${t} opens a plant in Ohio` }]);
  const servers = { market, filings, news };
  const saved: Record<string, string | undefined> = {};
  const ENV = { PAYER_PRIVATE_KEY: payerKey, MAX_PRICE_PER_CALL: "0.10", BUDGET: "1.00" };
  const agents: BriefAgent[] = [];

  const setEnv = (env: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(env)) {
      if (!(name in saved)) saved[name] = process.env[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };

  /** A new agent on fresh transports to the three servers, with the given environment. */
  const connect = async (env: Record<string, string | undefined> = {}): Promise<BriefAgent> => {
    setEnv({ ...ENV, ...env });
    const transports: Record<string, InMemoryTransport> = {};
    for (const [name, s] of Object.entries(servers)) transports[name] = await s.open();
    const agent = await BriefAgent.connect(transports);
    agents.push(agent);
    return agent;
  };
  const received = () => market.received.length + filings.received.length + news.received.length;

  beforeEach(() => {
    for (const s of Object.values(servers)) s.reset();
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.close();
    for (const s of Object.values(servers)) await s.close();
  });

  after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("calls free tools as before, paying nothing", async () => {
    const agent = await connect();
    assert.deepEqual(await agent.callTool("market", "get_status", { ticker: "ACME" }), { ok: true, text: "market open" });
    assert.equal(received(), 0);
    assert.deepEqual(agent.spending(), { budget: "1000000", spent: "0", remaining: "1000000", payments: [] });
  });

  test("pays a priced tool once, in USDC on Arbitrum Sepolia, and gets its answer", async () => {
    const agent = await connect();
    const output = await agent.callTool("market", "get_quote", { ticker: "ACME" });
    assert.equal(output.ok, true, JSON.stringify(output));
    assert.ok(output.ok);
    assert.equal(output.text, "ACME 41.20 USD, +1.3% today");
    assert.equal(market.received.length, 1);
    const [payment] = market.received;
    assert.equal(payment?.accepted.network, ARBITRUM_SEPOLIA);
    assert.equal(payment?.accepted.asset.toLowerCase(), USDC.toLowerCase());
    assert.equal(payment?.payload.authorization.from.toLowerCase(), payer.toLowerCase());
    const [settled] = market.settled;
    assert.ok(settled !== undefined);
    assert.deepEqual((output as { payment?: unknown }).payment, { amount: "20000", transaction: settled.transaction });
    assert.deepEqual(agent.spending(), { budget: "1000000", spent: "20000", remaining: "980000", payments: [{ server: "market", tool: "get_quote", amount: "20000", transaction: settled.transaction }] });
  });

  test("keeps one budget across servers", async () => {
    const agent = await connect();
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, true);
    assert.equal((await agent.callTool("filings", "get_filing_summary", { ticker: "ACME" })).ok, true);
    const spending = agent.spending();
    assert.equal(spending.spent, "70000");
    assert.equal(spending.remaining, "930000");
    assert.deepEqual(spending.payments.map((p) => `${p.server}.${p.tool}:${p.amount}`), ["market.get_quote:20000", "filings.get_filing_summary:50000"]);
  });

  test("refuses, without paying, a tool that costs more than MAX_PRICE_PER_CALL", async () => {
    const agent = await connect();
    const output = await agent.callTool("market", "get_order_book", { ticker: "ACME" });
    assert.equal(output.ok, false);
    assert.equal(received(), 0, "nothing is signed for a price above the limit");
    assert.equal(agent.spending().spent, "0");
  });

  test("pays nothing to a tool that takes no USDC on Arbitrum Sepolia", async () => {
    const agent = await connect();
    assert.equal((await agent.callTool("market", "get_base_only_quote", { ticker: "ACME" })).ok, false);
    assert.equal((await agent.callTool("market", "get_token_quote", { ticker: "ACME" })).ok, false);
    assert.equal(received(), 0);
    assert.equal(agent.spending().spent, "0");
  });

  test("stops paying when the budget is spent", async () => {
    const agent = await connect({ BUDGET: "0.05" });
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, true);
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, true);
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, false);
    assert.equal(market.received.length, 2, "the third call is not paid");
    assert.deepEqual({ spent: agent.spending().spent, remaining: agent.spending().remaining }, { spent: "40000", remaining: "10000" });
  });

  test("never overspends the budget with calls made at the same time", async () => {
    const agent = await connect({ BUDGET: "0.05" });
    const outputs = await Promise.all(Array.from({ length: 5 }, () => agent.callTool("market", "get_quote", { ticker: "ACME" })));
    assert.equal(outputs.filter((o) => o.ok).length, 2);
    assert.equal(market.received.length, 2, "only what the budget covers is signed");
    assert.equal(agent.spending().spent, "40000");
  });

  test("spends nothing on a tool that fails after being paid", async () => {
    const agent = await connect();
    const output = await agent.callTool("market", "get_quote", { ticker: "ZZZ" });
    assert.deepEqual(output, { ok: false, error: "Unknown ticker ZZZ." });
    assert.equal(market.received.length, 1);
    assert.equal(market.settled.length, 0);
    assert.equal(agent.spending().spent, "0");
  });

  test("spends nothing when the settlement fails, and gives the budget back", async () => {
    const agent = await connect({ BUDGET: "0.02" });
    market.failSettlement = true;
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, false);
    assert.equal(market.received.length, 1, "a failed settlement is not paid again");
    assert.equal(agent.spending().spent, "0");
    market.failSettlement = false;
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, true, "the budget the failed call held is free again");
    assert.equal(agent.spending().spent, "20000");
  });

  test("pays at most once per call, even when the tool asks again", async () => {
    const agent = await connect();
    market.askAgain = true;
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, false);
    assert.equal(market.received.length, 1);
    assert.equal(agent.spending().spent, "0");
  });

  test("ends the brief with what it paid", async () => {
    const agent = await connect();
    const brief = await buildBrief(agent, "acme");
    assert.match(brief, /## Quote\n\nACME 41\.20 USD, \+1\.3% today\n/);
    assert.match(brief, /## Latest filing\n\n10-Q for Q2: revenue up 8%\n/);
    assert.match(brief, /## News\n\n- ACME opens a plant in Ohio\n/);
    assert.ok(brief.endsWith("\nPaid 0.07 USDC for 2 tool calls.\n"), brief);
  });

  test("pays nothing without any payment settings", async () => {
    const agent = await connect({ PAYER_PRIVATE_KEY: undefined, MAX_PRICE_PER_CALL: undefined, BUDGET: undefined });
    assert.equal((await agent.callTool("market", "get_quote", { ticker: "ACME" })).ok, false);
    assert.equal((await agent.callTool("market", "get_status", { ticker: "ACME" })).ok, true);
    assert.equal(received(), 0);
    assert.deepEqual(agent.spending(), { budget: "0", spent: "0", remaining: "0", payments: [] });
  });

  test("reads its key and limits when it connects, and refuses bad or partial ones", async () => {
    const bad: Array<Record<string, string | undefined>> = [
      { PAYER_PRIVATE_KEY: undefined },
      { PAYER_PRIVATE_KEY: "0x1234" },
      { PAYER_PRIVATE_KEY: payerKey.slice(2) },
      { MAX_PRICE_PER_CALL: undefined },
      { MAX_PRICE_PER_CALL: "-0.10" },
      { MAX_PRICE_PER_CALL: "0.0000001" },
      { MAX_PRICE_PER_CALL: "ten cents" },
      { BUDGET: undefined },
      { BUDGET: "0" },
      { BUDGET: "1e3" },
    ];
    for (const env of bad) {
      await assert.rejects(connect(env), `${JSON.stringify(env)} must stop the agent from connecting`);
    }
    const agent = await connect({ MAX_PRICE_PER_CALL: "0.5", BUDGET: "2" });
    assert.equal(agent.spending().budget, "2000000");
    assert.equal((await agent.callTool("market", "get_order_book", { ticker: "ACME" })).ok, true, "0.50 is within a 0.5 per-call limit");
  });
});
