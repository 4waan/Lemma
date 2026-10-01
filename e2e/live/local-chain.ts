/**
 * Prepares a local anvil to pose as Arbitrum Sepolia, so the live run's
 * commands can be rehearsed before any testnet funds are spent (e2e/README.md,
 * "Live run on Arbitrum Sepolia"):
 *
 *   anvil --chain-id 421614 --accounts 0 --block-time 1 --mixed-mining --port 8546 &
 *   tsx e2e/live/local-chain.ts chain --rpc http://127.0.0.1:8546 --dir <rehearsal directory outside the repository>
 *   tsx e2e/live/local-chain.ts engine --rpc http://127.0.0.1:8546 --owner-key-file <deployer.key> --registry <address>
 *
 * `chain` installs the local run's fixtures (Circle's FiatTokenV2_2 at the
 * Arbitrum Sepolia USDC address, and the official ERC-8004 registries), makes
 * a funder key file (`<dir>/funder.key`, mode 0600) holding 1 ETH and 20
 * USDC, and prints the registries' addresses. `engine` deploys the Solidity
 * stand-in for the Stylus engine (anvil cannot run Stylus), owned by the key
 * file's account and recording only from `--registry`, and prints its
 * address. Both refuse an RPC that is not on this machine, and print no key.
 */
import { writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readKeyFile } from "@lemma/bridge";
import { toAddress } from "@lemma/core";
import { encodeDeployData } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { deployErc8004, installUsdc, localChain, runtimeKey } from "../lib/chain.js";
import { ROOT, forgeArtifact } from "../lib/tools.js";

function fail(message: string): never {
  console.error(`live-local-chain: ${message}`);
  process.exit(1);
}

const USAGE = [
  "usage: tsx e2e/live/local-chain.ts chain --rpc <local anvil url> --dir <rehearsal directory outside the repository>",
  "       tsx e2e/live/local-chain.ts engine --rpc <local anvil url> --owner-key-file <deployer.key> --registry <address>",
].join("\n");

let parsed;
try {
  parsed = parseArgs({ allowPositionals: true, strict: true, options: { rpc: { type: "string" }, dir: { type: "string" }, "owner-key-file": { type: "string" }, registry: { type: "string" } } });
} catch {
  fail(USAGE);
}
const [command] = parsed.positionals;
const { rpc, dir, "owner-key-file": ownerKeyFile, registry } = parsed.values;
if (rpc === undefined || parsed.positionals.length !== 1) fail(USAGE);
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpc).hostname)) fail("--rpc must be a local anvil: this command sets code and balances");
const chain = localChain(rpc);
if ((await chain.publicClient.getChainId()) !== 421_614) fail("the local chain must pose as Arbitrum Sepolia (anvil --chain-id 421614)");

if (command === "chain") {
  if (dir === undefined) fail(USAGE);
  const out = resolve(dir);
  const rel = relative(ROOT, out);
  if (!isAbsolute(rel) && !rel.startsWith("..")) fail("--dir is inside the repository; keep keys outside it");
  const usdc = await installUsdc(chain);
  const { identity, reputation } = await deployErc8004(chain);
  const funder = runtimeKey();
  writeFileSync(join(out, "funder.key"), `${funder.key}\n`, { mode: 0o600, flag: "wx" });
  await chain.fund(funder.address, "1");
  await usdc.mint(funder.address, 20_000_000n);
  console.log(`USDC (FiatTokenV2_2) ${usdc.address}`);
  console.log(`ERC8004_IDENTITY_REGISTRY=${identity}`);
  console.log(`ERC8004_REPUTATION_REGISTRY=${reputation}`);
  console.log(`funder ${funder.address}: 1 ETH and 20 USDC, key in ${join(out, "funder.key")}`);
} else if (command === "engine") {
  if (ownerKeyFile === undefined || registry === undefined) fail(USAGE);
  const key = readKeyFile(resolve(ownerKeyFile));
  const standIn = forgeArtifact(join(ROOT, "e2e", "contracts", "out"), "ConfidenceStandIn.sol", "ConfidenceStandIn");
  const owner = toAddress(privateKeyToAccount(key).address);
  const { address } = await chain.deploy(key, encodeDeployData({ abi: standIn.abi, bytecode: standIn.bytecode, args: [owner, toAddress(registry)] }));
  console.log(`engine stand-in ${address}, owner ${owner}, records only from ${toAddress(registry)}`);
} else fail(USAGE);
