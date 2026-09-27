import { type LoadedRelease, loadCatalog } from "@lemma/catalog";
import { priorFromEvidence } from "@lemma/confidence";
import { ARBITRUM_SEPOLIA_USDC, type Address, type Hex32, formatUsdc, toAddress } from "@lemma/core";
import { type Hex, type PublicClient, type WalletClient, parseAbi, zeroAddress } from "viem";

import { describeError } from "../errors.js";
import { registryRevertOf } from "./chain.js";
import { WARRANTY_CHAIN_ID } from "./pipeline.js";

/**
 * The registry calls and views the operator script uses beyond the pipeline's
 * own (`warrantyRegistryAbi`), with every custom error they can revert with,
 * each entry exactly as `contracts/abi/ResolutionWarrantyRegistry.json` has it
 * (a test checks).
 */
export const registryAdminAbi = [
  { type: "function", name: "owner", inputs: [], outputs: [{ name: "", type: "address", internalType: "address" }], stateMutability: "view" },
  { type: "function", name: "engine", inputs: [], outputs: [{ name: "", type: "address", internalType: "address" }], stateMutability: "view" },
  { type: "function", name: "usdc", inputs: [], outputs: [{ name: "", type: "address", internalType: "contract IERC20" }], stateMutability: "view" },
  { type: "function", name: "paused", inputs: [], outputs: [{ name: "", type: "bool", internalType: "bool" }], stateMutability: "view" },
  {
    type: "function",
    name: "totals",
    inputs: [],
    outputs: [
      { name: "available", type: "uint256", internalType: "uint256" },
      { name: "reserved", type: "uint256", internalType: "uint256" },
      { name: "credits", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "release",
    inputs: [{ name: "releaseDigest", type: "bytes32", internalType: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Release",
        components: [
          { name: "provider", type: "address", internalType: "address" },
          { name: "claimWindowSeconds", type: "uint32", internalType: "uint32" },
          { name: "active", type: "bool", internalType: "bool" },
          { name: "evaluator", type: "address", internalType: "address" },
          { name: "available", type: "uint256", internalType: "uint256" },
          { name: "reserved", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "registerRelease",
    inputs: [
      { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
      { name: "provider", type: "address", internalType: "address" },
      { name: "evaluator", type: "address", internalType: "address" },
      { name: "claimWindowSeconds", type: "uint32", internalType: "uint32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "setEngine", inputs: [{ name: "newEngine", type: "address", internalType: "address" }], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "depositBond",
    inputs: [
      { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
      { name: "amount", type: "uint256", internalType: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "error", name: "OwnableUnauthorizedAccount", inputs: [{ name: "account", type: "address", internalType: "address" }] },
  { type: "error", name: "InvalidReleaseDigest", inputs: [] },
  { type: "error", name: "InvalidRoles", inputs: [] },
  { type: "error", name: "InvalidClaimWindow", inputs: [] },
  { type: "error", name: "ReleaseAlreadyRegistered", inputs: [{ name: "releaseDigest", type: "bytes32", internalType: "bytes32" }] },
  { type: "error", name: "EngineHasNoCode", inputs: [{ name: "engine", type: "address", internalType: "address" }] },
  { type: "error", name: "ZeroAmount", inputs: [] },
  { type: "error", name: "UnknownRelease", inputs: [{ name: "releaseDigest", type: "bytes32", internalType: "bytes32" }] },
  { type: "error", name: "ReleaseNotActive", inputs: [{ name: "releaseDigest", type: "bytes32", internalType: "bytes32" }] },
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address", internalType: "address" }] },
  {
    type: "error",
    name: "TransferAmountMismatch",
    inputs: [
      { name: "expected", type: "uint256", internalType: "uint256" },
      { name: "received", type: "uint256", internalType: "uint256" },
    ],
  },
] as const;

/**
 * The Stylus compatibility engine's calls the script makes (the committed
 * `contracts/stylus/confidence-contract/ICompatibilityConfidence.sol`) and its
 * errors.
 */
export const engineAdminAbi = parseAbi([
  "function owner() view returns (address)",
  "function registry() view returns (address)",
  "function setPrior(bytes32 release_digest, uint8 profile_index, uint32 passes, uint32 failures, bytes32 evidence_digest)",
  "function stats(bytes32 release_digest, uint8 profile_index) view returns (uint128, uint128, uint64, uint32, uint32)",
  "error NotOwner(address)",
  "error NotRegistry(address)",
]);

const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export const ADMIN_USAGE = [
  "usage: warranty-admin <command> [--catalog <dir>] [--provisional]",
  "  status                                   the registry, its engine, and each catalog release's registration and bond",
  "  register-release <releaseId@version>     registerRelease with PROVIDER_ADDRESS, EVALUATOR_ADDRESS and the release's warranty window",
  "  deposit-bond <releaseId@version> <atomic USDC>   approve and depositBond, as the release's provider",
  "  set-engine <engine address>              setEngine; the engine must already name this registry",
  "  set-priors [<releaseId@version> ...]     the engine's setPrior for every profile with frozen benchmark evidence",
  "Keys come from the environment only: REGISTRY_OWNER_PRIVATE_KEY (register-release, set-engine), PROVIDER_PRIVATE_KEY",
  "(deposit-bond), ENGINE_OWNER_PRIVATE_KEY (set-priors); with ARBITRUM_SEPOLIA_RPC_URL and RESOLUTION_WARRANTY_REGISTRY_ADDRESS.",
].join("\n");

/** One parsed command line. `catalog` is the catalog root (default: the packaged catalog). */
export type AdminCommand =
  | { readonly command: "status"; readonly catalog: string | undefined; readonly provisional: boolean }
  | { readonly command: "register-release"; readonly release: string; readonly catalog: string | undefined; readonly provisional: boolean }
  | { readonly command: "deposit-bond"; readonly release: string; readonly amount: bigint; readonly catalog: string | undefined; readonly provisional: boolean }
  | { readonly command: "set-engine"; readonly engine: Address }
  | { readonly command: "set-priors"; readonly releases: readonly string[]; readonly catalog: string | undefined };

const RELEASE_REF = /^[a-z0-9]+(?:-[a-z0-9]+)*@[0-9A-Za-z.+-]{1,128}$/;
/** 32 bytes of hex, with or without `0x` (many wallets export keys bare), anywhere in an argument. */
const KEY_SHAPED = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:$|[^0-9a-fA-F])/;
const ATOMIC = /^[1-9][0-9]{0,77}$/;

/**
 * The script's arguments. A key is never an argument (it would reach shell
 * history and the process list): anything shaped like 32 bytes of hex, with
 * or without `0x`, is refused without being repeated, and so is an unknown
 * option. Releases are named `releaseId@version`, as the catalog names them,
 * never by digest, so no argument needs that shape.
 */
export function parseAdminArgs(argv: readonly string[]): AdminCommand | { readonly error: string } {
  if (argv.some((a) => KEY_SHAPED.test(a))) return { error: "a private key is never an argument: set it in the environment (releases are named releaseId@version)" };
  const [command, ...rest] = argv;
  let catalog: string | undefined;
  let provisional = false;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--catalog") {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) return { error: "--catalog takes a directory" };
      catalog = value;
    } else if (a === "--provisional") provisional = true;
    else if (a.startsWith("--")) return { error: `unknown option (not shown: it could hold a secret)\n${ADMIN_USAGE}` };
    else positional.push(a);
  }
  const releaseRef = (value: string | undefined) => (value !== undefined && RELEASE_REF.test(value) ? value : undefined);
  switch (command) {
    case "status":
      if (positional.length > 0) return { error: ADMIN_USAGE };
      return { command, catalog, provisional };
    case "register-release": {
      const release = releaseRef(positional[0]);
      if (release === undefined || positional.length !== 1) return { error: "register-release takes one release as releaseId@version" };
      return { command, release, catalog, provisional };
    }
    case "deposit-bond": {
      const release = releaseRef(positional[0]);
      const amount = positional[1];
      if (release === undefined || amount === undefined || positional.length !== 2) return { error: "deposit-bond takes a release (releaseId@version) and an amount in atomic USDC (1000000 is 1 USDC)" };
      if (!ATOMIC.test(amount)) return { error: "the amount is a whole number of atomic USDC above zero (1000000 is 1 USDC)" };
      return { command, release, amount: BigInt(amount), catalog, provisional };
    }
    case "set-engine": {
      if (catalog !== undefined || provisional || positional.length !== 1) return { error: "set-engine takes one engine address" };
      try {
        const engine = toAddress(positional[0] as string);
        if (engine === zeroAddress) return { error: "set-engine takes the engine's address; this script never turns the hook off" };
        return { command, engine };
      } catch {
        return { error: "set-engine takes an address with a valid checksum" };
      }
    }
    case "set-priors": {
      if (provisional) return { error: "set-priors uses frozen benchmark evidence only: a provisional prior exists only in the catalog (packages/confidence/README.md)" };
      const refs = positional.map(releaseRef);
      if (refs.some((r) => r === undefined)) return { error: "set-priors takes releases as releaseId@version" };
      return { command, releases: refs as string[], catalog };
    }
    default:
      return { error: ADMIN_USAGE };
  }
}

/** A refusal the script prints as is: its message names variables, addresses and codes, never a key or an RPC URL. */
export class AdminError extends Error {
  override name = "AdminError";
}

/** The chain access the commands share: one public client, the registry, and a line printer. */
export interface AdminContext {
  readonly publicClient: PublicClient;
  readonly registry: Address;
  readonly print: (line: string) => void;
}

/** A signer's wallet client, whose account is the key's (from the environment). */
export type AdminWallet = WalletClient & { readonly account: NonNullable<WalletClient["account"]> };

/** A catalog release as the script names it. */
export interface NamedRelease {
  readonly ref: string;
  readonly loaded: LoadedRelease;
}

/** The catalog's releases by `releaseId@version`: the packaged catalog, or `root`; the provisional overlay only when asked. */
export function catalogReleases(root: string | undefined, provisional: boolean): Map<string, LoadedRelease> {
  let catalog: ReturnType<typeof loadCatalog>;
  try {
    catalog = loadCatalog({ ...(root === undefined ? {} : { root }), includeProvisional: provisional });
  } catch (error) {
    // CatalogError lists every problem by file and field; it holds nothing secret.
    throw new AdminError(error instanceof Error ? error.message : "the catalog does not load");
  }
  return new Map(catalog.releases.map((r) => [`${r.release.releaseId}@${r.release.version}`, r]));
}

/** `ref` in `releases`, or an AdminError naming it. */
export function releaseNamed(releases: ReadonlyMap<string, LoadedRelease>, ref: string): NamedRelease {
  const loaded = releases.get(ref);
  if (loaded === undefined) throw new AdminError(`${ref} is not in the catalog (a provisional release needs --provisional)`);
  return { ref, loaded };
}

/**
 * Checks that the RPC endpoint serves Arbitrum Sepolia and that the address
 * holds a registry whose bond token is Arbitrum Sepolia USDC, before any
 * command reads or sends anything else.
 */
export async function checkChain(ctx: AdminContext): Promise<void> {
  const chainId = await ctx.publicClient.getChainId();
  if (chainId !== WARRANTY_CHAIN_ID) throw new AdminError(`the RPC endpoint serves chain ${chainId}, not Arbitrum Sepolia (${WARRANTY_CHAIN_ID})`);
  const code = await ctx.publicClient.getCode({ address: ctx.registry as Hex });
  if (code === undefined || code === "0x") throw new AdminError(`no contract at RESOLUTION_WARRANTY_REGISTRY_ADDRESS (${ctx.registry})`);
  const usdc = toAddress(await read<string>(ctx, "usdc"));
  if (usdc !== ARBITRUM_SEPOLIA_USDC) throw new AdminError(`the registry at ${ctx.registry} holds bonds in ${usdc}, not Arbitrum Sepolia USDC (${ARBITRUM_SEPOLIA_USDC})`);
}

type RegistryRelease = { provider: string; evaluator: string; claimWindowSeconds: number; active: boolean; available: bigint; reserved: bigint };

async function read<T>(ctx: AdminContext, functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await ctx.publicClient.readContract({ address: ctx.registry as Hex, abi: registryAdminAbi, functionName, args } as never)) as T;
}

async function registryRelease(ctx: AdminContext, digest: Hex32): Promise<RegistryRelease> {
  return read<RegistryRelease>(ctx, "release", [digest]);
}

/** Simulates a call from the wallet's account, sends it, and waits for it; returns the mined transaction's hash. */
async function transact(ctx: AdminContext, wallet: AdminWallet, call: { readonly address: Address; readonly abi: readonly unknown[]; readonly functionName: string; readonly args: readonly unknown[] }): Promise<Hex> {
  let hash: Hex;
  try {
    const { request } = await ctx.publicClient.simulateContract({ address: call.address as Hex, abi: call.abi, functionName: call.functionName, args: call.args, account: wallet.account } as never);
    hash = await wallet.writeContract(request as never);
  } catch (error) {
    const revert = registryRevertOf(error);
    // Only the custom error's code, or the error's name and code: viem's messages can repeat the RPC URL.
    throw new AdminError(`${call.functionName} was refused (${revert?.code ?? describeError(error)})`);
  }
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success") throw new AdminError(`${call.functionName} reverted in ${hash}`);
  return hash;
}

async function requireOwner(ctx: AdminContext, wallet: AdminWallet, variable: string): Promise<void> {
  const owner = toAddress(await read<string>(ctx, "owner"));
  if (toAddress(wallet.account.address) !== owner) throw new AdminError(`${variable} is not the registry's owner (${owner})`);
}

/**
 * `register-release`: registers a catalog release with its provider and
 * evaluator and the release's own warranty window (`claimWindowHours`), as
 * the registry's owner. The provider must be the release's x402 recipient
 * (the server quotes for no other). A release registered already with the
 * same roles and window is left as it is; with others it is an error, since
 * a digest registers once.
 */
export async function registerRelease(ctx: AdminContext, owner: AdminWallet, release: NamedRelease, roles: { readonly provider: Address; readonly evaluator: Address }): Promise<void> {
  const { releaseDigest: digest, release: manifest } = release.loaded;
  if (roles.provider === roles.evaluator) throw new AdminError("PROVIDER_ADDRESS and EVALUATOR_ADDRESS are the same account: the registry refuses a provider that is its own evaluator");
  if (toAddress(manifest.provider.payTo) !== roles.provider) throw new AdminError(`${release.ref} pays ${manifest.provider.payTo}, not PROVIDER_ADDRESS (${roles.provider})`);
  const window = manifest.warranty.claimWindowHours * 3600;
  const current = await registryRelease(ctx, digest);
  if (toAddress(current.provider) !== zeroAddress) {
    const same = toAddress(current.provider) === roles.provider && toAddress(current.evaluator) === roles.evaluator && current.claimWindowSeconds === window;
    if (!same) throw new AdminError(`${release.ref} (${digest}) is registered already with provider ${toAddress(current.provider)}, evaluator ${toAddress(current.evaluator)} and a ${current.claimWindowSeconds} s window; a digest registers once`);
    ctx.print(`${release.ref} ${digest}: registered already (provider ${roles.provider}, evaluator ${roles.evaluator}, claim window ${window} s${current.active ? "" : ", deactivated"})`);
    return;
  }
  await requireOwner(ctx, owner, "REGISTRY_OWNER_PRIVATE_KEY");
  const tx = await transact(ctx, owner, { address: ctx.registry, abi: registryAdminAbi, functionName: "registerRelease", args: [digest, roles.provider, roles.evaluator, window] });
  ctx.print(`${release.ref} ${digest}: registered (provider ${roles.provider}, evaluator ${roles.evaluator}, claim window ${window} s), tx ${tx}`);
}

/**
 * `deposit-bond`: adds `amount` atomic USDC to a registered, active release's
 * bond, as its provider: approves the registry for exactly that amount when
 * the allowance is short, then `depositBond`.
 */
export async function depositBond(ctx: AdminContext, provider: AdminWallet, release: NamedRelease, amount: bigint): Promise<void> {
  const digest = release.loaded.releaseDigest;
  const current = await registryRelease(ctx, digest);
  if (toAddress(current.provider) === zeroAddress) throw new AdminError(`${release.ref} is not registered: run register-release first`);
  if (!current.active) throw new AdminError(`${release.ref} is deactivated on the registry`);
  const from = toAddress(provider.account.address);
  if (from !== toAddress(current.provider)) throw new AdminError(`PROVIDER_PRIVATE_KEY is not ${release.ref}'s provider on the registry (${toAddress(current.provider)})`);
  const usdc = toAddress(await read<string>(ctx, "usdc"));
  const token = { address: usdc as Hex, abi: erc20Abi } as const;
  const balance = (await ctx.publicClient.readContract({ ...token, functionName: "balanceOf", args: [from as Hex] })) as bigint;
  if (balance < amount) throw new AdminError(`the provider holds ${formatUsdc(balance)} USDC, less than the ${formatUsdc(amount)} USDC to deposit (testnet)`);
  const allowance = (await ctx.publicClient.readContract({ ...token, functionName: "allowance", args: [from as Hex, ctx.registry as Hex] })) as bigint;
  if (allowance < amount) {
    const approval = await transact(ctx, provider, { address: usdc, abi: erc20Abi, functionName: "approve", args: [ctx.registry, amount] });
    ctx.print(`approved the registry for ${formatUsdc(amount)} USDC (testnet), tx ${approval}`);
  }
  const tx = await transact(ctx, provider, { address: ctx.registry, abi: registryAdminAbi, functionName: "depositBond", args: [digest, amount] });
  const after = await registryRelease(ctx, digest);
  ctx.print(`${release.ref} ${digest}: deposited ${formatUsdc(amount)} USDC (testnet); available ${formatUsdc(after.available)}, reserved ${formatUsdc(after.reserved)}; tx ${tx}`);
}

/**
 * `set-engine`: points the registry's hook at the compatibility engine, as
 * the registry's owner. The engine must already name this registry as the
 * one allowed to record (`registry()`), or every record would fail
 * (`EngineRecordFailed`) and the chain's confidence would never move.
 */
export async function setEngine(ctx: AdminContext, owner: AdminWallet, engine: Address): Promise<void> {
  const code = await ctx.publicClient.getCode({ address: engine as Hex });
  if (code === undefined || code === "0x") throw new AdminError(`no contract at ${engine}`);
  let recorder: Address;
  try {
    recorder = toAddress(await ctx.publicClient.readContract({ address: engine as Hex, abi: engineAdminAbi, functionName: "registry" }));
  } catch (error) {
    throw new AdminError(`${engine} does not answer registry() (${describeError(error)}): not a Lemma compatibility engine`);
  }
  if (recorder !== ctx.registry) throw new AdminError(`the engine at ${engine} lets ${recorder} record, not this registry: call its setRegistry(${ctx.registry}) first`);
  const current = toAddress(await read<string>(ctx, "engine"));
  if (current === engine) {
    ctx.print(`engine ${engine}: set already`);
    return;
  }
  await requireOwner(ctx, owner, "REGISTRY_OWNER_PRIVATE_KEY");
  const tx = await transact(ctx, owner, { address: ctx.registry, abi: registryAdminAbi, functionName: "setEngine", args: [engine] });
  ctx.print(`engine ${engine}: set${current === zeroAddress ? "" : ` (was ${current})`}, tx ${tx}`);
}

/** One profile's prior as the server computes it, and the evidence it cites. */
export interface ProfilePrior {
  readonly ref: string;
  readonly releaseDigest: Hex32;
  readonly profileIndex: number;
  readonly passes: number;
  readonly failures: number;
  /** The frozen evidence's run set digest: the benchmark run records the prior was measured from. */
  readonly evidenceDigest: Hex32;
}

/**
 * The priors `set-priors` sets: for each public release (never the
 * provisional overlay) and each profile with benchmark evidence, core's
 * treatment arm (`@lemma/confidence` `priorFromEvidence`, the prior the
 * server's catalog uses), citing the evidence's `runSetDigest`.
 */
export function priorsFor(releases: ReadonlyMap<string, LoadedRelease>, only: readonly string[] = []): ProfilePrior[] {
  const chosen = only.length === 0 ? [...releases.keys()] : only;
  const priors: ProfilePrior[] = [];
  for (const ref of chosen) {
    const loaded = releaseNamed(releases, ref).loaded;
    if (loaded.source !== "public") throw new AdminError(`${ref} is provisional: priors come from frozen evidence only`);
    loaded.release.supportedProfiles.forEach((profile, profileIndex) => {
      if (profile.evidence === null) return;
      const prior = priorFromEvidence(profile.evidence);
      priors.push({ ref, releaseDigest: loaded.releaseDigest, profileIndex, passes: prior.passes, failures: prior.failures, evidenceDigest: profile.evidence.runSetDigest });
    });
  }
  return priors;
}

/**
 * `set-priors`: the engine's `setPrior` for each prior, as the engine's
 * owner, on the engine the registry records into now. A prior the engine
 * holds already is left as it is.
 */
export async function setPriors(ctx: AdminContext, owner: AdminWallet, priors: readonly ProfilePrior[]): Promise<void> {
  const engine = toAddress(await read<string>(ctx, "engine"));
  if (engine === zeroAddress) throw new AdminError("the registry has no engine: run set-engine first");
  const contract = { address: engine as Hex, abi: engineAdminAbi } as const;
  const engineOwner = toAddress(await ctx.publicClient.readContract({ ...contract, functionName: "owner" }));
  if (toAddress(owner.account.address) !== engineOwner) throw new AdminError(`ENGINE_OWNER_PRIVATE_KEY is not the engine's owner (${engineOwner})`);
  if (priors.length === 0) ctx.print("no profile has benchmark evidence: no prior to set");
  for (const p of priors) {
    const stats = await ctx.publicClient.readContract({ ...contract, functionName: "stats", args: [p.releaseDigest as Hex, p.profileIndex] });
    const where = `${p.ref} profile ${p.profileIndex}`;
    if (stats[3] === p.passes && stats[4] === p.failures) {
      ctx.print(`${where}: prior ${p.passes} passed, ${p.failures} failed, set already`);
      continue;
    }
    const tx = await transact(ctx, owner, { address: engine, abi: engineAdminAbi, functionName: "setPrior", args: [p.releaseDigest, p.profileIndex, p.passes, p.failures, p.evidenceDigest] });
    ctx.print(`${where}: prior ${p.passes} passed, ${p.failures} failed (evidence ${p.evidenceDigest}), tx ${tx}`);
  }
}

/** `status`: what the registry holds, read only (no key). */
export async function printStatus(ctx: AdminContext, releases: ReadonlyMap<string, LoadedRelease>): Promise<void> {
  const [owner, engine, usdc, paused, totals] = await Promise.all([
    read<string>(ctx, "owner"),
    read<string>(ctx, "engine"),
    read<string>(ctx, "usdc"),
    read<boolean>(ctx, "paused"),
    read<readonly [bigint, bigint, bigint]>(ctx, "totals"),
  ]);
  ctx.print(`registry ${ctx.registry} on chain ${WARRANTY_CHAIN_ID}: owner ${toAddress(owner)}, usdc ${toAddress(usdc)}${paused ? ", paused" : ""}`);
  ctx.print(`bonds (testnet USDC): available ${formatUsdc(totals[0])}, reserved ${formatUsdc(totals[1])}, buyer credits ${formatUsdc(totals[2])}`);
  if (toAddress(engine) === zeroAddress) ctx.print("engine: none");
  else {
    const contract = { address: engine as Hex, abi: engineAdminAbi } as const;
    const [engineOwner, recorder] = await Promise.all([ctx.publicClient.readContract({ ...contract, functionName: "owner" }), ctx.publicClient.readContract({ ...contract, functionName: "registry" })]);
    ctx.print(`engine ${toAddress(engine)}: owner ${toAddress(engineOwner)}, records from ${toAddress(recorder)}${toAddress(recorder) === ctx.registry ? "" : " (not this registry)"}`);
  }
  for (const [ref, loaded] of releases) {
    const r = await registryRelease(ctx, loaded.releaseDigest);
    if (toAddress(r.provider) === zeroAddress) ctx.print(`${ref} ${loaded.releaseDigest}: not registered`);
    else {
      ctx.print(
        `${ref} ${loaded.releaseDigest}: ${r.active ? "active" : "deactivated"}, provider ${toAddress(r.provider)}, evaluator ${toAddress(r.evaluator)}, claim window ${r.claimWindowSeconds} s, bond available ${formatUsdc(r.available)}, reserved ${formatUsdc(r.reserved)} (testnet USDC)`,
      );
    }
  }
}
