import { readFileSync } from "node:fs";

/**
 * Names of wallet and signing secrets: private and signing keys, mnemonics,
 * seed and recovery phrases, and the key, secret, password, passphrase, seed
 * or private key of a wallet, signer, buyer or deployer. Installs never get
 * them, and acceptance tests are not run while the bridge's environment
 * holds one (`walletKeys`).
 */
export const WALLET_SECRET = /PRIVATE_?KEY|PRIVKEY|SIGNING_?KEY|MNEMONIC|SEED_?PHRASE|RECOVERY_?PHRASE|(WALLET|SIGNER|BUYER|DEPLOYER)_?(KEY|SECRET|PASS(WORD|PHRASE)?|PRIVATE|SEED|PK)/i;

/** Names of wallet secrets set in the current environment or, on Linux, the one the process started with. */
export function walletKeys(env: NodeJS.ProcessEnv = process.env, start: NodeJS.ProcessEnv = startEnvironment()): string[] {
  const names = new Set<string>();
  for (const source of [env, start]) {
    for (const [name, value] of Object.entries(source)) if (value !== undefined && value !== "" && WALLET_SECRET.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** The environment this process started with, as other processes of the user can read it; empty where there is no /proc. */
function startEnvironment(): NodeJS.ProcessEnv {
  try {
    const env: NodeJS.ProcessEnv = {};
    for (const entry of readFileSync("/proc/self/environ", "utf8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return env;
  } catch {
    return {};
  }
}
