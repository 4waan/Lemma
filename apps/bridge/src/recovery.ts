import type { ResolutionInbox } from "./inbox.js";
import { FINAL_RECEIPT_ANSWERS, type LemmaRemote, type ReceiptAnswer } from "./remote.js";

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

/** Sends receipts the server has not answered yet, for example because it was unreachable when acceptance ran. */
export async function flushReceipts(inbox: ResolutionInbox, remote: LemmaRemote): Promise<{ sent: number; unsent: number }> {
  let sent = 0;
  let unsent = 0;
  for (const stored of inbox.unpostedReceipts()) {
    try {
      const answer = await remote.postReceipt(stored.receipt, stored.previewId);
      inbox.putReceipt({ ...stored, ...answered(answer) });
      if (FINAL_RECEIPT_ANSWERS.has(answer)) sent++;
      else unsent++;
    } catch {
      unsent++;
    }
  }
  return { sent, unsent };
}

/** How an answer is stored: a final one ends the retries; a retryable one is kept as the last answer. */
export function answered(answer: ReceiptAnswer): { answer: ReceiptAnswer | null; lastAnswer: ReceiptAnswer } {
  return { answer: FINAL_RECEIPT_ANSWERS.has(answer) ? answer : null, lastAnswer: answer };
}
