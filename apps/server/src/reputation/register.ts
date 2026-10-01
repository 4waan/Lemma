import { type Address, AgentId } from "@lemma/core";
import { type Account, type Hex, type PublicClient, type WalletClient, parseEventLogs } from "viem";

import { identityRegistryAbi } from "./abi.js";

/** The agent owner's clients: the owner signs, the public client simulates and waits. */
export interface OwnerClients {
  readonly publicClient: PublicClient;
  readonly walletClient: WalletClient;
  readonly account: Account;
}

/**
 * Registers a new ERC-8004 agent with `register(agentURI)`, owned by the
 * signing account, and returns its agentId from the `Registered` event of the
 * mined transaction (the value a simulation predicts can be taken by another
 * registration first).
 */
export async function registerAgent(c: OwnerClients, identityRegistry: Address, agentURI: string): Promise<{ readonly agentId: bigint; readonly txHash: Hex }> {
  const registry = identityRegistry as Hex;
  const { request } = await c.publicClient.simulateContract({ address: registry, abi: identityRegistryAbi, functionName: "register", args: [agentURI], account: c.account });
  const txHash = await c.walletClient.writeContract({ ...request, account: c.account, chain: c.publicClient.chain });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`register reverted (${txHash})`);
  const logs = receipt.logs.filter((log) => log.address.toLowerCase() === identityRegistry);
  const registered = parseEventLogs({ abi: identityRegistryAbi, eventName: "Registered", logs }).find((e) => e.args.owner.toLowerCase() === c.account.address.toLowerCase());
  if (registered === undefined) throw new Error(`no Registered event for this owner in ${txHash}`);
  return { agentId: registered.args.agentId, txHash };
}

/** Points an existing agent at a new registration file with `setAgentURI`; the signer must own or operate it. */
export async function setAgentUri(c: OwnerClients, identityRegistry: Address, agentId: bigint, agentURI: string): Promise<{ readonly txHash: Hex }> {
  const { request } = await c.publicClient.simulateContract({
    address: identityRegistry as Hex,
    abi: identityRegistryAbi,
    functionName: "setAgentURI",
    args: [agentId, agentURI],
    account: c.account,
  });
  const txHash = await c.walletClient.writeContract({ ...request, account: c.account, chain: c.publicClient.chain });
  const receipt = await c.publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`setAgentURI reverted (${txHash})`);
  return { txHash };
}

export interface RegisterArgs {
  /** `--update <agentId>`: call setAgentURI on this agent instead of registering a new one. */
  readonly update: AgentId | undefined;
  /** `--uri <url>`: the agentURI; default `${PUBLIC_BASE_URL}/api/v1/agent/registration.json`. */
  readonly uri: string | undefined;
}

export const REGISTER_USAGE = "usage: register-agent [--update <agentId>] [--uri <https-url>]   (AGENT_OWNER_PRIVATE_KEY, ARBITRUM_SEPOLIA_RPC_URL and PUBLIC_BASE_URL come from the environment)";

/**
 * The register script's arguments. A key is never an argument (it would land
 * in shell history and the process list): anything shaped like one is refused
 * without being repeated.
 */
export function parseRegisterArgs(argv: readonly string[]): RegisterArgs | { readonly error: string } {
  if (argv.some((a) => /0x[0-9a-fA-F]{64}/.test(a))) return { error: "a private key is never an argument: set AGENT_OWNER_PRIVATE_KEY in the environment" };
  let update: AgentId | undefined;
  let uri: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = argv[i + 1];
    if (a === "--update" && value !== undefined) {
      const id = AgentId.safeParse(value);
      if (!id.success) return { error: "--update takes a decimal agent id" };
      update = id.data;
      i++;
    } else if (a === "--uri" && value !== undefined) {
      if (!/^https:\/\/[^\s]+$/.test(value)) return { error: "--uri takes an https URL" };
      uri = value;
      i++;
    } else return { error: REGISTER_USAGE };
  }
  return { update, uri };
}
