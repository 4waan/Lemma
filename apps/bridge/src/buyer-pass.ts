import type { BuyerPass } from "@lemma/core";

import type { ResolutionInbox } from "./inbox.js";
import type { LemmaRemote } from "./remote.js";

/** The shortest wait before a failed claim is tried again, on the monotonic clock. */
export const BUYER_PASS_RETRY_MS = 60_000;

/**
 * This bridge's buyer pass: the stored one, or, once a purchase is in the
 * inbox, one claimed for it (`lemma_claim_buyer_pass`) so that demand counts
 * this bridge as one that has bought. `current()` never waits on the network:
 * the preview that starts a claim goes without the pass, and every later one
 * carries it. A claim starts at most once per BUYER_PASS_RETRY_MS, far longer
 * than a request may take, so claims never overlap, and a bridge whose claim
 * fails (or that the server cannot answer yet) never adds a request to every
 * preview.
 */
export class BuyerPassKeeper {
  private pass: BuyerPass | undefined;
  private nextClaimAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly inbox: Pick<ResolutionInbox, "buyerPass" | "putBuyerPass" | "resolutions">,
    private readonly remote: Pick<LemmaRemote, "claimBuyerPass">,
    private readonly monotonic: () => number,
  ) {}

  /** The pass to send with a preview, if this bridge has one; starts a claim in the background when it has bought but has none. */
  current(): BuyerPass | undefined {
    this.pass ??= this.inbox.buyerPass();
    if (this.pass === undefined && this.monotonic() >= this.nextClaimAt) {
      const [bought] = this.inbox.resolutions();
      if (bought !== undefined) {
        this.nextClaimAt = this.monotonic() + BUYER_PASS_RETRY_MS;
        void this.claim(bought.previewId, bought.buyer);
      }
    }
    return this.pass;
  }

  private async claim(...args: Parameters<LemmaRemote["claimBuyerPass"]>): Promise<void> {
    try {
      const pass = await this.remote.claimBuyerPass(...args);
      if (pass === undefined) return;
      // Kept in memory first: a pass the disk refuses is still sent by this process, and the next one claims the same pass again.
      this.pass = pass;
      this.inbox.putBuyerPass(pass);
    } catch {
      // Tried again after the wait; a preview never fails because of it.
    }
  }
}
