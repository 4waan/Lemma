#!/usr/bin/env node
import { join } from "node:path";

import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { DAY_MS, SpendLedger } from "../ledger.js";
import { KeyFileError, initKeyFile, readKeyFile } from "./keyfile.js";
import { signerPaths, signerSocketMode } from "./paths.js";
import { spendingPolicyFromEnv } from "./policy.js";
import { RECEIPT_MEMORY_MS } from "./receipts.js";
import { LocalSigner } from "./signer.js";
import { serveSigner } from "./socket.js";

/**
 * `lemma-signer`: the buyer's signer, a separate process that holds the buyer
 * key so the bridge (and the acceptance tests and installs it starts) never
 * does.
 *
 * - `lemma-signer init` creates the key file (mode 0600) and prints the address to fund.
 * - `lemma-signer serve` signs over a Unix socket, within its own spending policy and ledger.
 *
 * Environment: LEMMA_SIGNER_KEY_FILE (default `<state>/signer/key`),
 * LEMMA_SIGNER_SOCKET (default `<state>/signer/signer.sock`),
 * LEMMA_SIGNER_SOCKET_MODE (`600`, the default when unset or empty, or `660`
 * for a signer run as another user sharing a group with the bridge), LEMMA_STATE_DIR (default
 * `$XDG_STATE_HOME/lemma`), and the policy: LEMMA_MAX_USDC_PER_RESOLUTION,
 * LEMMA_DAILY_USDC_CAP, LEMMA_ALLOWED_PAY_TO. The key is never read from the
 * environment or an argument.
 */
async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (rest.length > 0 || (command !== "init" && command !== "serve")) {
    console.error("usage: lemma-signer init | lemma-signer serve");
    return 2;
  }
  let paths: ReturnType<typeof signerPaths>;
  try {
    paths = signerPaths();
  } catch (error) {
    console.error(`lemma-signer: ${error instanceof Error ? error.message : "invalid environment"}`);
    return 2;
  }
  if (command === "init") {
    try {
      const address = initKeyFile(paths.keyFile);
      console.log(`lemma-signer: created ${paths.keyFile}. Buyer address: ${getAddress(address)}. Fund it with testnet USDC on Arbitrum Sepolia; it needs no ETH.`);
      return 0;
    } catch (error) {
      console.error(`lemma-signer: ${error instanceof KeyFileError ? error.message : "the key file could not be created"}`);
      return 1;
    }
  }
  const policy = spendingPolicyFromEnv(process.env);
  if (!policy.ok) {
    console.error(`lemma-signer: ${policy.problems.join("; ")}`);
    return 2;
  }
  const mode = signerSocketMode(process.env);
  if (mode === undefined) {
    console.error("lemma-signer: LEMMA_SIGNER_SOCKET_MODE must be 600 or 660");
    return 2;
  }
  let account;
  try {
    account = privateKeyToAccount(readKeyFile(paths.keyFile));
  } catch (error) {
    // Never the library's message: it could quote the key.
    console.error(`lemma-signer: ${error instanceof KeyFileError ? error.message : "the key file does not hold a valid key"}`);
    return 1;
  }
  const signer = new LocalSigner(account, policy.policy, new SpendLedger(join(paths.dir, "ledger"), DAY_MS, RECEIPT_MEMORY_MS));
  const log = (event: Record<string, unknown>) => console.error(JSON.stringify({ at: new Date().toISOString(), ...event }));
  let server;
  try {
    server = await serveSigner(signer, { socketPath: paths.socket, mode, log });
  } catch (error) {
    console.error(`lemma-signer: could not listen on ${paths.socket} (${error instanceof Error ? error.message : "error"})`);
    return 1;
  }
  console.error(`lemma-signer: ${account.address} signing on ${paths.socket} (per purchase ${policy.policy.maxPerResolutionUsdc}, daily ${policy.policy.dailyCapUsdc} atomic USDC)`);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(signal, () => void server.close().then(() => process.exit(0)));
  }
  return 0;
}

process.exitCode = await main();
