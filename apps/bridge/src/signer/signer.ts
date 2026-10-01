import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_USDC,
  Address,
  AdoptionReceipt,
  Hex32,
  SignatureBytes,
  type SpendRefusal,
  type SpendingPolicy,
  USDC_EIP712_DOMAIN,
  UsdcAtomic,
  adoptionReceiptDigest,
  adoptionReceiptTypedData,
  checkSpend,
  derivePaymentNonce,
  toAddress,
} from "@lemma/core";
import { authorizationTypes } from "@x402/evm";
import { type Hex, getAddress } from "viem";
import type { LocalAccount } from "viem/accounts";
import { z } from "zod";

import { type SpendLedger } from "../ledger.js";
import { ReceiptBook } from "./receipts.js";

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;

/** An authorization shorter-lived than this is refused: it would expire before it settles. */
export const MIN_AUTHORIZATION_SECONDS = 10;

/**
 * What the bridge asks the signer to sign: a USDC `TransferWithAuthorization`
 * from the signer's own address. The token, chain and EIP-712 domain are the
 * signer's own constants, never the caller's.
 */
export const TransferAuthorization = z.strictObject({
  to: Address,
  value: UsdcAtomic,
  validAfter: z.literal("0"),
  validBefore: z.string().regex(/^[1-9][0-9]{0,14}$/),
  nonce: Hex32,
});

export type TransferAuthorization = z.infer<typeof TransferAuthorization>;

export type SignerRefusalCode = SpendRefusal | "BAD_REQUEST" | "AUTHORIZATION_EXPIRED" | "LEDGER_UNAVAILABLE" | "SIGNING_FAILED" | "NOT_PAID" | "RECEIPT_ALREADY_SIGNED";

/** The signer would not sign. Nothing was signed, and the code says why. */
export class SignerRefusal extends Error {
  override name = "SignerRefusal";

  constructor(readonly code: SignerRefusalCode) {
    super(`the signer refused: ${code}`);
  }
}

/**
 * The buyer's signer as the bridge sees it. `lemma-signer` implements it in a
 * separate process behind a Unix socket (`SocketSigner`); `LocalSigner` is
 * the same logic in process, for that server and for tests.
 */
export interface Signer {
  address(): Promise<Address>;
  /** A signature over USDC `TransferWithAuthorization` on Arbitrum Sepolia, or a `SignerRefusal`. */
  signTransferAuthorization(authorization: TransferAuthorization): Promise<Hex>;
  /**
   * A signature over core `adoptionReceiptTypedData(receipt, 421614)`, for a
   * resolution this signer paid for (its payment nonce comes from the
   * resolution id and `previewId`), and only one receipt per resolution.
   */
  signAdoptionReceipt(receipt: AdoptionReceipt, previewId: Hex32): Promise<string>;
}

/**
 * Holds the buyer key and signs only what the policy allows. Every process
 * of the user can reach the signer, so the checks are here, not in the
 * bridge: it signs a transfer only to an allowlisted payee, within the
 * per-purchase cap, the rolling daily cap over its own ledger, and the
 * authorization window; and Lemma Adoption Receipts, only for resolutions it
 * signed the payment for and only one per resolution. A nonce signed again
 * (a retry) counts once, since USDC executes at most one authorization per
 * nonce. The key never leaves the account object: nothing here returns or
 * logs it.
 */
export class LocalSigner implements Signer {
  private readonly receipts: ReceiptBook;

  /** The receipt book (the payments signed, and the receipt for each) lives next to the ledger, in `ledger.dir`. */
  constructor(
    private readonly account: LocalAccount,
    private readonly policy: SpendingPolicy,
    private readonly ledger: SpendLedger,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.receipts = new ReceiptBook(ledger.dir);
  }

  async address(): Promise<Address> {
    return toAddress(this.account.address);
  }

  async signTransferAuthorization(input: TransferAuthorization): Promise<Hex> {
    const parsed = TransferAuthorization.safeParse(input);
    if (!parsed.success) throw new SignerRefusal("BAD_REQUEST");
    const a = parsed.data;
    const now = this.clock();
    const lifetime = Number(a.validBefore) - Math.floor(now.getTime() / 1000);
    if (lifetime < MIN_AUTHORIZATION_SECONDS) throw new SignerRefusal("AUTHORIZATION_EXPIRED");
    let decision: ReturnType<typeof checkSpend>;
    try {
      decision = this.ledger.reserve({ nonce: a.nonce, amount: BigInt(a.value), payTo: a.to }, now, (committed) =>
        checkSpend(this.policy, committed, { scheme: "exact", network: ARBITRUM_SEPOLIA, asset: ARBITRUM_SEPOLIA_USDC, amount: a.value, payTo: a.to, maxTimeoutSeconds: lifetime }),
      );
    } catch {
      throw new SignerRefusal("LEDGER_UNAVAILABLE");
    }
    if (!decision.ok) throw new SignerRefusal(decision.reason);
    try {
      this.receipts.paid(a.nonce, now);
    } catch {
      throw new SignerRefusal("LEDGER_UNAVAILABLE");
    }
    try {
      return await this.account.signTypedData({
        domain: { name: USDC_EIP712_DOMAIN.name, version: USDC_EIP712_DOMAIN.version, chainId: ARBITRUM_SEPOLIA_CHAIN_ID, verifyingContract: getAddress(ARBITRUM_SEPOLIA_USDC) },
        types: authorizationTypes,
        primaryType: "TransferWithAuthorization",
        message: { from: this.account.address, to: getAddress(a.to), value: BigInt(a.value), validAfter: 0n, validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex },
      });
    } catch {
      // The reservation stays: failing closed costs cap, never money.
      throw new SignerRefusal("SIGNING_FAILED");
    }
  }

  /**
   * Any process of the user can reach the signer, a release's own acceptance
   * tests included, and the server keeps the first receipt posted for a
   * resolution. So a receipt is signed only for a payment this signer
   * authorized, and only once per resolution (the same receipt again is a
   * retry and is signed again). A process that gets a receipt signed first
   * makes the bridge's own refused, so the bridge keeps its receipt unsigned
   * and says so, and two signed receipts never exist for one resolution.
   */
  async signAdoptionReceipt(input: AdoptionReceipt, previewIdInput: Hex32): Promise<string> {
    const receipt = AdoptionReceipt.safeParse(input);
    const previewId = Hex32.safeParse(previewIdInput);
    if (!receipt.success || !previewId.success) throw new SignerRefusal("BAD_REQUEST");
    const nonce = derivePaymentNonce(receipt.data.resolutionId, previewId.data);
    let claimed: ReturnType<ReceiptBook["claim"]>;
    try {
      claimed = this.receipts.claim(nonce, adoptionReceiptDigest(receipt.data), this.clock());
    } catch {
      throw new SignerRefusal("LEDGER_UNAVAILABLE");
    }
    if (claimed === "not-paid") throw new SignerRefusal("NOT_PAID");
    if (claimed === "taken") throw new SignerRefusal("RECEIPT_ALREADY_SIGNED");
    const signature = (await this.account.signTypedData(adoptionReceiptTypedData(receipt.data, ARBITRUM_SEPOLIA_CHAIN_ID))).toLowerCase();
    return SignatureBytes.parse(signature);
  }
}
