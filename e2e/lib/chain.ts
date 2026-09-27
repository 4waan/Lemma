import { ARBITRUM_SEPOLIA_USDC, type Address, toAddress } from "@lemma/core";
import {
  type Abi,
  type Hex,
  type PublicClient,
  type TestClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  hashDomain,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";

import { fixtureBytecode, linkLibrary } from "../fixtures/fixtures.js";

/** A local chain's clients: reads, anvil's test methods, and a wallet per key. */
export interface LocalChain {
  readonly url: string;
  readonly publicClient: PublicClient;
  readonly test: TestClient;
  /** Sends a contract call from `key` and waits for it; throws unless it succeeded. Returns the transaction hash. */
  send(key: Hex, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]): Promise<Hex>;
  /** Deploys creation code from `key` and waits; returns the address and the block it landed in. */
  deploy(key: Hex, bytecode: Hex): Promise<{ readonly address: Address; readonly block: bigint }>;
  /** Gives an account ETH for gas (anvil only). */
  fund(address: Address, eth?: string): Promise<void>;
  /** The chain's clock: the latest block's timestamp in seconds. */
  now(): Promise<bigint>;
}

export function localChain(url: string): LocalChain {
  const transport = http(url);
  const publicClient = createPublicClient({ chain: arbitrumSepolia, transport, pollingInterval: 100 });
  const test = createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport });
  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia, transport });
  const mined = async (hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 50 });
    if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
    return receipt;
  };
  return {
    url,
    publicClient,
    test,
    async send(key, address, abi, functionName, args = []) {
      const w = wallet(key);
      const { request } = await publicClient.simulateContract({ address: address as Hex, abi, functionName, args, account: w.account });
      const hash = await w.writeContract(request as Parameters<typeof w.writeContract>[0]);
      await mined(hash);
      return hash;
    },
    async deploy(key, bytecode) {
      const w = wallet(key);
      const hash = await w.sendTransaction({ data: bytecode, account: w.account, chain: arbitrumSepolia });
      const receipt = await mined(hash);
      if (receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error("no contract created");
      return { address: toAddress(receipt.contractAddress), block: receipt.blockNumber };
    },
    async fund(address, eth = "10") {
      await test.setBalance({ address: address as Hex, value: parseEther(eth) });
    },
    async now() {
      return (await publicClient.getBlock({ blockTag: "latest" })).timestamp;
    },
  };
}

/** A fresh key for a role the run plays itself, with its address. */
export function runtimeKey(): { readonly key: Hex; readonly address: Address } {
  const key = generatePrivateKey();
  return { key, address: toAddress(privateKeyToAccount(key).address) };
}

export const usdcAbi = parseAbi([
  "function initialize(string tokenName, string tokenSymbol, string tokenCurrency, uint8 tokenDecimals, address newMasterMinter, address newPauser, address newBlacklister, address newOwner)",
  "function initializeV2(string newName)",
  "function initializeV2_1(address lostAndFound)",
  "function initializeV2_2(address[] accountsToBlacklist, string newSymbol)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function balanceOf(address account) view returns (uint256)",
]);

/** Where the run puts Circle's `SignatureChecker` library, which FiatTokenV2_2 links. */
export const SIGNATURE_CHECKER = "0x00000000000000000000000000000000005160c1" as const;

export interface LocalUsdc {
  readonly address: Address;
  mint(to: Address, amount: bigint): Promise<void>;
  balanceOf(account: Address): Promise<bigint>;
}

/**
 * Circle's FiatTokenV2_2 at the Arbitrum Sepolia USDC address, set up as
 * Circle sets up a new token: the committed runtime code (its
 * `SignatureChecker` library at a fixed address, linked in), then
 * `initialize` through `initializeV2_2` and a minter, all from an admin key
 * made here. Its EIP-712 domain is then exactly the one x402 signs for on
 * Arbitrum Sepolia ("USD Coin", version "2", chain 421614, this address).
 */
export async function installUsdc(chain: LocalChain): Promise<LocalUsdc> {
  const usdc = toAddress(ARBITRUM_SEPOLIA_USDC);
  const admin = runtimeKey();
  await chain.fund(admin.address);
  await chain.test.setCode({ address: SIGNATURE_CHECKER, bytecode: fixtureBytecode("SignatureChecker.runtime") });
  await chain.test.setCode({ address: usdc as Hex, bytecode: linkLibrary(fixtureBytecode("FiatTokenV2_2.runtime"), SIGNATURE_CHECKER) });
  const call = (functionName: string, args: readonly unknown[]) => chain.send(admin.key, usdc, usdcAbi, functionName, args);
  await call("initialize", ["USD Coin", "USDC", "USD", 6, admin.address, admin.address, admin.address, admin.address]);
  await call("initializeV2", ["USD Coin"]);
  await call("initializeV2_1", [admin.address]);
  await call("initializeV2_2", [[], "USDC"]);
  await call("configureMinter", [admin.address, 10n ** 15n]);
  const read = <T>(functionName: string, args: readonly unknown[] = []) => chain.publicClient.readContract({ address: usdc as Hex, abi: usdcAbi, functionName, args } as never) as Promise<T>;
  const domain = hashDomain({
    domain: { name: "USD Coin", version: "2", chainId: 421_614n, verifyingContract: getAddress(usdc) },
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
  });
  if ((await read<string>("name")) !== "USD Coin" || (await read<string>("version")) !== "2" || (await read<Hex>("DOMAIN_SEPARATOR")) !== domain) {
    throw new Error("FiatTokenV2_2 is not set up as Arbitrum Sepolia USDC");
  }
  return {
    address: usdc,
    async mint(to, amount) {
      await call("mint", [to, amount]);
    },
    balanceOf: (account) => read<bigint>("balanceOf", [account]),
  };
}

const proxyAbi = parseAbi(["constructor(address implementation, bytes _data)", "function upgradeToAndCall(address newImplementation, bytes data) payable"]);
const initializeWithRegistry = parseAbi(["function initialize(address identityRegistry)"]);
const initializeIdentity = parseAbi(["function initialize()"]);
export const erc8004Abi = parseAbi([
  "function getIdentityRegistry() view returns (address)",
  "function owner() view returns (address)",
  "function getVersion() view returns (string)",
]);

/**
 * The official ERC-8004 identity and reputation registries, deployed the way
 * their repository deploys them: a proxy over a minimal UUPS implementation
 * (whose `initialize` sets the owner), then upgraded to the real
 * implementation with its own initializer. On Arbitrum Sepolia they exist
 * already; here a throwaway key made at run time deploys and owns them.
 */
export async function deployErc8004(chain: LocalChain): Promise<{ readonly identity: Address; readonly reputation: Address }> {
  const owner = runtimeKey();
  await chain.fund(owner.address);
  const minimal = (await chain.deploy(owner.key, fixtureBytecode("HardhatMinimalUUPS.initcode"))).address;
  const proxy = async (data: Hex) => (await chain.deploy(owner.key, encodeDeployData({ abi: proxyAbi, bytecode: fixtureBytecode("ERC1967Proxy.initcode"), args: [minimal as Hex, data] }))).address;
  const upgrade = async (at: Address, implementation: Address, data: Hex) => {
    await chain.send(owner.key, at, proxyAbi, "upgradeToAndCall", [implementation, data]);
  };
  const identity = await proxy(encodeFunctionData({ abi: initializeWithRegistry, functionName: "initialize", args: [zeroAddress] }));
  await upgrade(identity, (await chain.deploy(owner.key, fixtureBytecode("IdentityRegistryUpgradeable.initcode"))).address, encodeFunctionData({ abi: initializeIdentity, functionName: "initialize" }));
  const reputation = await proxy(encodeFunctionData({ abi: initializeWithRegistry, functionName: "initialize", args: [identity as Hex] }));
  await upgrade(reputation, (await chain.deploy(owner.key, fixtureBytecode("ReputationRegistryUpgradeable.initcode"))).address, encodeFunctionData({ abi: initializeWithRegistry, functionName: "initialize", args: [identity as Hex] }));
  const linked = await chain.publicClient.readContract({ address: reputation as Hex, abi: erc8004Abi, functionName: "getIdentityRegistry" });
  if (toAddress(linked) !== identity) throw new Error("the reputation registry does not point at the identity registry");
  return { identity, reputation };
}

/** The stand-in engine's reads (e2e/contracts/src/ConfidenceStandIn.sol). */
export const engineAbi = parseAbi([
  "function owner() view returns (address)",
  "function registry() view returns (address)",
  "function callCount() view returns (uint256)",
  "function callAt(uint256 i) view returns ((bytes32 releaseDigest, uint8 profileIndex, bool passed, uint16 weightBps, uint256 gasAtEntry, address caller))",
  "function stats(bytes32 releaseDigest, uint8 profileIndex) view returns (uint128, uint128, uint64, uint32, uint32)",
  "event PriorSet(bytes32 indexed releaseDigest, uint8 indexed profileIndex, uint32 passes, uint32 failures, bytes32 evidenceDigest)",
]);

/** The registry's reads the run checks besides the pipeline's own (contracts/abi/ResolutionWarrantyRegistry.json). */
export const registryReadAbi = parseAbi([
  "function owner() view returns (address)",
  "function engine() view returns (address)",
  "function totals() view returns (uint256 available, uint256 reserved, uint256 credits)",
]);
