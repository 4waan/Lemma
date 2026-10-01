import { ARBITRUM_SEPOLIA } from "@lemma/core";
import { x402Facilitator } from "@x402/core/facilitator";
import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import { type FacilitatorEvmSigner, toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { ExactEvmScheme as ExactEvmServerScheme } from "@x402/evm/exact/server";
import type { Account, Chain, PublicClient, Transport, WalletClient } from "viem";

import { describeError } from "../errors.js";
import { isExactEip3009Payload } from "./handler.js";

/**
 * Receipt waits inside a settlement are bounded below the server's 15-second
 * request limit. A slower confirmation answers `settlement_pending` (x402
 * retries once) and the paid call fails; the transaction still lands, and the
 * settlement reconciler commits it from USDC's AuthorizationUsed log, after
 * which the bridge recovers the resolution for free.
 */
export const CONFIRMATION_TIMEOUT_MS = 6_000;

/** x402's reason for a payload its scheme does not take (`ErrUnsupportedPayloadType` in @x402/evm). */
export const UNSUPPORTED_PAYLOAD_TYPE = "unsupported_payload_type";

/**
 * A verify or settle call that threw, reduced to its error class and a short
 * message with every long hex string (addresses, nonces, signatures, hashes)
 * replaced. x402 prints such errors with `console.error`, and viem's full
 * messages can quote a call's arguments (the payer, the nonce and the
 * signature), which next to the handler's log lines would join a wallet to
 * what it bought.
 */
export class FacilitatorError extends Error {
  override name = "FacilitatorError";

  constructor(step: "verify" | "settle", cause: unknown) {
    super(`the facilitator could not ${step} the payment (${describeError(cause)}: ${redactHex(shortMessageOf(cause))})`);
  }
}

const LONG_HEX = /0x[0-9a-fA-F]{16,}/g;

const redactHex = (text: string) => text.replace(LONG_HEX, "0x…").slice(0, 200);

function shortMessageOf(error: unknown): string {
  if (!(error instanceof Error)) return "error";
  const short = (error as { shortMessage?: unknown }).shortMessage;
  return typeof short === "string" ? short : (error.message.split("\n")[0] ?? "");
}

/**
 * One in-process x402 facilitator for Arbitrum Sepolia: the audited
 * `x402Facilitator` with the exact EVM scheme (EIP-3009 verify and settle).
 * It is reached only through this object, never over HTTP: a public
 * facilitator endpoint would pay gas for anyone's settlements.
 *
 * Only exact EIP-3009 payloads get through (`ExactEip3009Payload`, checked
 * in x402's before-verify and before-settle hooks): the exact scheme picks its
 * path from the payload's shape, so a Permit2 payload would otherwise be
 * verified and settled as a permit while the handler read an unverified
 * `authorization` beside it. A failed answer keeps its reason code and loses
 * its message, and a thrown error becomes a `FacilitatorError`, so nothing
 * x402 prints from here quotes a payer, nonce or signature.
 */
export function inProcessFacilitator(signer: FacilitatorEvmSigner): FacilitatorClient {
  const onlyEip3009 = async ({ paymentPayload }: { readonly paymentPayload: PaymentPayload }) =>
    isExactEip3009Payload(paymentPayload.payload) ? undefined : ({ abort: true, reason: UNSUPPORTED_PAYLOAD_TYPE } as const);
  const facilitator = new x402Facilitator().register(ARBITRUM_SEPOLIA, new ExactEvmFacilitatorScheme(signer)).onBeforeVerify(onlyEip3009).onBeforeSettle(onlyEip3009);
  return {
    async verify(payload, requirements) {
      let result: VerifyResponse;
      try {
        result = await facilitator.verify(payload, requirements);
      } catch (error) {
        throw new FacilitatorError("verify", error);
      }
      if (result.isValid) return result;
      const { invalidMessage: _dropped, ...kept } = result;
      return kept;
    },
    async settle(payload, requirements) {
      let result: SettleResponse;
      try {
        result = await facilitator.settle(payload, requirements);
      } catch (error) {
        throw new FacilitatorError("settle", error);
      }
      if (result.success) return result;
      const { errorMessage: _dropped, ...kept } = result;
      return kept;
    },
    // x402Facilitator types its kinds with a plain string network; the facilitator registered only CAIP-2 networks.
    getSupported: async () => facilitator.getSupported() as SupportedResponse,
  };
}

/** The x402 resource server the paid tool is wrapped with: exact EVM on Arbitrum Sepolia, through `facilitator`. */
export async function paymentResourceServer(facilitator: FacilitatorClient): Promise<x402ResourceServer> {
  const server = new x402ResourceServer(facilitator).register(ARBITRUM_SEPOLIA, new ExactEvmServerScheme());
  await server.initialize();
  return server;
}

/**
 * The facilitator's signer over viem: a wallet client holding the facilitator
 * key (it pays settlement gas and never receives funds) and a public client
 * for reads, receipts and signature checks. The key stays inside the viem
 * account; nothing here logs or returns it.
 *
 * `getCode` answers `undefined` instead of rejecting when the RPC fails. x402
 * starts its asset check (a `getCode` of the token) before the signature
 * check and does not await it when the signature check fails, so a rejection
 * there would go unhandled and stop the process on the first paid call of an
 * RPC outage. Without code, x402 refuses the payment
 * (`asset_not_deployed_contract`), and treats the payer as an EOA, as it
 * already does when its own `getCode` of the payer fails.
 */
export function viemFacilitatorSigner(
  wallet: WalletClient<Transport, Chain, Account>,
  reader: PublicClient,
  confirmationTimeoutMs: number = CONFIRMATION_TIMEOUT_MS,
): FacilitatorEvmSigner {
  return toFacilitatorEvmSigner(
    {
      address: wallet.account.address,
      readContract: (args) => reader.readContract(args as Parameters<PublicClient["readContract"]>[0]),
      verifyTypedData: (args) => reader.verifyTypedData(args as Parameters<PublicClient["verifyTypedData"]>[0]),
      writeContract: (args) => wallet.writeContract({ ...args, account: wallet.account, chain: wallet.chain } as Parameters<typeof wallet.writeContract>[0]),
      sendTransaction: (args) => wallet.sendTransaction({ ...args, account: wallet.account, chain: wallet.chain } as Parameters<typeof wallet.sendTransaction>[0]),
      waitForTransactionReceipt: (args) => reader.waitForTransactionReceipt(args),
      getCode: (args) => reader.getCode(args).catch(() => undefined),
    },
    { confirmationTimeoutMs },
  );
}
