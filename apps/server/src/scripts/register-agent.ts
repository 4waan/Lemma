/**
 * Registers Lemma's provider agent in the ERC-8004 identity registry on
 * Arbitrum Sepolia, or points it at a new registration file.
 *
 *   npm run agent:register -w @lemma/server                     register(agentURI), prints the agentId
 *   npm run agent:register -w @lemma/server -- --update <id>    setAgentURI(id, agentURI)
 *   ... -- --uri <https-url>                                    another agentURI than the default
 *
 * The agentURI defaults to `${PUBLIC_BASE_URL}/api/v1/agent/registration.json`.
 * The owner key comes from AGENT_OWNER_PRIVATE_KEY in the environment, never
 * from an argument, and must not be the attester's key: the registry refuses
 * feedback from an agent's owner, so the attester could never post.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

import { describeError } from "../errors.js";
import { loadReputationConfig, privateKeyFrom } from "../reputation/config.js";
import { REGISTRATION_PATH } from "../reputation/registration.js";
import { parseRegisterArgs, registerAgent, setAgentUri } from "../reputation/register.js";

function fail(message: string): never {
  console.error(`register-agent: ${message}`);
  process.exit(1);
}

const args = parseRegisterArgs(process.argv.slice(2));
if ("error" in args) fail(args.error);

let ownerKey: `0x${string}`;
try {
  ownerKey = privateKeyFrom(process.env["AGENT_OWNER_PRIVATE_KEY"], "AGENT_OWNER_PRIVATE_KEY");
} catch (error) {
  fail(error instanceof Error ? error.message : "AGENT_OWNER_PRIVATE_KEY is invalid");
}
const owner = privateKeyToAccount(ownerKey);

// The server's own settings (registries, base URL), without the attester's requirements: this script needs only the RPC URL.
let settings: ReturnType<typeof loadReputationConfig>;
try {
  settings = loadReputationConfig({ ...process.env, ATTESTER_PRIVATE_KEY: undefined, LEMMA_AGENT_ID: undefined });
} catch (error) {
  fail(error instanceof Error ? error.message : "invalid settings");
}
const attesterKey = process.env["ATTESTER_PRIVATE_KEY"];
if (attesterKey !== undefined && attesterKey !== "") {
  try {
    if (privateKeyToAccount(privateKeyFrom(attesterKey, "ATTESTER_PRIVATE_KEY")).address === owner.address) {
      fail("AGENT_OWNER_PRIVATE_KEY is the attester's key: use a separate owner key, or the registry will refuse every feedback the attester posts");
    }
  } catch {
    // An invalid attester key is the server's problem, reported there.
  }
}
const rpcUrl = process.env["ARBITRUM_SEPOLIA_RPC_URL"];
if (rpcUrl === undefined || rpcUrl === "") fail("ARBITRUM_SEPOLIA_RPC_URL is not set");
const agentURI = args.uri ?? (settings.publicBaseUrl === undefined ? undefined : `${settings.publicBaseUrl}${REGISTRATION_PATH}`);
if (agentURI === undefined) fail("set PUBLIC_BASE_URL (or pass --uri <https-url>) so the agent points at its registration file");
if (!agentURI.startsWith("https://")) fail("the agentURI is published on chain, so it must be https");

const transport = http(rpcUrl, { timeout: 30_000 });
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
const walletClient = createWalletClient({ account: owner, chain: arbitrumSepolia, transport });
try {
  const chainId = await publicClient.getChainId();
  if (chainId !== arbitrumSepolia.id) fail(`the RPC endpoint serves chain ${chainId}, not Arbitrum Sepolia (${arbitrumSepolia.id})`);
  const clients = { publicClient, walletClient, account: owner };
  if (args.update === undefined) {
    const { agentId, txHash } = await registerAgent(clients, settings.identityRegistry, agentURI);
    console.log(`registered agent ${agentId} (owner ${owner.address}, tx ${txHash})`);
    console.log(`agentURI ${agentURI}`);
    console.log(`set LEMMA_AGENT_ID=${agentId} on the server`);
  } else {
    const { txHash } = await setAgentUri(clients, settings.identityRegistry, BigInt(args.update), agentURI);
    console.log(`agent ${args.update} now points at ${agentURI} (tx ${txHash})`);
  }
} catch (error) {
  // Only the error's name and code: viem's messages repeat the RPC URL, which can carry an API key.
  fail(`the transaction failed (${describeError(error)})`);
}
