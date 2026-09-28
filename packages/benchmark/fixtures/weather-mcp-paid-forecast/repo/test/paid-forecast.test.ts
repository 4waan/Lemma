/**
 * get_forecast costs 0.01 USDC, paid with x402 (protocol version 2, MCP
 * transport) in USDC on Arbitrum Sepolia with the exact scheme. The payer
 * here signs a real EIP-3009 authorization, and a local stand-in facilitator
 * checks it the way a real one would, so nothing leaves this machine.
 *
 * x402 over MCP: https://github.com/coinbase/x402/blob/main/specs/transports-v2/mcp.md
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Address, type Hex, getAddress, keccak256, verifyTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createServer } from "../src/server.js";

const NETWORK = "eip155:421614";
const CHAIN_ID = 421614;
/** Circle's USDC on Arbitrum Sepolia, and the EIP-712 domain its transferWithAuthorization is signed under. */
const USDC = getAddress("0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d");
const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC } as const;
/** 0.01 USDC in atomic units (6 decimals). */
const PRICE = "10000";
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

const SEATTLE = { latitude: 47.6062, longitude: -122.3321 };
const NOWHERE = { latitude: 0, longitude: 0 };

interface Requirements {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

interface PaymentRequired {
  x402Version: number;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: Requirements[];
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
  resource: PaymentRequired["resource"];
  accepted: Requirements;
  payload: { signature: Hex; authorization: Authorization };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

const payee = privateKeyToAccount(generatePrivateKey()).address;
const payer = privateKeyToAccount(generatePrivateKey());
const now = () => Math.floor(Date.now() / 1000);

/**
 * A stand-in x402 facilitator (GET /supported, POST /verify, POST /settle).
 * It accepts only an exact USDC payment of the price to the payee on Arbitrum
 * Sepolia, signed by the payer, inside its validity window, with a nonce that
 * has not settled before. It records every verify and settle in order.
 */
class Facilitator {
  readonly calls: Array<"verify" | "settle"> = [];
  failSettlement = false;
  private readonly settled = new Set<string>();
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createHttpServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://facilitator").pathname;
    if (req.method === "GET" && path === "/supported") {
      return reply(200, { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: { "eip155:*": [payee] } });
    }
    if (req.method !== "POST" || (path !== "/verify" && path !== "/settle")) return reply(404, { error: "not found" });
    let body: { x402Version?: unknown; paymentPayload?: PaymentPayload; paymentRequirements?: Requirements };
    try {
      let text = "";
      for await (const chunk of req) text += String(chunk);
      body = JSON.parse(text) as typeof body;
    } catch {
      return reply(400, { error: "invalid JSON" });
    }
    const step = path === "/verify" ? "verify" : "settle";
    this.calls.push(step);
    const payerAddress = body.paymentPayload?.payload?.authorization?.from;
    const problem = await this.check(body.x402Version, body.paymentPayload, body.paymentRequirements);
    if (step === "verify") return reply(200, problem === undefined ? { isValid: true, payer: payerAddress } : { isValid: false, invalidReason: problem, payer: payerAddress });
    if (problem !== undefined) return reply(200, { success: false, errorReason: problem, transaction: "", network: NETWORK, payer: payerAddress });
    if (this.failSettlement) return reply(200, { success: false, errorReason: "insufficient_funds", transaction: "", network: NETWORK, payer: payerAddress });
    const nonce = (body.paymentPayload as PaymentPayload).payload.authorization.nonce;
    this.settled.add(nonce.toLowerCase());
    return reply(200, { success: true, transaction: keccak256(nonce), network: NETWORK, payer: payerAddress });
  }

  /** Why a payment is refused, or undefined when it is good for the price. */
  private async check(version: unknown, payment: PaymentPayload | undefined, requirements: Requirements | undefined): Promise<string | undefined> {
    if (version !== 2 || payment?.x402Version !== 2) return "invalid_x402_version";
    if (requirements === undefined || !sameAddress(requirements.payTo, payee) || !sameAddress(requirements.asset, USDC) || requirements.amount !== PRICE) return "invalid_payment_requirements";
    if (requirements.scheme !== "exact" || requirements.network !== NETWORK || payment.accepted?.scheme !== "exact" || payment.accepted?.network !== NETWORK) return "unsupported_scheme";
    const authorization = payment.payload?.authorization;
    const signature = payment.payload?.signature;
    if (authorization === undefined || signature === undefined) return "invalid_payload";
    if (!sameAddress(authorization.to, payee)) return "invalid_exact_evm_payload_recipient_mismatch";
    if (authorization.value !== PRICE) return "invalid_exact_evm_payload_authorization_value";
    if (BigInt(authorization.validAfter) > BigInt(now())) return "invalid_exact_evm_payload_authorization_valid_after";
    if (BigInt(authorization.validBefore) <= BigInt(now())) return "invalid_exact_evm_payload_authorization_valid_before";
    if (this.settled.has(authorization.nonce.toLowerCase())) return "invalid_exact_evm_payload_authorization_nonce_used";
    const valid = await verifyTypedData({
      address: authorization.from,
      domain: USDC_DOMAIN,
      types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature,
    }).catch(() => false);
    return valid ? undefined : "invalid_exact_evm_payload_signature";
  }
}

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/** The x402 PaymentRequired a tool result carries: the same object in structuredContent and as JSON in the first text item. */
function paymentRequiredOf(result: ToolResult): PaymentRequired {
  assert.equal(result.isError, true, "a payment request is an error result");
  const structured = result.structuredContent as PaymentRequired | undefined;
  assert.ok(structured !== undefined, "the payment request is in structuredContent");
  assert.equal(structured.x402Version, 2);
  assert.ok(Array.isArray(structured.accepts), "the payment request lists what it accepts");
  assert.deepEqual(JSON.parse(textOf(result)) as unknown, structured, "the first text item is the same payment request as JSON");
  return structured;
}

function textOf(result: ToolResult): string {
  return result.content.map((c) => c.text ?? "").join("\n");
}

/** What the payer sends: an EIP-3009 authorization of exactly `value` to the payee, signed under USDC's domain. */
async function pay(required: PaymentRequired, value: string = PRICE): Promise<PaymentPayload> {
  const accepted = required.accepts[0];
  assert.ok(accepted !== undefined);
  const authorization: Authorization = {
    from: payer.address,
    to: getAddress(accepted.payTo),
    value,
    validAfter: String(now() - 600),
    validBefore: String(now() + accepted.maxTimeoutSeconds),
    nonce: `0x${randomBytes(32).toString("hex")}`,
  };
  const name = accepted.extra?.["name"];
  const version = accepted.extra?.["version"];
  assert.ok(typeof name === "string" && typeof version === "string", "the requirements name the token's EIP-712 domain");
  const signature = await payer.signTypedData({
    domain: { name, version, chainId: CHAIN_ID, verifyingContract: getAddress(accepted.asset) },
    types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
  });
  return { x402Version: 2, resource: required.resource, accepted, payload: { signature, authorization } };
}

describe("get_forecast costs 0.01 USDC, paid with x402", () => {
  const facilitator = new Facilitator();
  const saved = { payout: process.env["PAYOUT_ADDRESS"], facilitator: process.env["FACILITATOR_URL"] };
  let facilitatorUrl: string;
  let server: McpServer;
  let client: Client;

  const call = async (name: string, args: Record<string, unknown>, payment?: PaymentPayload): Promise<ToolResult> =>
    (await client.callTool({ name, arguments: args, ...(payment === undefined ? {} : { _meta: { [PAYMENT]: payment } }) })) as ToolResult;
  const forecast = (where: { latitude: number; longitude: number }, payment?: PaymentPayload) => call("get_forecast", where, payment);

  before(async () => {
    facilitatorUrl = await facilitator.start();
    process.env["PAYOUT_ADDRESS"] = payee;
    process.env["FACILITATOR_URL"] = facilitatorUrl;
    server = await createServer();
    client = new Client({ name: "paying-agent", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  after(async () => {
    await client?.close();
    await server?.close();
    await facilitator.stop();
    for (const [name, value] of [["PAYOUT_ADDRESS", saved.payout], ["FACILITATOR_URL", saved.facilitator]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    facilitator.calls.length = 0;
    facilitator.failSettlement = false;
  });

  afterEach(() => {
    facilitator.failSettlement = false;
  });

  test("lists both tools and keeps get_alerts free", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_alerts", "get_forecast"]);
    const alerts = await call("get_alerts", { state: "TX" });
    assert.notEqual(alerts.isError, true);
    assert.match(textOf(alerts), /Heat Advisory/);
    assert.deepEqual(facilitator.calls, []);
  });

  test("answers an unpaid call with the payment requirements and no forecast", async () => {
    const result = await forecast(SEATTLE);
    const required = paymentRequiredOf(result);
    assert.equal(required.resource.url, "mcp://tool/get_forecast");
    assert.equal(required.accepts.length, 1);
    const [accepted] = required.accepts;
    assert.ok(accepted !== undefined);
    assert.equal(accepted.scheme, "exact");
    assert.equal(accepted.network, NETWORK);
    assert.equal(accepted.amount, PRICE);
    assert.ok(sameAddress(accepted.asset, USDC), `asset ${accepted.asset} is USDC on Arbitrum Sepolia`);
    assert.ok(sameAddress(accepted.payTo, payee), `payTo ${accepted.payTo} is PAYOUT_ADDRESS`);
    assert.ok(Number.isInteger(accepted.maxTimeoutSeconds) && accepted.maxTimeoutSeconds > 0);
    assert.equal(accepted.extra?.["name"], "USD Coin");
    assert.equal(accepted.extra?.["version"], "2");
    assert.doesNotMatch(textOf(result), /Forecast for/);
    assert.deepEqual(facilitator.calls, []);
  });

  test("runs a paid call once the payment verifies, then settles it and reports the settlement", async () => {
    const payment = await pay(paymentRequiredOf(await forecast(SEATTLE)));
    const result = await forecast(SEATTLE, payment);
    assert.notEqual(result.isError, true, textOf(result));
    assert.match(textOf(result), /^Forecast for Seattle, WA/);
    const settlement = result._meta?.[PAYMENT_RESPONSE] as Record<string, unknown> | undefined;
    assert.ok(settlement !== undefined, "the result carries the settlement in _meta");
    assert.equal(settlement["success"], true);
    assert.equal(settlement["transaction"], keccak256(payment.payload.authorization.nonce));
    assert.equal(settlement["network"], NETWORK);
    assert.ok(sameAddress(settlement["payer"], payer.address));
    assert.deepEqual(facilitator.calls, ["verify", "settle"]);
  });

  test("never settles a payment twice", async () => {
    const payment = await pay(paymentRequiredOf(await forecast(SEATTLE)));
    assert.notEqual((await forecast(SEATTLE, payment)).isError, true);
    facilitator.calls.length = 0;
    const again = await forecast(SEATTLE, payment);
    assert.equal(again.isError, true);
    assert.doesNotMatch(textOf(again), /Forecast for/);
    assert.ok(!facilitator.calls.includes("settle"), "a used payment is not settled again");
  });

  test("refuses a payment for less than the price", async () => {
    const short = await pay(paymentRequiredOf(await forecast(SEATTLE)), String(BigInt(PRICE) - 1n));
    const result = await forecast(SEATTLE, short);
    paymentRequiredOf(result);
    assert.doesNotMatch(textOf(result), /Forecast for/);
    assert.ok(!facilitator.calls.includes("settle"));
  });

  test("does not charge for a forecast that fails", async () => {
    const payment = await pay(paymentRequiredOf(await forecast(NOWHERE)));
    const result = await forecast(NOWHERE, payment);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No forecast for 0, 0/);
    assert.ok(!facilitator.calls.includes("settle"), "a failed call is not settled");
    assert.notEqual((result._meta?.[PAYMENT_RESPONSE] as { success?: unknown } | undefined)?.success, true);
  });

  test("returns no forecast when the settlement fails", async () => {
    const payment = await pay(paymentRequiredOf(await forecast(SEATTLE)));
    facilitator.failSettlement = true;
    const result = await forecast(SEATTLE, payment);
    paymentRequiredOf(result);
    assert.doesNotMatch(textOf(result), /Forecast for/);
    assert.ok(facilitator.calls.includes("settle"));
    assert.notEqual((result._meta?.[PAYMENT_RESPONSE] as { success?: unknown } | undefined)?.success, true);
  });

  test("refuses to start without a valid payout address or facilitator URL", async () => {
    const cases: Array<[string, string | undefined]> = [
      ["PAYOUT_ADDRESS", undefined],
      ["PAYOUT_ADDRESS", "0x1234"],
      ["FACILITATOR_URL", undefined],
      ["FACILITATOR_URL", "not a url"],
    ];
    const setEnv = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    for (const [name, value] of cases) {
      const previous = process.env[name];
      setEnv(name, value);
      try {
        await assert.rejects(async () => {
          await createServer();
        }, `${name}=${value ?? "(unset)"} must stop the server from starting`);
      } finally {
        setEnv(name, previous);
      }
    }
  });
});
