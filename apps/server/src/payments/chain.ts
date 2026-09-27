import { type Address, type Hex32, toAddress } from "@lemma/core";
import { type Hex, type PublicClient, encodeEventTopics, getAddress, numberToHex, parseAbi, parseAbiItem } from "viem";

/**
 * The chain reads the payment path needs, behind one small interface so the
 * reconciler and the receipt verifier are tested without a chain. Nothing on
 * a buyer's request path calls it: the reconciler and the verifier run as
 * background jobs.
 */
export interface PaymentChain {
  /** The latest block: its number and timestamp. */
  head(): Promise<ChainHead>;
  /**
   * USDC `authorizationState(authorizer, nonce)` at `blockNumber`: true once
   * the authorization was used or canceled. Read at a block whose timestamp
   * is at or past the authorization's `validBefore`, false is final: USDC
   * refuses the authorization in every later block.
   */
  authorizationUsed(authorizer: Address, nonce: Hex32, blockNumber: bigint): Promise<boolean>;
  /**
   * What happened to a used authorization, from USDC's `AuthorizationUsed` or
   * `AuthorizationCanceled` log, searched from the last block before
   * `window.from` to the latest block: "unknown" when neither log is found.
   */
  authorizationOutcome(authorizer: Address, nonce: Hex32, window: { readonly from: Date }): Promise<AuthorizationOutcome>;
}

export type AuthorizationOutcome = { readonly kind: "used"; readonly transaction: Hex32 } | { readonly kind: "canceled" } | { readonly kind: "unknown" };

export interface ChainHead {
  readonly number: bigint;
  readonly timestamp: Date;
}

/** EIP-712 signature checks against the chain, so smart-account buyers (ERC-1271, ERC-6492) verify too. */
export interface SignatureVerifier {
  verifyTypedData(parameters: {
    readonly address: Hex;
    readonly domain: { readonly name: string; readonly version: string; readonly chainId: number };
    readonly types: Record<string, ReadonlyArray<{ readonly name: string; readonly type: string }>>;
    readonly primaryType: string;
    readonly message: Record<string, unknown>;
    readonly signature: Hex;
  }): Promise<boolean>;
}

/** The FiatToken v2 (USDC) EIP-3009 surface the reconciler reads. */
export const USDC_AUTHORIZATION_ABI = parseAbi(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);
const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const AUTHORIZATION_CANCELED = parseAbiItem("event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)");

/**
 * Arbitrum makes at most about four blocks a second, so this many blocks per
 * second back from the head is a first guess at a block no later than a given
 * time. It is only a bracket: every guess is checked against the block's own
 * timestamp, widened when it was not early enough, and then narrowed by
 * bisection, so the search start never depends on the real block rate.
 */
const BLOCKS_PER_SECOND_GUESS = 4n;
/**
 * The widest `eth_getLogs` block range asked for, within what RPC providers
 * accept for a filtered query. A range the RPC refuses with a JSON-RPC error
 * is halved, down to a single block, so a provider with a smaller limit is
 * slower, never stuck.
 */
export const LOG_CHUNK_BLOCKS = 10_000n;

/**
 * `PaymentChain` over a viem public client. A log search starts at the last
 * block before `window.from`, found by bisection over block timestamps, and
 * walks forward to the latest block with no cap on the distance, both events
 * in one `eth_getLogs` filter on their indexed authorizer and nonce.
 */
export function viemPaymentChain(client: PublicClient, asset: Address): PaymentChain {
  const token = getAddress(asset);
  const timestampOf = async (blockNumber: bigint) => (await client.getBlock({ blockNumber })).timestamp;
  return {
    async head() {
      const latest = await client.getBlock({ blockTag: "latest" });
      return { number: latest.number, timestamp: new Date(Number(latest.timestamp) * 1000) };
    },
    async authorizationUsed(authorizer, nonce, blockNumber) {
      return client.readContract({ address: token, abi: USDC_AUTHORIZATION_ABI, functionName: "authorizationState", args: [getAddress(authorizer), nonce as Hex], blockNumber });
    },
    async authorizationOutcome(authorizer, nonce, window) {
      const latest = await client.getBlock({ blockTag: "latest" });
      const start = await lastBlockBefore(timestampOf, latest, BigInt(Math.floor(window.from.getTime() / 1000)));
      const [usedTopic, authorizerTopic, nonceTopic] = encodeEventTopics({ abi: [AUTHORIZATION_USED], eventName: "AuthorizationUsed", args: { authorizer: getAddress(authorizer), nonce: nonce as Hex } });
      const [canceledTopic] = encodeEventTopics({ abi: [AUTHORIZATION_CANCELED], eventName: "AuthorizationCanceled" });
      const topics = [[usedTopic, canceledTopic], authorizerTopic ?? null, nonceTopic ?? null] as [Hex[], Hex | null, Hex | null];
      let span = LOG_CHUNK_BLOCKS;
      for (let from = start; from <= latest.number; ) {
        const to = from + span - 1n < latest.number ? from + span - 1n : latest.number;
        let logs: ReadonlyArray<{ readonly topics: readonly Hex[]; readonly transactionHash: Hex | null; readonly removed?: boolean }>;
        try {
          logs = await client.request({ method: "eth_getLogs", params: [{ address: token, topics, fromBlock: numberToHex(from), toBlock: numberToHex(to) }] });
        } catch (error) {
          if (to === from || !isRpcRefusal(error)) throw error;
          span = (to - from + 1n) / 2n;
          continue;
        }
        const live = logs.filter((log) => log.removed !== true && log.transactionHash !== null);
        const used = live.find((log) => log.topics[0]?.toLowerCase() === usedTopic.toLowerCase());
        if (used?.transactionHash) return { kind: "used", transaction: used.transactionHash.toLowerCase() };
        if (live.some((log) => log.topics[0]?.toLowerCase() === canceledTopic?.toLowerCase())) return { kind: "canceled" };
        from = to + 1n;
      }
      return { kind: "unknown" };
    },
  };
}

/**
 * The last block whose timestamp is before `t` (seconds), or block 0. The
 * bracket below it comes from `BLOCKS_PER_SECOND_GUESS` and is doubled until
 * its block really is before `t`; bisection over block timestamps (which never
 * decrease) then finds the boundary, in about log2 of the bracket's width
 * block reads.
 */
export async function lastBlockBefore(timestampOf: (blockNumber: bigint) => Promise<bigint>, latest: { readonly number: bigint; readonly timestamp: bigint }, t: bigint): Promise<bigint> {
  if (latest.timestamp < t) return latest.number;
  let hi = latest.number;
  let back = (latest.timestamp - t + 1n) * BLOCKS_PER_SECOND_GUESS;
  let lo: bigint;
  for (;;) {
    lo = latest.number - back;
    if (lo <= 0n) {
      lo = 0n;
      break;
    }
    if ((await timestampOf(lo)) < t) break;
    hi = lo;
    back *= 2n;
  }
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    if ((await timestampOf(mid)) < t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether the RPC node answered with a JSON-RPC error (a numeric `code` on the
 * error or a cause), as providers do for a block range wider than they serve,
 * rather than failing to answer at all (a timeout or a lost connection, which
 * a narrower range would not fix).
 */
function isRpcRefusal(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === "object" && depth < 8; e = (e as { cause?: unknown }).cause, depth++) {
    if (typeof (e as { code?: unknown }).code === "number") return true;
  }
  return false;
}

/**
 * `SignatureVerifier` over a viem public client: `verifyTypedData` recovers
 * EOA signatures, and checks smart accounts through ERC-1271 or a counterfactual
 * ERC-6492 wrapper with a deployless `eth_call`.
 */
export function viemSignatureVerifier(client: PublicClient): SignatureVerifier {
  return {
    verifyTypedData: (parameters) =>
      client.verifyTypedData({
        address: toAddress(parameters.address) as Hex,
        domain: parameters.domain,
        types: parameters.types,
        primaryType: parameters.primaryType,
        message: parameters.message,
        signature: parameters.signature,
      } as Parameters<PublicClient["verifyTypedData"]>[0]),
  };
}
