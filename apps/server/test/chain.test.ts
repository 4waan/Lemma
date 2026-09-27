import { type Hex, createPublicClient, createWalletClient, custom, decodeFunctionData, encodeErrorResult, keccak256, parseTransaction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";

import { ERC8004_ARBITRUM_SEPOLIA, SecretKey, SendDeadlineError, identityRegistryAbi, isRevert, refusalOf, reputationRegistryAbi, viemReputationChain } from "../src/index.js";

/** What a scripted `eth_call` answers: return data, or a revert with its data, as a node reports it. */
type CallAnswer = { readonly result: Hex } | { readonly revert: Hex };

/**
 * A scripted JSON-RPC node for the viem chain client: it answers what a send
 * asks for (chain id, the simulation, nonce, fees and gas) and records every
 * method, so a test sees exactly what reached the node.
 */
function scriptedNode(over: { readonly onRequest?: (method: string) => void; readonly onCall?: (to: string, data: Hex) => CallAnswer } = {}) {
  const calls: string[] = [];
  const raw: Hex[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    calls.push(method);
    over.onRequest?.(method);
    switch (method) {
      case "eth_chainId":
        return `0x${arbitrumSepolia.id.toString(16)}`;
      case "eth_call": {
        const [call] = params as [{ to: string; data: Hex }];
        const answer = over.onCall?.(call.to.toLowerCase(), call.data) ?? { result: "0x" };
        // How a node reports a revert: JSON-RPC error 3 with the revert data.
        if ("revert" in answer) throw Object.assign(new Error("execution reverted"), { code: 3, data: answer.revert });
        return answer.result;
      }
      case "eth_getTransactionCount":
        return "0x7";
      case "eth_getBlockByNumber":
        return { number: "0x10", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, timestamp: "0x1", baseFeePerGas: "0x5f5e100", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] };
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_estimateGas":
        return "0x30d40";
      case "eth_sendRawTransaction": {
        const [serialized] = params as [Hex];
        raw.push(serialized);
        return keccak256(serialized);
      }
      default:
        throw new Error(`unscripted method ${method}`);
    }
  };
  // No retries, like the server's own transport: every request reaches the script once.
  const transport = custom({ request }, { retryCount: 0 });
  const key = generatePrivateKey();
  const clients = {
    publicClient: createPublicClient({ chain: arbitrumSepolia, transport }),
    walletClient: createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia, transport }),
  };
  const chain = viemReputationChain({ rpcUrl: "http://127.0.0.1:9", key: new SecretKey(key), ...ERC8004_ARBITRUM_SEPOLIA, clients });
  return { chain, calls, raw };
}

const feedback = {
  agentId: 7n,
  value: 100n,
  valueDecimals: 0,
  tag1: "lemma.adoption",
  tag2: "mcp-server.add-payment-gating",
  endpoint: "",
  feedbackURI: "https://lemma.example/api/v1/evidence/0x01/provider",
  feedbackHash: `0x${"11".repeat(32)}`,
} as const;

/** A send's deadline a minute away, on the wall clock, which the tests not about deadlines use as the attester's clock. */
const inAMinute = () => ({ notAfter: new Date(Date.now() + 60_000), clock: () => new Date() });

describe("the viem reputation chain client", () => {
  it("simulates, signs and broadcasts giveFeedback to the reputation registry", async () => {
    const { chain, calls, raw } = scriptedNode();
    const txHash = await chain.giveFeedback(feedback, inAMinute());
    expect(calls.filter((m) => m === "eth_sendRawTransaction")).toHaveLength(1);
    expect(calls.indexOf("eth_call")).toBeLessThan(calls.indexOf("eth_sendRawTransaction"));
    const [serialized] = raw;
    if (serialized === undefined) throw new Error("nothing broadcast");
    expect(txHash).toBe(keccak256(serialized));
    const tx = parseTransaction(serialized);
    expect(tx).toMatchObject({ type: "eip1559", chainId: 421614, nonce: 7, to: ERC8004_ARBITRUM_SEPOLIA.reputationRegistry });
    const call = decodeFunctionData({ abi: reputationRegistryAbi, data: tx.data as Hex });
    expect(call).toEqual({ functionName: "giveFeedback", args: [7n, 100n, 0, "lemma.adoption", "mcp-server.add-payment-gating", "", feedback.feedbackURI, feedback.feedbackHash] });
    // What every feedback file names: the client (the attester's address) and the identity registry.
    expect(chain.attester).toMatch(/^0x[0-9a-f]{40}$/);
    expect(chain.identityRegistry).toBe(ERC8004_ARBITRUM_SEPOLIA.identityRegistry);
  });

  it("sends a resend with the nonce it is given, without asking the node for one", async () => {
    const { chain, calls, raw } = scriptedNode();
    await chain.giveFeedback(feedback, { ...inAMinute(), nonce: 3 });
    expect(calls).not.toContain("eth_getTransactionCount");
    expect(parseTransaction(raw[0] as Hex).nonce).toBe(3);
  });

  it("reports the registry's final refusals by name, and sends nothing for them", async () => {
    const reason = (message: string) => encodeErrorResult({ abi: [{ type: "error", name: "Error", inputs: [{ name: "message", type: "string" }] }], errorName: "Error", args: [message] });
    const cases = [
      { revert: reason("Self-feedback not allowed"), refusal: "SELF_FEEDBACK" },
      { revert: encodeErrorResult({ abi: identityRegistryAbi, errorName: "ERC721NonexistentToken", args: [7n] }), refusal: "NO_SUCH_AGENT" },
      { revert: reason("value too large"), refusal: undefined },
    ] as const;
    for (const { revert, refusal } of cases) {
      const { chain, calls } = scriptedNode({ onCall: () => ({ revert }) });
      const error = await chain.giveFeedback(feedback, inAMinute()).catch((e: unknown) => e);
      expect(isRevert(error)).toBe(true);
      expect(refusalOf(error)).toBe(refusal);
      expect(calls).not.toContain("eth_sendRawTransaction");
    }
    expect(refusalOf(new Error("fetch failed"))).toBeUndefined();
  });

  it("asks the identity registry's isAuthorizedOrOwner whether the attester's feedback would be self-feedback", async () => {
    const answers = [
      { answer: { result: `0x${"0".repeat(63)}1` as Hex }, refusal: "SELF_FEEDBACK" },
      { answer: { result: `0x${"0".repeat(64)}` as Hex }, refusal: undefined },
      { answer: { revert: encodeErrorResult({ abi: identityRegistryAbi, errorName: "ERC721NonexistentToken", args: [7n] }) }, refusal: "NO_SUCH_AGENT" },
    ] as const;
    for (const { answer, refusal } of answers) {
      const asked: Array<{ to: string; name: string; args: readonly unknown[] }> = [];
      const { chain } = scriptedNode({
        onCall: (to, data) => {
          const call = decodeFunctionData({ abi: identityRegistryAbi, data });
          asked.push({ to, name: call.functionName, args: (call.args ?? []).map((a) => (typeof a === "string" ? a.toLowerCase() : a)) });
          return answer;
        },
      });
      expect(await chain.feedbackRefusal(7n)).toBe(refusal);
      expect(asked).toEqual([{ to: ERC8004_ARBITRUM_SEPOLIA.identityRegistry, name: "isAuthorizedOrOwner", args: [chain.attester, 7n] }]);
    }
    // Any other revert is the node's problem, not an answer.
    const { chain } = scriptedNode({ onCall: () => ({ revert: "0x" }) });
    await expect(chain.feedbackRefusal(7n)).rejects.toThrow();
  });

  it("reads the deadline on the clock that set it, never the wall clock", async () => {
    // The attester's clock runs a day behind the wall clock: on it, the deadline is still a minute away, so the send goes out.
    const behind = new Date(Date.now() - 86_400_000);
    const slow = scriptedNode();
    await slow.chain.giveFeedback(feedback, { notAfter: new Date(behind.getTime() + 60_000), clock: () => behind });
    expect(slow.calls).toContain("eth_sendRawTransaction");
    // A day ahead: on it the deadline has passed, though the wall clock has not reached it, so nothing goes out.
    const ahead = new Date(Date.now() + 86_400_000);
    const fast = scriptedNode();
    await expect(fast.chain.giveFeedback(feedback, { notAfter: new Date(ahead.getTime() - 1), clock: () => ahead })).rejects.toBeInstanceOf(SendDeadlineError);
    expect(fast.calls).not.toContain("eth_sendRawTransaction");
  });

  it("gives up before the broadcast once the deadline has passed, after the slow reads", async () => {
    // The attester's clock. The node is slow: by the time the gas estimate is back, the deadline has come on that clock.
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    const clock = () => new Date(now);
    const notAfter = new Date(now + 60_000);
    const { chain, calls } = scriptedNode({
      onRequest: (method) => {
        if (method === "eth_estimateGas") now = notAfter.getTime();
      },
    });
    const error = await chain.giveFeedback(feedback, { notAfter, clock }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SendDeadlineError);
    expect(error).toMatchObject({ code: "SEND_DEADLINE" });
    expect(isRevert(error)).toBe(false);
    expect(calls).toContain("eth_estimateGas");
    expect(calls).not.toContain("eth_sendRawTransaction");
    // A deadline already past sends nothing either.
    const second = scriptedNode();
    await expect(second.chain.giveFeedback(feedback, { notAfter: new Date(now - 1), clock })).rejects.toBeInstanceOf(SendDeadlineError);
    expect(second.calls).not.toContain("eth_sendRawTransaction");
  });
});
