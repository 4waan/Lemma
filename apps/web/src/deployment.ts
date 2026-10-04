/**
 * Lemma's own run on Arbitrum Sepolia on 2026-10-01, as recorded in
 * docs/deployments/arbitrum-sepolia.md: the contracts it deployed, and its
 * two purchases, one that passed and one that was refunded. These are facts of that run, not of the server this page talks
 * to; the Status page shows that server's own contracts.
 */
export const DEPLOYMENT = {
  measuredOn: "2026-10-01",
  chainId: 421614,
  explorer: "https://sepolia.arbiscan.io",
  registry: "0x0B0FdF70AD27B3404Bd4C7f317f56c2388305F14",
  /** The Stylus program that keeps each release's score. */
  engine: "0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6",
  usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
  /** The first purchase's USDC settlement: the agent signed it, the facilitator sent it. */
  paymentTx: "0x58792e541b6bb4024d93dc750c8cf2b84ee88a2c43f066b6e3e2f3a340e07693",
  /** The second purchase failed its tests; the bond refunded the buyer here. */
  refundTx: "0x4d501efa6df5390e81980ad5508d322eec602ddfbb06b97eaa1d00f69cadf950",
} as const;

export interface PurchaseStep {
  readonly label: string;
  readonly tx: string;
}

export interface RecordedPurchase {
  readonly title: string;
  readonly outcome: "passed" | "refunded";
  readonly summary: string;
  readonly steps: readonly PurchaseStep[];
}

/**
 * The run's two purchases, each step a transaction anyone can open. Both
 * bought the same test release (payment-gating-demo, whose benchmark numbers
 * were made up for the run) through the shipped bridge, signer and x402.
 */
export const PURCHASES: readonly RecordedPurchase[] = [
  {
    title: "Purchase 1",
    outcome: "passed",
    summary: "Paid 0.25 USDC. The tests passed, and the result is on chain.",
    steps: [
      { label: "Paid 0.25 USDC over x402", tx: DEPLOYMENT.paymentTx },
      { label: "Warranty started from the bond", tx: "0x881b5bcf18ca707e61f3e67419c33bc8d4e172b31627f002e0497d2b5b5cf201" },
      { label: "Tests passed, recorded on chain", tx: "0x08e34b4db84c9e908accfce915d9bf1c5a1814ff0ffafb16031d364fb45a060a" },
    ],
  },
  {
    title: "Purchase 2",
    outcome: "refunded",
    summary: "Paid 0.25 USDC. The tests failed, and the bond paid it back.",
    steps: [
      { label: "Paid 0.25 USDC over x402", tx: "0xb6a9dd4daa4e78c879194cd1c9b7a3ee73d36d04a36be3217e5007a6c4d75b14" },
      { label: "Warranty started from the bond", tx: "0xd4f2eb492ce8ac5e7bd88d6cffcb9ab0a8bd33816b031c1264a9c0d120a665ce" },
      { label: "Tests failed, recorded on chain", tx: "0xe2e4b36a88e71a7f7faf77a12aa3673f34141faa2502fc65b8d5ceed8971efd0" },
      { label: "Refunded 0.25 USDC to the buyer", tx: DEPLOYMENT.refundTx },
    ],
  },
];
