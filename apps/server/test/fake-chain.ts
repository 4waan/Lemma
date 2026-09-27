import { ARBITRUM_SEPOLIA_USDC, type Address, type Hex32, type PaymentTerms, paymentRequirementsFor, toolResourceUrl } from "@lemma/core";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { PERMIT2_ADDRESS, authorizationTypes, permit2WitnessTypes, x402ExactPermit2ProxyAddress } from "@x402/evm";
import { type Hex, type Log, encodeAbiParameters, encodeEventTopics, getAddress, isAddressEqual, keccak256, parseAbi, stringToHex, toHex, verifyTypedData } from "viem";
import type { LocalAccount } from "viem/accounts";

import type { AuthorizationOutcome, ChainHead, PaymentChain } from "../src/index.js";

/** A facilitator address for tests; it holds no key. */
export const FACILITATOR = "0x00000000000000000000000000000000000000fa";

const TRANSFER = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

export interface FakeTransfer {
  readonly from: Address;
  readonly to: Address;
  readonly value: bigint;
  readonly nonce: Hex32;
  readonly hash: Hex32;
}

/**
 * Arbitrum Sepolia USDC as the facilitator sees it, in memory: EIP-3009
 * nonces are single use, simulation and settlement fail for a used one, and a
 * settlement's receipt carries the Transfer log x402 checks. Signatures are
 * not faked: x402 recovers them itself, so only a real buyer signature passes.
 * It also answers the reconciler's reads, so one fake backs the whole path.
 */
export class FakeUsdc implements FacilitatorEvmSigner, PaymentChain {
  readonly transfers: FakeTransfer[] = [];
  readonly canceled = new Set<string>();
  /** Every contract read and write, by function name, in order. */
  readonly calls: string[] = [];
  /** Makes settlement transactions fail to send. */
  failWrites = false;
  /** The head block's timestamp the reconciler sees: the current time unless set. */
  chainTime: Date | undefined;
  /** Makes x402's check that the token is a contract (`getCode`) throw with this message. */
  tokenCodeError: string | undefined;

  getAddresses(): readonly Hex[] {
    return [FACILITATOR as Hex];
  }

  async readContract(args: { address: Hex; functionName: string; args?: readonly unknown[] }): Promise<unknown> {
    this.calls.push(`read:${args.functionName}`);
    const a = args.args ?? [];
    switch (args.functionName) {
      case "transferWithAuthorization":
        // eth_call simulation of the settlement.
        if (this.isUsed(a[0] as string, a[5] as string)) throw new Error("FiatTokenV2: authorization is used or canceled");
        return undefined;
      case "settle":
        // eth_call simulation of x402's Permit2 proxy: a wallet that approved Permit2 would pass it.
        if (!isAddressEqual(args.address, x402ExactPermit2ProxyAddress)) throw new Error("unexpected read of settle");
        return undefined;
      case "authorizationState":
        return this.isUsed(a[0] as string, a[1] as string);
      case "balanceOf":
        return 10n ** 12n;
      case "name":
        return "USD Coin";
      case "version":
        return "2";
      default:
        throw new Error(`unexpected read of ${args.functionName}`);
    }
  }

  async verifyTypedData(args: Parameters<FacilitatorEvmSigner["verifyTypedData"]>[0]): Promise<boolean> {
    return verifyTypedData(args as Parameters<typeof verifyTypedData>[0]);
  }

  async writeContract(args: { address: Hex; functionName: string; args: readonly unknown[] }): Promise<Hex> {
    this.calls.push(`write:${args.functionName}`);
    if (this.failWrites) throw new Error("the transaction could not be sent");
    if (args.functionName === "settle" && isAddressEqual(args.address, x402ExactPermit2ProxyAddress)) {
      // x402's Permit2 proxy pulling the permitted amount from the permit's owner (Permit2 allowance assumed).
      const [permit, owner, witness] = args.args as [{ permitted: { amount: bigint }; nonce: bigint }, Hex, { to: Hex }];
      const hash = keccak256(stringToHex(`permit2 ${this.transfers.length}`));
      this.transfers.push({ from: owner.toLowerCase(), to: witness.to.toLowerCase(), value: permit.permitted.amount, nonce: toHex(permit.nonce, { size: 32 }), hash });
      return hash;
    }
    if (args.functionName !== "transferWithAuthorization" || !isAddressEqual(args.address, getAddress(ARBITRUM_SEPOLIA_USDC))) throw new Error("unexpected write");
    const [from, to, value, , , nonce] = args.args as [Hex, Hex, bigint, bigint, bigint, Hex];
    if (this.isUsed(from, nonce)) throw new Error("FiatTokenV2: authorization is used or canceled");
    const hash = keccak256(stringToHex(`transfer ${this.transfers.length}`));
    this.transfers.push({ from: from.toLowerCase(), to: to.toLowerCase(), value, nonce: nonce.toLowerCase(), hash });
    return hash;
  }

  async sendTransaction(): Promise<Hex> {
    throw new Error("no deployments here");
  }

  async waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; logs?: readonly Log[] }> {
    const t = this.transfers.find((x) => x.hash === args.hash.toLowerCase());
    if (t === undefined) return { status: "reverted" };
    const log = {
      address: getAddress(ARBITRUM_SEPOLIA_USDC),
      topics: encodeEventTopics({ abi: TRANSFER, eventName: "Transfer", args: { from: t.from as Hex, to: t.to as Hex } }),
      data: encodeAbiParameters([{ type: "uint256" }], [t.value]),
    } as unknown as Log;
    return { status: "success", logs: [log] };
  }

  async getCode(args: { address: Hex }): Promise<Hex | undefined> {
    const isToken = isAddressEqual(args.address, getAddress(ARBITRUM_SEPOLIA_USDC));
    if (isToken && this.tokenCodeError !== undefined) throw new Error(this.tokenCodeError);
    return isToken ? "0x60" : "0x";
  }

  // PaymentChain, for the reconciler. One block per transfer, so the head moves with the chain.
  async head(): Promise<ChainHead> {
    return { number: BigInt(this.transfers.length + 1), timestamp: this.chainTime ?? new Date() };
  }

  async authorizationUsed(authorizer: Address, nonce: Hex32): Promise<boolean> {
    return this.isUsed(authorizer, nonce);
  }

  async authorizationOutcome(authorizer: Address, nonce: Hex32): Promise<AuthorizationOutcome> {
    if (this.canceled.has(key(authorizer, nonce))) return { kind: "canceled" };
    const t = this.transfers.find((x) => key(x.from, x.nonce) === key(authorizer, nonce));
    return t === undefined ? { kind: "unknown" } : { kind: "used", transaction: t.hash };
  }

  /**
   * A transfer the facilitator did not send (a settlement that outlived its
   * call, say). Pass `transaction` to put it in a transaction another transfer
   * is in: anyone may submit EIP-3009 authorizations, several in one call.
   */
  settleOutside(from: Address, to: Address, value: bigint, nonce: Hex32, transaction?: Hex32): Hex32 {
    const hash = transaction ?? keccak256(stringToHex(`outside ${this.transfers.length}`));
    this.transfers.push({ from, to, value, nonce: nonce.toLowerCase(), hash });
    return hash;
  }

  private isUsed(from: string, nonce: string): boolean {
    return this.canceled.has(key(from, nonce)) || this.transfers.some((t) => key(t.from, t.nonce) === key(from, nonce));
  }
}

const key = (from: string, nonce: string) => `${from.toLowerCase()}:${nonce.toLowerCase()}`;

/**
 * An x402 v2 payment payload for `terms`, signed by `buyer` as any x402
 * client would sign it (EIP-3009 TransferWithAuthorization under USDC's
 * domain), with the nonce the caller chooses.
 */
export async function paymentPayload(buyer: LocalAccount, terms: PaymentTerms, nonce: Hex32, validBefore: bigint, overrides: { to?: Hex; value?: string } = {}) {
  const accepted = paymentRequirementsFor(terms);
  const authorization = {
    from: buyer.address,
    to: overrides.to ?? getAddress(accepted.payTo),
    value: overrides.value ?? accepted.amount,
    validAfter: "0",
    validBefore: validBefore.toString(),
    nonce: nonce as Hex,
  };
  const signature = await buyer.signTypedData({
    domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: 421614, verifyingContract: getAddress(accepted.asset) },
    types: authorizationTypes,
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore },
  });
  return {
    x402Version: 2,
    resource: { url: toolResourceUrl("lemma_buy_resolution"), description: "Lemma Compatibility Resolution", mimeType: "application/json" },
    accepted: { ...accepted, extra: { ...accepted.extra } },
    payload: { authorization, signature },
  };
}

/**
 * An x402 v2 exact payload in the Permit2 shape, signed by `owner` for
 * `terms` (a real PermitWitnessTransferFrom signature, so x402's Permit2 path
 * verifies it), with `extra` merged into its inner payload: a forged
 * EIP-3009 `authorization` object, say, that nothing verifies.
 */
export async function permit2Payload(owner: LocalAccount, terms: PaymentTerms, deadline: bigint, extra: Record<string, unknown> = {}) {
  const accepted = paymentRequirementsFor(terms);
  const permit2Authorization = {
    from: owner.address,
    permitted: { token: getAddress(accepted.asset), amount: accepted.amount },
    spender: x402ExactPermit2ProxyAddress,
    nonce: "7",
    deadline: deadline.toString(),
    witness: { to: getAddress(accepted.payTo), validAfter: "0" },
  };
  const signature = await owner.signTypedData({
    domain: { name: "Permit2", chainId: 421614, verifyingContract: PERMIT2_ADDRESS },
    types: permit2WitnessTypes,
    primaryType: "PermitWitnessTransferFrom",
    message: {
      permitted: { token: permit2Authorization.permitted.token, amount: BigInt(accepted.amount) },
      spender: x402ExactPermit2ProxyAddress,
      nonce: 7n,
      deadline,
      witness: { to: permit2Authorization.witness.to, validAfter: 0n },
    },
  });
  return {
    x402Version: 2,
    resource: { url: toolResourceUrl("lemma_buy_resolution"), description: "Lemma Compatibility Resolution", mimeType: "application/json" },
    accepted: { ...accepted, extra: { ...accepted.extra } },
    payload: { permit2Authorization, signature, ...extra },
  };
}
