import { type Account, type Chain, type Hex, type Transport, type WalletClient, createPublicClient, createWalletClient, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import type { ServerConfig } from "../config.js";
import type { Logger } from "../log.js";
import type { PaidToolRegistrar } from "../mcp.js";
import type { LemmaStore } from "../persistence.js";
import type { ResolutionService } from "../service.js";
import { viemPaymentChain, viemSignatureVerifier } from "./chain.js";
import { inProcessFacilitator, paymentResourceServer, viemFacilitatorSigner } from "./facilitator.js";
import { ReceiptVerifier } from "./receipts.js";
import { SettlementReconciler } from "./reconciler.js";
import { paidToolRegistrar } from "./registrar.js";
import { redactingTransport } from "./rpc.js";

export * from "./chain.js";
export * from "./facilitator.js";
export * from "./handler.js";
export * from "./receipts.js";
export * from "./reconciler.js";
export * from "./registrar.js";
export * from "./rpc.js";

export const ARBITRUM_SEPOLIA_CHAIN_ID = 421_614;

/**
 * The facilitator's wallet client on Arbitrum Sepolia. Its account takes
 * transaction nonces from viem's nonce manager, so two settlements sent at
 * the same moment (two buyers paying at once) get consecutive nonces instead
 * of both reading the same pending count, where one would be refused; viem
 * resets the manager after a send fails, so a failure leaves no gap.
 */
export function facilitatorWallet(key: Hex, transport: Transport): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ account: privateKeyToAccount(key, { nonceManager }), chain: arbitrumSepolia, transport });
}

export interface PaymentPath {
  readonly registerPaidTools: PaidToolRegistrar;
  readonly reconciler: SettlementReconciler;
  readonly verifier: ReceiptVerifier;
  /** Stops the reconciler and the verifier. */
  stop(): void;
}

/**
 * Assembles the paid path for `main.ts` when `PAID_TOOLS=on`: viem clients on
 * the Arbitrum Sepolia RPC (errors scrubbed of the URL), the in-process x402
 * facilitator holding the facilitator key, the resource server and the paid
 * tool registrar, and the two background jobs (settlement reconciler, receipt
 * verifier), started here. It refuses an RPC that is not Arbitrum Sepolia.
 */
export async function startPaymentPath(deps: {
  readonly config: ServerConfig;
  readonly store: LemmaStore;
  readonly service: ResolutionService;
  readonly clock: () => Date;
  readonly logger: Logger;
}): Promise<PaymentPath> {
  const { rpcUrl, facilitatorKey } = deps.config.chain;
  if (rpcUrl === undefined || facilitatorKey === undefined) throw new Error("paid tools need ARBITRUM_SEPOLIA_RPC_URL and FACILITATOR_PRIVATE_KEY");
  const transport = redactingTransport(rpcUrl);
  const reader = createPublicClient({ chain: arbitrumSepolia, transport });
  const chainId = await reader.getChainId();
  if (chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) throw new Error(`ARBITRUM_SEPOLIA_RPC_URL serves chain ${chainId}, not ${ARBITRUM_SEPOLIA_CHAIN_ID}`);
  const wallet = facilitatorWallet(facilitatorKey.reveal() as Hex, transport);
  const account = wallet.account;
  const balance = await reader.getBalance({ address: account.address });
  if (balance === 0n) deps.logger.log("warn", "payments.facilitator_unfunded", { facilitator: account.address, note: "the facilitator has no ETH, so settlements will fail" });
  else deps.logger.log("info", "payments.facilitator", { facilitator: account.address, balanceWei: balance.toString() });

  const resourceServer = await paymentResourceServer(inProcessFacilitator(viemFacilitatorSigner(wallet, reader)));
  const registerPaidTools = paidToolRegistrar({ resourceServer, clock: deps.clock, logger: deps.logger });
  const reconciler = new SettlementReconciler({ service: deps.service, chain: viemPaymentChain(reader, deps.config.payment.asset), clock: deps.clock, logger: deps.logger });
  const verifier = new ReceiptVerifier({ store: deps.store, verifier: viemSignatureVerifier(reader), chainId: ARBITRUM_SEPOLIA_CHAIN_ID, clock: deps.clock, logger: deps.logger });
  const stops = [reconciler.start(), verifier.start()];
  return { registerPaidTools, reconciler, verifier, stop: () => stops.forEach((stop) => stop()) };
}
