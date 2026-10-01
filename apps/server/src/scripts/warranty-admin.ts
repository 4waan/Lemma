/**
 * The warranty registry's operator commands, run from an operator's machine
 * (never the server) against Arbitrum Sepolia; the deployment runbook
 * (docs/deployment.md) runs them in order after deploying the registry and
 * the Stylus engine.
 *
 *   npm run warranty:admin -w @lemma/server -- status
 *   npm run warranty:admin -w @lemma/server -- set-engine <engine address>
 *   npm run warranty:admin -w @lemma/server -- register-release <releaseId@version>
 *   npm run warranty:admin -w @lemma/server -- deposit-bond <releaseId@version> <atomic USDC>
 *   npm run warranty:admin -w @lemma/server -- set-priors [<releaseId@version> ...]
 *   ... [--catalog <dir>] [--provisional]
 *
 * Releases come from the packaged catalog (or `--catalog`), with the testnet
 * provisional overlay only under `--provisional`. The environment holds
 * everything else: ARBITRUM_SEPOLIA_RPC_URL and
 * RESOLUTION_WARRANTY_REGISTRY_ADDRESS; PROVIDER_ADDRESS and
 * EVALUATOR_ADDRESS for register-release; and the one key each command signs
 * with: REGISTRY_OWNER_PRIVATE_KEY (register-release, set-engine),
 * PROVIDER_PRIVATE_KEY (deposit-bond), ENGINE_OWNER_PRIVATE_KEY (set-priors).
 * A key is never an argument. Every command checks the chain (421614), the
 * registry and the signer's role before it sends, sends nothing that is done
 * already, and prints each transaction hash; `status` needs no key.
 */
import { type Address, toAddress } from "@lemma/core";
import { type Hex, createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { describeError } from "../errors.js";
import { privateKeyFrom } from "../reputation/config.js";
import {
  AdminError,
  type AdminWallet,
  catalogReleases,
  checkChain,
  depositBond,
  parseAdminArgs,
  printStatus,
  priorsFor,
  registerRelease,
  releaseNamed,
  setEngine,
  setPriors,
} from "../warranty/admin.js";

function fail(message: string): never {
  console.error(`warranty-admin: ${message}`);
  process.exit(1);
}

const args = parseAdminArgs(process.argv.slice(2));
if ("error" in args) fail(args.error);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") fail(`${name} is not set`);
  return value;
}

function address(name: string): Address {
  try {
    return toAddress(required(name));
  } catch {
    fail(`${name} is not an address with a valid checksum`);
  }
}

const rpcUrl = required("ARBITRUM_SEPOLIA_RPC_URL");
const transport = http(rpcUrl, { timeout: 30_000 });
const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
const ctx = { publicClient, registry: address("RESOLUTION_WARRANTY_REGISTRY_ADDRESS"), print: (line: string) => console.log(line) };

/** The wallet of the key in `name`; the error names the variable, never the value. */
function wallet(name: string): AdminWallet {
  let key: Hex;
  try {
    key = privateKeyFrom(process.env[name], name);
  } catch (error) {
    fail(error instanceof Error ? error.message : `${name} is invalid`);
  }
  return createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia, transport }) as AdminWallet;
}

try {
  await checkChain(ctx);
  switch (args.command) {
    case "status":
      await printStatus(ctx, catalogReleases(args.catalog, args.provisional));
      break;
    case "register-release": {
      const release = releaseNamed(catalogReleases(args.catalog, args.provisional), args.release);
      await registerRelease(ctx, wallet("REGISTRY_OWNER_PRIVATE_KEY"), release, { provider: address("PROVIDER_ADDRESS"), evaluator: address("EVALUATOR_ADDRESS") });
      break;
    }
    case "deposit-bond":
      await depositBond(ctx, wallet("PROVIDER_PRIVATE_KEY"), releaseNamed(catalogReleases(args.catalog, args.provisional), args.release), args.amount);
      break;
    case "set-engine":
      await setEngine(ctx, wallet("REGISTRY_OWNER_PRIVATE_KEY"), args.engine);
      break;
    case "set-priors":
      await setPriors(ctx, wallet("ENGINE_OWNER_PRIVATE_KEY"), priorsFor(catalogReleases(args.catalog, false), args.releases));
      break;
  }
} catch (error) {
  // An AdminError names variables, addresses and codes; anything else, only its name and code: viem's messages repeat the RPC URL.
  fail(error instanceof AdminError ? error.message : `failed (${describeError(error)})`);
}
