import type { Address } from "@lemma/core";
import { reputationRegistryAbi, warrantyRegistryAbi } from "@lemma/server";
import { type Hex, type PublicClient, parseAbi, size } from "viem";

/**
 * The gas of every on-chain action a paid resolution can cause, whoever pays
 * for it: the input to the chain cost `g` in packages/catalog/economics.json
 * (docs/economic-gates.md, "Chain cost"). Measured on the run's chain, so it
 * is L2 execution gas only; e2e/README.md says what that leaves out.
 */
export const STEPS = ["settlement", "activation", "outcome", "feedback", "withdrawal", "expiry"] as const;
export type Step = (typeof STEPS)[number];

/** The steps each way a paid resolution can end sends. */
export const ENDINGS = {
  passed: ["settlement", "activation", "outcome", "feedback"],
  refunded: ["settlement", "activation", "outcome", "feedback", "withdrawal"],
  expired: ["settlement", "activation", "expiry"],
} as const satisfies Record<string, readonly Step[]>;
export type Ending = keyof typeof ENDINGS;

export interface StepGas {
  /** How many transactions of this step the run sent. */
  readonly transactions: number;
  readonly minGas: bigint;
  readonly maxGas: bigint;
  /** The largest calldata, in bytes: what the L1 part of an Arbitrum fee grows with. */
  readonly maxCalldataBytes: number;
}

export interface GasReport {
  readonly steps: Readonly<Record<Step, StepGas>>;
  /** Per ending, the sum of its steps' largest gas: an upper bound for one resolution that ends that way. */
  readonly endings: Readonly<Record<Ending, bigint>>;
}

const authorizationUsed = parseAbi(["event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"]);

/** Which registry event marks which step. */
const REGISTRY_STEPS: Readonly<Record<string, Step>> = {
  ResolutionActivated: "activation",
  OutcomeFinalized: "outcome",
  CreditWithdrawn: "withdrawal",
  ResolutionExpired: "expiry",
};

/**
 * Finds each step's transactions from `fromBlock` by the events they emitted
 * (USDC's `AuthorizationUsed` for an x402 settlement, the registry's own
 * events, the reputation registry's `NewFeedback`), then reads their gas and
 * calldata. Throws when the run sent no transaction of some step, so the
 * report never leaves a step out.
 */
export async function measureGas(client: PublicClient, at: { usdc: Address; registry: Address; reputation: Address; fromBlock: bigint }): Promise<GasReport> {
  const hashes = new Map<Step, Set<Hex>>(STEPS.map((s) => [s, new Set<Hex>()]));
  const add = (step: Step | undefined, hash: Hex | null) => {
    if (step !== undefined && hash !== null) hashes.get(step)?.add(hash);
  };
  const fromBlock = at.fromBlock;
  for (const log of await client.getContractEvents({ address: at.usdc as Hex, abi: authorizationUsed, eventName: "AuthorizationUsed", fromBlock })) add("settlement", log.transactionHash);
  for (const log of await client.getContractEvents({ address: at.registry as Hex, abi: warrantyRegistryAbi, fromBlock })) add(REGISTRY_STEPS[log.eventName], log.transactionHash);
  for (const log of await client.getContractEvents({ address: at.reputation as Hex, abi: reputationRegistryAbi, eventName: "NewFeedback", fromBlock })) add("feedback", log.transactionHash);

  const steps = {} as Record<Step, StepGas>;
  for (const step of STEPS) {
    const sent = [...(hashes.get(step) ?? [])];
    if (sent.length === 0) throw new Error(`the run sent no ${step} transaction`);
    const measured = await Promise.all(
      sent.map(async (hash) => {
        const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
        return { gas: receipt.gasUsed, calldata: size(tx.input) };
      }),
    );
    const gas = measured.map((m) => m.gas);
    steps[step] = {
      transactions: sent.length,
      minGas: gas.reduce((a, b) => (b < a ? b : a)),
      maxGas: gas.reduce((a, b) => (b > a ? b : a)),
      maxCalldataBytes: Math.max(...measured.map((m) => m.calldata)),
    };
  }
  const endings = {} as Record<Ending, bigint>;
  for (const ending of Object.keys(ENDINGS) as Ending[]) endings[ending] = ENDINGS[ending].reduce((sum, step) => sum + steps[step].maxGas, 0n);
  return { steps, endings };
}

/** The report as a table for the run's output. */
export function formatGasReport(report: GasReport): string {
  const lines = ["gas per resolution step (anvil: L2 execution gas only, the engine a Solidity stand-in; see e2e/README.md)", "step         txs   min gas   max gas   max calldata bytes"];
  for (const step of STEPS) {
    const s = report.steps[step];
    lines.push(`${step.padEnd(12)} ${String(s.transactions).padStart(3)} ${String(s.minGas).padStart(9)} ${String(s.maxGas).padStart(9)} ${String(s.maxCalldataBytes).padStart(20)}`);
  }
  lines.push("ending       max gas per resolution");
  for (const ending of Object.keys(ENDINGS) as Ending[]) lines.push(`${ending.padEnd(12)} ${String(report.endings[ending]).padStart(9)}   (${ENDINGS[ending].join(" + ")})`);
  return lines.join("\n");
}
