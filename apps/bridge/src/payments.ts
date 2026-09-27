import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { type Address, type AdoptionReceipt, toAddress } from "@lemma/core";
import { zeroAddress } from "viem";

import { buyTool } from "./buy.js";
import { SpendLedger } from "./ledger.js";
import { walletKeys } from "./secrets.js";
import { defaultSignerSocket } from "./signer/paths.js";
import { spendingPolicyFromEnv } from "./signer/policy.js";
import { type Signer } from "./signer/signer.js";
import { SocketSigner, socketDirectoryProblem } from "./signer/socket.js";

export interface BridgePayments {
  /** The buy tool's registrar, for `createBridgeServer({ registerPaidTools })`; absent when purchases are off. */
  readonly registerPaidTools?: ReturnType<typeof buyTool>;
  /** The receipt signing hook for `adoptionTools({ signReceipt })`; absent without a signer. */
  readonly signReceipt?: (receipt: AdoptionReceipt) => Promise<string>;
  /** Why purchases are off, or a warning, for the bridge's stderr; never a secret. */
  readonly note?: string;
}

/**
 * Purchases and receipt signatures through `lemma-signer`, at LEMMA_SIGNER_SOCKET
 * or, unset, where `lemma-signer serve` listens by default
 * (`<state>/signer/signer.sock`). The buy tool is registered only when a signer
 * answers there, in a directory nobody else can write to, the spending policy
 * variables (LEMMA_MAX_USDC_PER_RESOLUTION, LEMMA_DAILY_USDC_CAP,
 * LEMMA_ALLOWED_PAY_TO) parse, and LEMMA_REFUND_TO, when set, is a usable
 * address; receipts are signed whenever the signer answers. With purchases on
 * and no LEMMA_REFUND_TO, the note says warranty credits go to the buyer's
 * own address.
 * The bridge itself never holds a wallet secret: the key lives in the signer,
 * and the bridge only asks it to sign. A wallet secret found in the bridge's
 * environment, or the one it started with (`startEnv`, read from /proc by
 * default), is reported.
 */
export async function paymentsFromEnv(
  env: NodeJS.ProcessEnv,
  deps: {
    readonly stateDir: string;
    readonly root: string;
    readonly clock: () => Date;
    readonly signerFor?: (socketPath: string) => Signer;
    readonly startEnv?: NodeJS.ProcessEnv;
  },
): Promise<BridgePayments> {
  const held = walletKeys(env, deps.startEnv);
  const warning = held.length > 0 ? ` The bridge's environment holds ${held.join(", ")}: remove it; the signer holds the key, and acceptance tests will not run while it is there.` : "";
  const configured = env["LEMMA_SIGNER_SOCKET"];
  const named = configured !== undefined && configured !== "";
  if (named && !isAbsolute(configured)) return { note: `purchases are off: LEMMA_SIGNER_SOCKET must be an absolute path.${warning}` };
  const socket = named ? configured : defaultSignerSocket(deps.stateDir);
  const where = named ? "LEMMA_SIGNER_SOCKET" : "the default socket <state>/signer/signer.sock";
  const absent = { note: `purchases are off: no signer answers at ${where} (start lemma-signer serve).${warning}` };
  if (!existsSync(dirname(socket))) return absent;
  // Whoever can write to the socket's directory could answer in the signer's place, and would learn every purchase.
  const unsafe = socketDirectoryProblem(socket, { ownedByMe: false });
  if (unsafe !== undefined) return { note: `purchases are off: ${unsafe}, so a signer there cannot be trusted.${warning}` };
  const signer = deps.signerFor?.(socket) ?? new SocketSigner(socket);
  try {
    await signer.address();
  } catch {
    return absent;
  }
  const signReceipt = (receipt: AdoptionReceipt) => signer.signAdoptionReceipt(receipt);
  const policy = spendingPolicyFromEnv(env);
  if (!policy.ok) return { signReceipt, note: `purchases are off: ${policy.problems.join("; ")}.${warning}` };
  const refund = refundToFromEnv(env);
  if (!refund.ok) return { signReceipt, note: `purchases are off: ${refund.problem}.${warning}` };
  const registerPaidTools = buyTool({ signer, policy: policy.policy, ledger: new SpendLedger(join(deps.stateDir, "ledger")), root: deps.root, clock: deps.clock, refundTo: refund.address });
  const ownRefund =
    refund.address === undefined
      ? " Warranty credits go to the buyer's own address, which withdrawing a credit shows next to the resolution id on chain; set LEMMA_REFUND_TO to another address you control to keep the two apart."
      : "";
  const note = `${ownRefund}${warning}`.trim();
  return note === "" ? { registerPaidTools, signReceipt } : { registerPaidTools, signReceipt, note };
}

/**
 * LEMMA_REFUND_TO: where warranty credits are paid, when not the buyer's own
 * address. Optional; the zero address is refused, since a credit sent there
 * could never be spent. Problems name the variable, never its value.
 */
export function refundToFromEnv(env: NodeJS.ProcessEnv): { ok: true; address: Address | undefined } | { ok: false; problem: string } {
  const value = env["LEMMA_REFUND_TO"]?.trim();
  if (value === undefined || value === "") return { ok: true, address: undefined };
  let address: Address;
  try {
    address = toAddress(value);
  } catch {
    return { ok: false, problem: "LEMMA_REFUND_TO is not an address with a valid checksum" };
  }
  if (address === zeroAddress) return { ok: false, problem: "LEMMA_REFUND_TO must not be the zero address" };
  return { ok: true, address };
}
