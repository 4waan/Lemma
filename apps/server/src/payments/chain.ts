import { type Address, type Hex32, type PaymentTerms, toAddress } from "@lemma/core";
import { type Hex, type PublicClient, decodeEventLog, encodeEventTopics, getAddress, numberToHex, parseAbi, parseAbiItem } from "viem";

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
   * `window.from` to the latest block. "used" only when the transaction that
   * used it paid `terms`: USDC moved exactly `terms.amount` from the
   * authorizer to `terms.payTo` in the same call. "mismatched" when that
   * transaction moved anything else: EIP-3009 nonces are the signer's to
   * choose, so a buyer can spend the nonce on a transfer of their own, after
   * which the quoted payment can never land. "unknown" when neither log is
   * found.
   */
  authorizationOutcome(authorizer: Address, nonce: Hex32, terms: Pick<PaymentTerms, "payTo" | "amount">, window: { readonly from: Date }): Promise<AuthorizationOutcome>;
}

export type AuthorizationOutcome =
  | { readonly kind: "used"; readonly transaction: Hex32 }
  | { readonly kind: "mismatched" }
  | { readonly kind: "canceled" }
  | { readonly kind: "unknown" };

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
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

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
 * slower, never stuck. Each accepted range doubles the next one again, up to
 * this width: a refusal may be a passing rate limit rather than a range
 * limit, so a few of them never leave a search walking a long range in tiny
 * steps. A provider with a smaller fixed limit costs about one refused
 * request per accepted range.
 */
export const LOG_CHUNK_BLOCKS = 10_000n;

/**
 * `PaymentChain` over a viem public client. A log search starts at the last
 * block before `window.from`, found by bisection over block timestamps, and
 * walks forward to the latest block with no cap on the distance, both events
 * in one `eth_getLogs` filter on their indexed authorizer and nonce. The
 * receipt of the transaction that used the authorization then shows what it
 * paid (`outcomeOfUse`).
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
    async authorizationOutcome(authorizer, nonce, terms, window) {
      const expected = { from: authorizer, to: terms.payTo, value: BigInt(terms.amount) };
      const latest = await client.getBlock({ blockTag: "latest" });
      const start = await lastBlockBefore(timestampOf, latest, BigInt(Math.floor(window.from.getTime() / 1000)));
      const [usedTopic, authorizerTopic, nonceTopic] = encodeEventTopics({ abi: [AUTHORIZATION_USED], eventName: "AuthorizationUsed", args: { authorizer: getAddress(authorizer), nonce: nonce as Hex } });
      const [canceledTopic] = encodeEventTopics({ abi: [AUTHORIZATION_CANCELED], eventName: "AuthorizationCanceled" });
      const topics = [[usedTopic, canceledTopic], authorizerTopic ?? null, nonceTopic ?? null] as [Hex[], Hex | null, Hex | null];
      const usedBy = [usedTopic, topics[1], topics[2]];
      const isThisUse = (log: ReceiptLog) => sameHex(log.address, token) && log.topics.length === usedBy.length && usedBy.every((topic, i) => sameHex(log.topics[i], topic));
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
        if (used?.transactionHash) return outcomeOfUse(client, token, used.transactionHash, isThisUse, expected);
        if (live.some((log) => log.topics[0]?.toLowerCase() === canceledTopic?.toLowerCase())) return { kind: "canceled" };
        from = to + 1n;
        span = span * 2n < LOG_CHUNK_BLOCKS ? span * 2n : LOG_CHUNK_BLOCKS;
      }
      return { kind: "unknown" };
    },
  };
}

type ReceiptLog = { readonly address: string; readonly topics: readonly string[] };

const sameHex = (a: string | undefined, b: string | null | undefined) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * What the transaction that used an authorization paid, from its receipt: the
 * log right after the authorization's AuthorizationUsed log (`isThisUse`)
 * must be USDC's Transfer of exactly `expected.value` from `expected.from` to
 * `expected.to`, or the outcome is "mismatched".
 *
 * FiatToken (Circle's USDC, FiatTokenV2_2) emits the two back to back: both
 * `_transferWithAuthorization` and `_receiveWithAuthorization` call
 * `_markAuthorizationAsUsed`, which emits AuthorizationUsed(authorizer,
 * nonce), and then `_transfer`, which emits Transfer(from, to, value) and
 * nothing else (circlefin/stablecoin-evm at fc85788:
 * contracts/v2/EIP3009.sol, and `_transfer` in contracts/v1/FiatTokenV1.sol).
 * So the log right after it is the transfer that authorization made, even in
 * a transaction that used several authorizations.
 */
async function outcomeOfUse(
  client: PublicClient,
  token: Hex,
  transaction: Hex,
  isThisUse: (log: ReceiptLog) => boolean,
  expected: { readonly from: Address; readonly to: Address; readonly value: bigint },
): Promise<AuthorizationOutcome> {
  const { logs } = await client.getTransactionReceipt({ hash: transaction });
  const used = logs.find(isThisUse);
  // The receipt the node serves now lacks the log the search found (a reorganization since, say): look again later.
  if (used === undefined) return { kind: "unknown" };
  const next = logs.find((log) => log.logIndex === used.logIndex + 1);
  if (next === undefined || !sameHex(next.address, token)) return { kind: "mismatched" };
  let paid: { readonly from: Hex; readonly to: Hex; readonly value: bigint };
  try {
    paid = decodeEventLog({ abi: [TRANSFER], topics: next.topics, data: next.data, strict: true }).args;
  } catch {
    // Another event, or not a well-formed Transfer.
    return { kind: "mismatched" };
  }
  if (!sameHex(paid.from, expected.from) || !sameHex(paid.to, expected.to) || paid.value !== expected.value) return { kind: "mismatched" };
  return { kind: "used", transaction: transaction.toLowerCase() };
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
 * a narrower range would not fix). The warranty indexer halves its log
 * ranges on the same test.
 */
export function isRpcRefusal(error: unknown): boolean {
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
