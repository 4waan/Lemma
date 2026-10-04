/**
 * Lemma's own run on Arbitrum Sepolia on 2026-10-01, as recorded in
 * docs/deployments/arbitrum-sepolia.md: the contracts it deployed, a payment,
 * and a refund. These are facts of that run, not of the server this page talks
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
