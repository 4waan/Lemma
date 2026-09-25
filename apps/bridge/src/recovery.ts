import type { ResolutionInbox } from "./inbox.js";
import type { LemmaRemote } from "./remote.js";

/** After this long without settling, an authorization can no longer settle (x402 windows are at most 600 s). */
export const PENDING_GIVE_UP_MS = 15 * 60 * 1000;

/**
 * Recovers every purchase marked pending whose response never arrived. The
 * bridge runs it at startup, and the paid tool runs it through
 * `PaidToolContext.recover` after a lost paid response. A settled resolution is fetched for free and stored; one still in
 * flight stays pending; one the server has not seen is dropped once no
 * authorization could still settle.
 */
export async function recoverPending(inbox: ResolutionInbox, remote: LemmaRemote, now: Date): Promise<{ recovered: number; waiting: number; dropped: number }> {
  let recovered = 0;
  let waiting = 0;
  let dropped = 0;
  for (const p of inbox.pending()) {
    let result;
    try {
      result = await remote.recover(p.previewId, p.buyer);
    } catch {
      waiting++;
      continue;
    }
    if (result === "IN_FLIGHT") waiting++;
    else if (result === "NOT_FOUND") {
      if (now.getTime() - Date.parse(p.since) > PENDING_GIVE_UP_MS) {
        inbox.clearPending(p.previewId);
        dropped++;
      } else waiting++;
    } else {
      inbox.put(result);
      recovered++;
    }
  }
  return { recovered, waiting, dropped };
}
