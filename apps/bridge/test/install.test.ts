import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installCommands, installEnv, runInstalls, walletKeys } from "../src/index.js";
import { removeTemps, temp, tree } from "./fixtures.js";

afterEach(removeTemps);

describe("installCommands", () => {
  const deps = { "b-pkg": "^1.0.0", "a-pkg": ">=2.0.0 <3" };
  it("disables lifecycle scripts for every package manager and targets the package", () => {
    const flat = tree({ "package.json": "{}" });
    expect(installCommands({ packageManager: "npm", packageDir: flat, lockDir: flat }, deps, { vitest: "5.0.1" })).toEqual([
      { cwd: flat, argv: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save", "a-pkg@>=2.0.0 <3", "b-pkg@^1.0.0"] },
      { cwd: flat, argv: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-dev", "--save-exact", "vitest@5.0.1"] },
    ]);
    const mono = tree({ "package.json": '{"workspaces":["apps/*"]}', "apps/api/package.json": "{}", "pnpm-workspace.yaml": "packages: []\n", "yarn.lock": "__metadata:\n  version: 8\n" });
    const api = join(mono, "apps", "api");
    expect(installCommands({ packageManager: "npm", packageDir: api, lockDir: mono }, { x: "1.0.0" }, {})[0]).toEqual({ cwd: mono, argv: ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--save", "--save-exact", "--workspace", "apps/api", "x@1.0.0"] });
    expect(installCommands({ packageManager: "pnpm", packageDir: mono, lockDir: mono }, { x: "1.0.0" }, {})[0]?.argv).toEqual(["pnpm", "add", "--ignore-scripts", "--ignore-pnpmfile", "--workspace-root", "x@1.0.0"]);
    expect(installCommands({ packageManager: "yarn", packageDir: api, lockDir: mono }, { x: "1.0.0" }, {})[0]?.argv).toEqual(["yarn", "add", "--mode=skip-build", "x@1.0.0"]);
    const classic = tree({ "package.json": '{"workspaces":["apps/*"]}', "yarn.lock": "# yarn lockfile v1\n" });
    expect(installCommands({ packageManager: "yarn", packageDir: classic, lockDir: classic }, {}, { x: "1.0.0" })[0]?.argv).toEqual(["yarn", "add", "--ignore-scripts", "--dev", "-W", "x@1.0.0"]);
    // Exact pins and ranges are saved as given: npm installs exact ones on their own with --save-exact.
    expect(installCommands({ packageManager: "npm", packageDir: flat, lockDir: flat }, { a: "^1.0.0", b: "2.0.0", c: "=3.0.0", d: "v4.0.0" }, {}).map((c) => c.argv.slice(5))).toEqual([["--save", "a@^1.0.0"], ["--save", "--save-exact", "b@2.0.0", "c@=3.0.0", "d@v4.0.0"]]);
  });

  it("never gives installs a wallet key or the bridge's settings, and keeps what registry config reads", () => {
    const env = installEnv({
      PATH: "/usr/bin",
      HOME: "/h",
      HTTPS_PROXY: "http://proxy",
      npm_config_registry: "https://r",
      NPM_TOKEN: "t",
      GITHUB_TOKEN: "g",
      PRIVATE_REGISTRY_URL: "https://p",
      WALLET_ADDRESS: "0xa",
      BUYER_PRIVATE_KEY: "0x1",
      BUYER_KEY: "0x2",
      npm_config_wallet_mnemonic: "w",
      SIGNER_KEY: "k",
      WALLET_SECRET: "s",
      DEPLOYER_PRIVATE: "d",
      LEMMA_API_URL: "u",
      CURSOR_API_KEY: "c",
      ARBITRUM_SEPOLIA_RPC_URL: "https://rpc/key",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", HTTPS_PROXY: "http://proxy", npm_config_registry: "https://r", NPM_TOKEN: "t", GITHUB_TOKEN: "g", PRIVATE_REGISTRY_URL: "https://p", WALLET_ADDRESS: "0xa", npm_config_ignore_scripts: "true", YARN_ENABLE_SCRIPTS: "false" });
  });

  it("uses one list of wallet secret names for installs and for the verify refusal", () => {
    const names = [
      "BUYER_KEY",
      "BUYER_PRIVATE_KEY",
      "BUYER_PK",
      "ETH_PRIVKEY",
      "ETH_SIGNING_KEY",
      "RECEIPT_SIGNING_KEY",
      "SIGNER_KEY",
      "WALLET_KEY",
      "WALLET_SECRET",
      "WALLET_SEED",
      "SIGNER_SECRET",
      "WALLET_PASSPHRASE",
      "DEPLOYER_PRIVATE",
      "WALLET_MNEMONIC",
      "SEED_PHRASE",
      "SECRET_RECOVERY_PHRASE",
      "WALLET_ADDRESS",
      "PRIVATE_REGISTRY_URL",
      "NPM_TOKEN",
      "GITHUB_TOKEN",
    ];
    for (const name of names) expect({ name, toInstalls: name in installEnv({ [name]: "x" }) }).toEqual({ name, toInstalls: walletKeys({ [name]: "x" }, {}).length === 0 });
    expect(walletKeys({ WALLET_ADDRESS: "0xa", PRIVATE_REGISTRY_URL: "https://p", WALLET_SECRET: "s", DEPLOYER_PRIVATE: "d", BUYER_KEY: "k" }, {})).toEqual(["BUYER_KEY", "DEPLOYER_PRIVATE", "WALLET_SECRET"]);
  });

  it("stops an install whose group could not be recorded, and reports it only once the install is gone", async () => {
    const dir = temp("lemma-install-");
    const script = `setTimeout(() => require("fs").writeFileSync("late.txt", "x"), 700)`;
    await expect(runInstalls([{ cwd: dir, argv: [process.execPath, "-e", script] }], { env: { PATH: process.env["PATH"] ?? "" }, timeoutSec: 30, onGroup: () => { throw new Error("disk full"); } })).rejects.toThrow("disk full");
    await new Promise((r) => setTimeout(r, 1000));
    expect(existsSync(join(dir, "late.txt"))).toBe(false);
  });
});
