import { adoptionReceiptTypedData } from "@lemma/core";
import { type Hex, getAddress } from "viem";

import { describeError, safeStore } from "../errors.js";
import type { Logger } from "../log.js";
import type { LemmaStore } from "../persistence.js";
import type { SignatureVerifier } from "./chain.js";

/** How often the verifier looks for new receipts. */
export const VERIFY_INTERVAL_MS = 60_000;

export interface VerifyReport {
  readonly verified: number;
  /** Unsigned receipts, and signatures that are not the buyer's: checked, left unverified. */
  readonly rejected: number;
  /** Checks the chain could not answer; they run again next time. */
  readonly failed: number;
}

/**
 * Checks Adoption Receipt signatures. `acceptReceipt` keeps accepting
 * unsigned and signed receipts alike (the first write wins); this job then
 * checks each stored receipt once against the resolution's buyer with viem
 * `verifyTypedData` on a public client, which covers EOAs, ERC-1271 smart
 * accounts and counterfactual ERC-6492 ones, over core
 * `adoptionReceiptTypedData` on Arbitrum Sepolia. A valid signature sets
 * `verified`; an unsigned receipt or another signer's signature is recorded
 * as checked and stays unverified. A check the chain could not answer is left
 * for the next run.
 */
export class ReceiptVerifier {
  private readonly store: LemmaStore;
  private running = false;

  constructor(
    private readonly deps: {
      readonly store: LemmaStore;
      readonly verifier: SignatureVerifier;
      readonly chainId: number;
      readonly clock: () => Date;
      readonly logger: Logger;
      readonly batch?: number;
    },
  ) {
    this.store = safeStore(deps.store);
  }

  async runOnce(): Promise<VerifyReport> {
    let verified = 0;
    let rejected = 0;
    let failed = 0;
    for (const { receipt, receiptDigest } of await this.store.listUncheckedReceipts(this.deps.batch ?? 100)) {
      const id = receipt.resolutionId;
      const row = await this.store.getResolution(id);
      if (receipt.signature === null || row === undefined) {
        if (await this.store.markReceiptChecked(id, receiptDigest, this.deps.clock())) rejected++;
        continue;
      }
      let valid: boolean;
      try {
        valid = await this.deps.verifier.verifyTypedData({
          address: getAddress(row.resolution.buyer),
          ...adoptionReceiptTypedData(receipt, this.deps.chainId),
          signature: receipt.signature as Hex,
        });
      } catch (error) {
        this.deps.logger.log("warn", "receipt.check_failed", { resolutionId: id, error: describeError(error) });
        failed++;
        continue;
      }
      if (valid ? await this.store.markReceiptVerified(id, receiptDigest, this.deps.clock()) : await this.store.markReceiptChecked(id, receiptDigest, this.deps.clock())) {
        if (valid) verified++;
        else rejected++;
      }
      this.deps.logger.log("info", "receipt.checked", { resolutionId: id, verified: valid });
    }
    return { verified, rejected, failed };
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = VERIFY_INTERVAL_MS): () => void {
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch (error) {
        this.deps.logger.log("warn", "receipt.verify_failed", { error: describeError(error) });
      } finally {
        this.running = false;
      }
    };
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref();
    void tick();
    return () => clearInterval(timer);
  }
}
