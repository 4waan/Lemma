/**
 * Creates Lemma's Arbitrum Sepolia role keys and funds them, for the
 * deployment runbook (docs/deployment.md):
 *
 *   ARBITRUM_SEPOLIA_RPC_URL=... ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY=... \
 *     npm run sepolia:roles -- --dir <private directory outside the repository>
 *
 * One key file per role in `--dir` (mode 0700): `<role>.key`, mode 0600, in
 * lemma-signer's key file format, made the way `lemma-signer init` makes one
 * and never overwritten, so a second run reuses them; and `roles.json` with
 * the public addresses only. Each role has one job (docs/deployment.md, Role
 * separation):
 *
 * - deployer: deploys the registry and the Stylus engine and owns both
 *   (registers releases, sets the engine and the priors, pauses)
 * - provider: the x402 recipient; signs vouchers, activates and expires
 *   warranties, and deposits the bond
 * - facilitator: pays settlement gas
 * - evaluator: signs outcomes, finalizes them and relays credit withdrawals
 * - attester: posts ERC-8004 feedback
 * - agent-owner: owns the provider's ERC-8004 agent (kept off the server)
 * - buyer: pays for purchases in USDC through lemma-signer; holds no ETH
 *
 * Funding tops each role up to its target from the funder key (never above
 * it, so a second run sends only what is missing): testnet ETH for gas to
 * every role but the buyer, and testnet USDC to the provider (bond) and the
 * buyer (purchases). The funder key comes from the environment only, and no
 * key is ever printed. Options (amounts are testnet): --gas-eth <ETH per
 * role, default 0.003>, --deployer-eth <default 0.01>, --provider-usdc
 * <atomic, default 5000000>, --buyer-usdc <atomic, default 2000000>.
 */
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { initKeyFile, readKeyFile } from "@lemma/bridge";
import { ARBITRUM_SEPOLIA_USDC, type Address, formatUsdc, toAddress } from "@lemma/core";
import { type Hex, createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

/** The repository this script lives in; the keys must never land inside it. */
const REPOSITORY = fileURLToPath(new URL("../..", import.meta.url));

const ROLES = ["deployer", "provider", "facilitator", "evaluator", "attester", "agent-owner", "buyer"] as const;
type Role = (typeof ROLES)[number];

const USAGE = "usage: setup-roles --dir <private directory outside the repository> [--gas-eth <ETH>] [--deployer-eth <ETH>] [--provider-usdc <atomic>] [--buyer-usdc <atomic>]";

function fail(message: string): never {
  console.error(`setup-roles: ${message}`);
  process.exit(1);
}

interface Options {
  readonly dir: string;
  readonly gasWei: bigint;
  readonly deployerWei: bigint;
  readonly providerUsdc: bigint;
  readonly buyerUsdc: bigint;
}

/** 32 bytes of hex, with or without `0x` (many wallets export keys bare), anywhere in an argument. */
const KEY_SHAPED = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:$|[^0-9a-fA-F])/;

function parseOptions(argv: readonly string[]): Options {
  if (argv.some((a) => KEY_SHAPED.test(a))) fail("a private key is never an argument: set ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY in the environment");
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] as string;
    const value = argv[i + 1];
    if (!["--dir", "--gas-eth", "--deployer-eth", "--provider-usdc", "--buyer-usdc"].includes(name) || value === undefined) fail(USAGE);
    values.set(name, value);
  }
  const dir = values.get("--dir");
  if (dir === undefined) fail(USAGE);
  const eth = (name: string, fallback: string) => {
    const value = values.get(name) ?? fallback;
    if (!/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,18})?$/.test(value)) fail(`${name} takes an amount of ETH such as 0.005`);
    return parseEther(value);
  };
  const atomic = (name: string, fallback: string) => {
    const value = values.get(name) ?? fallback;
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value)) fail(`${name} takes a whole number of atomic USDC (1000000 is 1 USDC)`);
    return BigInt(value);
  };
  return { dir: resolve(dir), gasWei: eth("--gas-eth", "0.003"), deployerWei: eth("--deployer-eth", "0.01"), providerUsdc: atomic("--provider-usdc", "5000000"), buyerUsdc: atomic("--buyer-usdc", "2000000") };
}

/** Whether `path` is `root` or inside it, following links. */
function inside(root: string, path: string): boolean {
  const real = (p: string) => {
    let existing = p;
    while (!existsSync(existing)) existing = dirname(existing);
    return join(realpathSync(existing), relative(existing, p));
  };
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The key directory: created 0700, or an existing directory of this user's that nobody else can enter. */
function keyDirectory(dir: string): void {
  if (inside(REPOSITORY, dir)) fail(`--dir is inside the repository (${REPOSITORY}); keep keys outside it`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) fail("--dir is not a directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("--dir belongs to another user");
  if ((stat.mode & 0o077) !== 0) fail("--dir can be read or entered by others: make it private (chmod 700) first");
}

/** The funder's key from the environment; the message never repeats the value. */
function funderKey(): Hex {
  const value = process.env["ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY"];
  if (value === undefined || value === "") fail("ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY is not set");
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) fail("ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY must be 0x followed by 64 hex digits; its value is not shown");
  try {
    privateKeyToAccount(value as Hex);
  } catch {
    fail("ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY is not a valid secp256k1 private key; its value is not shown");
  }
  return value as Hex;
}

const usdcAbi = parseAbi(["function balanceOf(address account) view returns (uint256)", "function transfer(address to, uint256 amount) returns (bool)"]);

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rpcUrl = process.env["ARBITRUM_SEPOLIA_RPC_URL"];
  if (rpcUrl === undefined || rpcUrl === "") fail("ARBITRUM_SEPOLIA_RPC_URL is not set");
  const funder = privateKeyToAccount(funderKey());
  keyDirectory(options.dir);

  // Keys first: made once, kept, reused on every later run.
  const addresses = {} as Record<Role, Address>;
  for (const role of ROLES) {
    const path = join(options.dir, `${role}.key`);
    try {
      addresses[role] = existsSync(path) ? toAddress(privateKeyToAccount(readKeyFile(path)).address) : initKeyFile(path);
    } catch (error) {
      // KeyFileError says what is wrong with the file, never what it holds.
      fail(`${role}.key: ${error instanceof Error ? error.message : "unreadable"}`);
    }
  }
  if (Object.values(addresses).includes(toAddress(funder.address))) fail("the funder key is one of the role keys; use a separate funder");
  const record = { schema: "lemma.sepolia.roles.v1", chainId: arbitrumSepolia.id, usdc: ARBITRUM_SEPOLIA_USDC, roles: addresses };
  writeFileSync(join(options.dir, "roles.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

  const transport = http(rpcUrl, { timeout: 30_000 });
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport });
  const wallet = createWalletClient({ account: funder, chain: arbitrumSepolia, transport });
  const chainId = await publicClient.getChainId();
  if (chainId !== arbitrumSepolia.id) fail(`the RPC endpoint serves chain ${chainId}, not Arbitrum Sepolia (${arbitrumSepolia.id})`);
  const usdc = ARBITRUM_SEPOLIA_USDC as Hex;

  const ethTargets: Array<[Role, bigint]> = ROLES.filter((r) => r !== "buyer").map((r) => [r, r === "deployer" ? options.deployerWei : options.gasWei]);
  const usdcTargets: Array<[Role, bigint]> = [
    ["provider", options.providerUsdc],
    ["buyer", options.buyerUsdc],
  ];
  const ethShort = await Promise.all(ethTargets.map(async ([role, target]) => [role, target - (await publicClient.getBalance({ address: addresses[role] as Hex }))] as const));
  const usdcShort = await Promise.all(usdcTargets.map(async ([role, target]) => [role, target - ((await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [addresses[role] as Hex] })) as bigint)] as const));
  const ethNeeded = ethShort.reduce((sum, [, short]) => sum + (short > 0n ? short : 0n), 0n);
  const usdcNeeded = usdcShort.reduce((sum, [, short]) => sum + (short > 0n ? short : 0n), 0n);
  const funderEth = await publicClient.getBalance({ address: funder.address });
  const funderUsdc = (await publicClient.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [funder.address] })) as bigint;
  // Leave the funder enough for the transfers' own gas.
  if (funderEth < ethNeeded + parseEther("0.001")) fail(`the funder holds ${formatEther(funderEth)} ETH; the roles need ${formatEther(ethNeeded)} more, plus gas (testnet)`);
  if (funderUsdc < usdcNeeded) fail(`the funder holds ${formatUsdc(funderUsdc)} USDC; the roles need ${formatUsdc(usdcNeeded)} more (testnet)`);

  const mined = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== "success") fail(`transaction ${hash} reverted`);
    return hash;
  };
  for (const [role, short] of ethShort) {
    if (short <= 0n) continue;
    const tx = await mined(await wallet.sendTransaction({ to: addresses[role] as Hex, value: short, account: funder, chain: arbitrumSepolia }));
    console.log(`${role} ${addresses[role]}: +${formatEther(short)} ETH (testnet), tx ${tx}`);
  }
  for (const [role, short] of usdcShort) {
    if (short <= 0n) continue;
    const { request } = await publicClient.simulateContract({ address: usdc, abi: usdcAbi, functionName: "transfer", args: [addresses[role] as Hex, short], account: funder });
    const tx = await mined(await wallet.writeContract(request));
    console.log(`${role} ${addresses[role]}: +${formatUsdc(short)} USDC (testnet), tx ${tx}`);
  }
  for (const role of ROLES) console.log(`${role.padEnd(11)} ${addresses[role]}`);
  console.log(`keys: ${options.dir}/<role>.key (0600); public addresses: ${options.dir}/roles.json`);
}

try {
  await main();
} catch (error) {
  // Never an error's message: viem's messages repeat the RPC URL, which can carry a provider key.
  const code = (error as { code?: unknown }).code;
  fail(`failed (${error instanceof Error ? error.name : "error"}${typeof code === "string" && /^[A-Z][A-Z0-9_]{2,31}$/.test(code) ? ` ${code}` : ""})`);
}
