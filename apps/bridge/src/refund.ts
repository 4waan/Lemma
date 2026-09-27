import { Hex32, type WarrantyClaim, type WarrantyWithdrawalRefusal, formatUsdc } from "@lemma/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { ResolutionInbox } from "./inbox.js";
import { type LemmaRemote, RemoteError } from "./remote.js";
import { MAX_TOOL_TEXT } from "./text.js";

export interface RefundDeps {
  /** Where the warranty claims are (`claims/`, core `WarrantyClaim`), and the purchases they belong to. */
  readonly inbox: ResolutionInbox;
  readonly remote: LemmaRemote;
}

/** Why the server could not be asked: the call asks nothing more, and the claims left answer the same code. */
export const TRANSIENT_REFUND_CODES = ["UNREACHABLE", "RATE_LIMITED", "SERVER_ERROR"] as const;

export type TransientRefundCode = (typeof TRANSIENT_REFUND_CODES)[number];

/**
 * What a claim's refund came to: `queued` (the server relays it: the
 * withdrawal is queued or sent), `refunded` (the credit reached the refund
 * address), `open` (the warranty is pending or active: no verdict yet),
 * `none` (no refund is due: the run passed or was void, the warranty expired,
 * or there is none), `abandoned` (the relay gave up), or a code: the route's
 * refusal (core `WarrantyWithdrawalRefusal`), or why the server could not be
 * asked.
 */
export type RefundWord = "queued" | "refunded" | "open" | "none" | "abandoned" | WarrantyWithdrawalRefusal["error"] | TransientRefundCode;

export interface RefundEntry {
  readonly resolutionId: Hex32;
  readonly word: RefundWord;
  /** The warranty's amount in atomic USDC (testnet), when money is at stake for the buyer. */
  readonly amount: string | null;
  /**
   * This call asked the relay to pay the wallet that paid for the resolution
   * (the bridge's default refund address): the withdrawal shows that wallet
   * next to the public resolution id on chain.
   */
  readonly toPayer?: boolean;
}

export const REFUND_DESCRIPTION = "Collect the warranty refund of each purchase whose failure the evaluator confirmed. Free, and safe to call again.";

/**
 * `lemma_claim_refund({ resolutionId? })`: for each warranty claim this
 * machine holds (every one, or the named resolution's), the resolution's
 * warranty as the server shows it (`GET /api/v1/resolutions/:id`), and, only
 * when it is `failed` (an eligible failure whose credit is outstanding), a
 * relay request to the server with the claim's secret and refund address
 * (`POST /api/v1/warranty/withdrawals`); the evaluator's key pays the gas.
 * That request is the only place the secret goes. Asking again is safe: the
 * server answers the same request with the same relay, never a second one.
 *
 * No chain call: every fact comes from the server, which indexes the
 * registry. The answer is at most 600 characters: per resolution (a short
 * id), `queued`, `refunded`, `open`, `none` or a code, with the amount in
 * testnet USDC, and a line on what each word means. A refund it asks for
 * that pays the wallet that paid says so, because the withdrawal then shows
 * that wallet next to the resolution id on chain.
 */
export function refundTool(deps: RefundDeps): (server: McpServer) => void {
  return (server) => {
    server.registerTool(
      "lemma_claim_refund",
      { description: REFUND_DESCRIPTION, inputSchema: z.strictObject({ resolutionId: Hex32.optional() }) },
      async ({ resolutionId }) => {
        try {
          return { content: [{ type: "text" as const, text: await claimRefunds(deps, resolutionId) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text" as const, text: `Lemma: the refund step failed (${error instanceof Error ? error.name : "error"}). Try again; asking again never queues a refund twice.` }] };
        }
      },
    );
  };
}

export const NO_CLAIMS_TEXT = "Lemma: this machine holds no warranty claim, so there is no refund to collect. Each purchase made with lemma_buy_resolution keeps one.";
export const NO_CLAIM_TEXT = "Lemma: this machine holds no warranty claim for that resolution, so no refund was requested.";

/**
 * Checks each claim in turn and answers for all of them. After a claim the
 * server could not be asked about (`TRANSIENT_REFUND_CODES`), the rest are not
 * asked either, so a server that is down costs one timeout, not one per claim.
 */
export async function claimRefunds(deps: RefundDeps, only?: Hex32): Promise<string> {
  const claims = only === undefined ? deps.inbox.claims() : [deps.inbox.claim(only)].filter((c): c is WarrantyClaim => c !== undefined);
  if (claims.length === 0) return only === undefined ? NO_CLAIMS_TEXT : NO_CLAIM_TEXT;
  const entries: RefundEntry[] = [];
  let stopped: TransientRefundCode | undefined;
  for (const claim of claims) {
    const entry = stopped === undefined ? await refundOne(deps, claim) : { resolutionId: claim.resolutionId, word: stopped, amount: null };
    if (isTransient(entry.word)) stopped = entry.word;
    entries.push(entry);
  }
  return refundText(entries);
}

async function refundOne(deps: RefundDeps, claim: WarrantyClaim): Promise<RefundEntry> {
  const resolutionId = claim.resolutionId;
  const entry = (word: RefundWord, amount: string | null = null): RefundEntry => ({ resolutionId, word, amount });
  let view;
  try {
    view = await deps.remote.resolutionWarranty(resolutionId);
  } catch (error) {
    return entry(failureCode(error));
  }
  // Unknown to the server: a purchase that never went through, unless this machine holds its delivery.
  if (view === undefined) return entry(deps.inbox.get(resolutionId) === undefined ? "none" : "UNKNOWN_RESOLUTION");
  const warranty = view.warranty ?? null;
  if (warranty === null) return entry("none");
  switch (warranty.state) {
    case "refunded":
      return entry("refunded", warranty.amount);
    case "pending":
    case "active":
      return entry("open", warranty.amount);
    case "failed":
      break;
    default:
      return entry("none");
  }
  // An eligible failure with its credit outstanding: the one case the claim is sent.
  let reply;
  try {
    reply = await deps.remote.requestWithdrawal(claim);
  } catch (error) {
    return entry(failureCode(error), warranty.amount);
  }
  if (reply.kind === "refused") return entry(reply.code, warranty.amount);
  const word = reply.state === "done" ? "refunded" : reply.state === "abandoned" ? "abandoned" : "queued";
  return paysPayer(deps, claim) ? { ...entry(word, warranty.amount), toPayer: true } : entry(word, warranty.amount);
}

/** Whether the claim's refund address is the wallet that paid, as the delivery this machine keeps names it. */
function paysPayer(deps: RefundDeps, claim: WarrantyClaim): boolean {
  try {
    const buyer = deps.inbox.get(claim.resolutionId)?.resolution.buyer;
    return buyer !== undefined && buyer.toLowerCase() === claim.refundTo.toLowerCase();
  } catch {
    return false;
  }
}

/** A failed request as a code: the server's rate limit, another answer it gave, or no answer at all. */
function failureCode(error: unknown): TransientRefundCode {
  if (!(error instanceof RemoteError) || error.status === null) return "UNREACHABLE";
  return error.status === 429 ? "RATE_LIMITED" : "SERVER_ERROR";
}

const TRANSIENT: ReadonlySet<string> = new Set(TRANSIENT_REFUND_CODES);
const isTransient = (word: RefundWord): word is TransientRefundCode => TRANSIENT.has(word);

const WHY: Record<TransientRefundCode, string> = {
  UNREACHABLE: "could not be reached",
  RATE_LIMITED: "asked to slow down",
  SERVER_ERROR: "gave no usable answer",
};

/** Display order: what was asked for or paid, refusals, what is still open, what could not be asked, then nothing due. */
function rank(word: RefundWord): number {
  if (word === "queued") return 0;
  if (word === "refunded") return 1;
  if (word === "open") return 3;
  if (word === "none") return 5;
  return isTransient(word) ? 4 : 2;
}

const HEAD = "Lemma: warranty refunds, by resolution: ";

/**
 * The answer: each resolution as a short id with its word and amount, in
 * `rank` order, then a line for each word that needs one. As many entries as
 * fit in 600 characters are shown, and the rest are counted by word; only if
 * even the counts do not fit are the least needed lines left out. When no
 * claim could be asked about at all, one sentence says why.
 */
export function refundText(entries: readonly RefundEntry[]): string {
  const [first] = entries;
  if (first !== undefined && isTransient(first.word) && entries.every((e) => e.word === first.word)) {
    return `Lemma: the Lemma server ${WHY[first.word]} (${first.word}), so the refunds could not be checked. Try again shortly; asking again never queues a refund twice.`;
  }
  const sorted = [...entries].sort((a, b) => rank(a.word) - rank(b.word));
  const lines = legend(new Set(sorted.map((e) => e.word)), sorted.some((e) => e.toPayer === true));
  for (let kept = lines.length; kept >= 0; kept--) {
    const tail = lines.slice(0, kept).map((line) => ` ${line}`).join("");
    for (let shown = Math.min(sorted.length, 40); shown >= 0; shown--) {
      const text = `${HEAD}${listed(sorted, shown)}.${tail}`;
      if (text.length <= MAX_TOOL_TEXT) return text;
    }
  }
  // Unreachable: the counts of every word there is fit on their own.
  return `${HEAD}${listed(sorted, 0)}`.slice(0, MAX_TOOL_TEXT - 1) + ".";
}

/** The first `shown` entries, then the rest counted by word ("and 3 more: 2 none, 1 open"). */
function listed(sorted: readonly RefundEntry[], shown: number): string {
  const items = sorted.slice(0, shown).map((e) => `${e.resolutionId.slice(0, 10)}… ${e.word}${e.amount === null ? "" : ` ${formatUsdc(BigInt(e.amount))} testnet USDC`}${e.toPayer === true ? " to the paying wallet" : ""}`);
  const rest = sorted.slice(shown);
  if (rest.length === 0) return items.join("; ");
  const counts = new Map<RefundWord, number>();
  for (const e of rest) counts.set(e.word, (counts.get(e.word) ?? 0) + 1);
  const summary = [...counts].map(([word, n]) => `${n} ${word}`).join(", ");
  return items.length === 0 ? `${rest.length} claims: ${summary}` : `${items.join("; ")}; and ${rest.length} more: ${summary}`;
}

/**
 * A line for each word that needs saying, most needed first (the order they
 * are left out in, from the end, when space runs short); the codes the route
 * refused with share one line. `toPayer`: a refund asked for pays the wallet
 * that paid.
 */
function legend(words: ReadonlySet<RefundWord>, toPayer: boolean): string[] {
  const lines: string[] = [];
  if (words.has("queued")) lines.push("Queued: the Lemma server pays it to the refund address, gas included; call again to see it refunded.");
  if (toPayer) lines.push("To the paying wallet: the chain shows that wallet next to the resolution id once it is paid; LEMMA_REFUND_TO sets another refund address for later purchases.");
  for (const code of TRANSIENT_REFUND_CODES) if (words.has(code)) lines.push(`${code}: the Lemma server ${WHY[code]}, so nothing more was asked; try again shortly.`);
  if (words.has("open")) lines.push("Open: no verdict yet; the evaluator reviews failures, so call again later.");
  if (words.has("abandoned")) lines.push("Abandoned: the relay gave up; the registry holds no credit for it, or refused the claim.");
  const refused = [...words].filter((w) => rank(w) === 2 && w !== "abandoned");
  if (refused.length > 0) lines.push(`${refused.join(", ")}: refused by the server; nothing was queued.`);
  if (words.has("none")) lines.push("None: no refund is due.");
  return lines;
}
