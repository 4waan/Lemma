/**
 * Lemma's own run on Arbitrum Sepolia on 2026-10-01, as recorded in
 * docs/deployments/arbitrum-sepolia.md: the contracts it deployed, and the
 * gas each on-chain step of a purchase used. These are measured facts of that
 * run, not of the server this page talks to; the Status page shows that
 * server's own contracts.
 */
export interface GasStep {
  readonly title: string;
  readonly detail: string;
  /** Gas used, from the transaction's receipt. */
  readonly gas: number;
  readonly tx: string;
}

export const DEPLOYMENT = {
  measuredOn: "2026-10-01",
  chainId: 421614,
  explorer: "https://sepolia.arbiscan.io",
  contracts: [
    { name: "Warranty registry", address: "0x0B0FdF70AD27B3404Bd4C7f317f56c2388305F14" },
    { name: "Score engine (Stylus)", address: "0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6" },
    { name: "USDC (Circle)", address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  ],
  /** The first purchase passed; the refund comes from the second, which failed. */
  steps: [
    { title: "Pay", detail: "The agent signs a USDC transfer. The facilitator sends it.", gas: 91_275, tx: "0x58792e541b6bb4024d93dc750c8cf2b84ee88a2c43f066b6e3e2f3a340e07693" },
    { title: "Start the warranty", detail: "The provider's bond reserves the price.", gas: 216_065, tx: "0x881b5bcf18ca707e61f3e67419c33bc8d4e172b31627f002e0497d2b5b5cf201" },
    { title: "Record the result", detail: "The test result is final and updates the score.", gas: 146_896, tx: "0x08e34b4db84c9e908accfce915d9bf1c5a1814ff0ffafb16031d364fb45a060a" },
    { title: "Refund", detail: "Only when the tests fail. The bond pays the buyer.", gas: 84_009, tx: "0x4d501efa6df5390e81980ad5508d322eec602ddfbb06b97eaa1d00f69cadf950" },
  ] satisfies readonly GasStep[],
  /** Gas, in ETH on Arbitrum Sepolia, of every transaction of one purchase: each stayed under this. */
  purchaseEthBelow: "0.00002",
  /** The Stylus program, compressed, and what recording one result into it costs when the release already has results. */
  engineKb: 19,
  recordGas: 63_000,
} as const;

/** Gas for a purchase that passes: pay, start the warranty, record the result. */
export const PASSING_PURCHASE_GAS = DEPLOYMENT.steps.slice(0, 3).reduce((sum, step) => sum + step.gas, 0);
