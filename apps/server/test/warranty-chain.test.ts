import { type Hex, createPublicClient, createWalletClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, numberToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { describe, expect, it } from "vitest";

import { viemWarrantyChain, warrantyRegistryAbi } from "../src/index.js";

const REGISTRY = "0x4c454d4d41000000000000000000000000000001";
const ID = `0x${"11".repeat(32)}` as const;
const DEADLINE = 1_790_259_200n;
/** The block the warranty was activated in. */
const ACTIVATED_AT = 16;

/**
 * A load-balanced endpoint over two nodes, one at the activation's block and
 * one two blocks behind it, where the warranty does not exist yet. A read at
 * `latest` goes to each node in turn; a read at a block number is answered as
 * of that block. Records the block every `eth_call` asked for.
 */
function twoNodes() {
  const asked: string[] = [];
  let turn = 0;
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(arbitrumSepolia.id);
      case "eth_blockNumber":
        return numberToHex(ACTIVATED_AT);
      case "eth_call": {
        const [call, block] = params as [{ readonly data: Hex }, string];
        asked.push(block);
        const height = block === "latest" ? [ACTIVATED_AT, ACTIVATED_AT - 2][turn++ % 2]! : Number(BigInt(block));
        const active = height >= ACTIVATED_AT;
        const { functionName } = decodeFunctionData({ abi: warrantyRegistryAbi, data: call.data });
        if (functionName === "claimDeadlineOf") return encodeFunctionResult({ abi: warrantyRegistryAbi, functionName, result: active ? DEADLINE : 0n });
        if (functionName === "resolution") {
          const resolution = { releaseDigest: `0x${"44".repeat(32)}`, claimHash: `0x${"c1".repeat(32)}`, amount: 250_000n, claimDeadline: DEADLINE, profileIndex: 0, status: 1, pausedSecondsAtActivation: 0n } as const;
          const none = { ...resolution, releaseDigest: `0x${"00".repeat(32)}`, claimHash: `0x${"00".repeat(32)}`, amount: 0n, claimDeadline: 0n, status: 0 } as const;
          return encodeFunctionResult({ abi: warrantyRegistryAbi, functionName, result: active ? resolution : none });
        }
        throw new Error(`unscripted call ${functionName}`);
      }
      default:
        throw new Error(`unscripted method ${method}`);
    }
  };
  const transport = custom({ request }, { retryCount: 0 });
  const wallet = () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: arbitrumSepolia, transport });
  const chain = viemWarrantyChain({
    publicClient: createPublicClient({ chain: arbitrumSepolia, transport }),
    providerWallet: wallet(),
    evaluatorWallet: wallet(),
    registry: REGISTRY,
    chainId: arbitrumSepolia.id,
  });
  return { chain, asked };
}

describe("the viem warranty chain client", () => {
  it("reads a resolution's status and claim deadline at one block, so two nodes never pair an active warranty with no deadline", async () => {
    const { chain, asked } = twoNodes();
    expect(await chain.resolution(ID)).toMatchObject({ status: "active", claimDeadline: DEADLINE, amount: 250_000n });
    expect(asked).toEqual([numberToHex(ACTIVATED_AT), numberToHex(ACTIVATED_AT)]);
  });
});

/** The real header time of every block the logs below sit in, in seconds. */
const HEADER_TIMES: Readonly<Record<number, number>> = { 100: 1_790_880_000, 101: 1_790_880_001, 102: 1_790_880_005 };

/**
 * An endpoint whose `eth_getLogs` answers a `blockTimestamp` in each log the
 * way nodes in the wild do: absent, `0x0` (Arbitrum's public endpoint), or a
 * wrong non-zero value, while `eth_getBlockByNumber` answers each block's real
 * header. Counts the header reads per block.
 */
function logsNode(stamps: ReadonlyArray<{ readonly block: number; readonly blockTimestamp?: Hex }>) {
  const headerReads = new Map<number, number>();
  const paused = (block: number, logIndex: number, blockTimestamp: Hex | undefined) => ({
    address: REGISTRY,
    topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "Paused" }),
    data: encodeAbiParameters([{ type: "address" }], ["0x00000000000000000000000000000000000000aa"]),
    blockNumber: numberToHex(block),
    logIndex: numberToHex(logIndex),
    transactionHash: `0x${block.toString(16).padStart(2, "0").repeat(32)}`,
    blockHash: `0x${"bb".repeat(32)}`,
    transactionIndex: "0x0",
    removed: false,
    ...(blockTimestamp === undefined ? {} : { blockTimestamp }),
  });
  const request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    switch (method) {
      case "eth_chainId":
        return numberToHex(arbitrumSepolia.id);
      case "eth_getLogs":
        return stamps.map((s, i) => paused(s.block, i, s.blockTimestamp));
      case "eth_getBlockByNumber": {
        const [tag] = params as [Hex, boolean];
        const block = Number(BigInt(tag));
        headerReads.set(block, (headerReads.get(block) ?? 0) + 1);
        const time = HEADER_TIMES[block];
        if (time === undefined) throw new Error(`no block ${block}`);
        return { number: tag, hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}`, timestamp: numberToHex(time), baseFeePerGas: "0x5f5e100", gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [] };
      }
      default:
        throw new Error(`unscripted method ${method}`);
    }
  };
  const transport = custom({ request }, { retryCount: 0 });
  const wallet = () => createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: arbitrumSepolia, transport });
  const chain = viemWarrantyChain({
    publicClient: createPublicClient({ chain: arbitrumSepolia, transport }),
    providerWallet: wallet(),
    evaluatorWallet: wallet(),
    registry: REGISTRY,
    chainId: arbitrumSepolia.id,
  });
  return { chain, headerReads };
}

describe("registry logs' block times", () => {
  const at = (block: number) => new Date(HEADER_TIMES[block]! * 1000);

  it("come from the block header when a node answers a log's blockTimestamp as 0x0, as Arbitrum's public endpoint does", async () => {
    const { chain } = logsNode([{ block: 100, blockTimestamp: "0x0" }]);
    const [log] = await chain.registryLogs(100n, 100n);
    expect(log).toMatchObject({ name: "Paused", blockNumber: 100n, blockTime: at(100) });
  });

  it("come from the header whether a log's own timestamp is missing, zero, or wrong", async () => {
    const { chain } = logsNode([{ block: 100 }, { block: 101, blockTimestamp: "0x0" }, { block: 102, blockTimestamp: numberToHex(HEADER_TIMES[102]! + 3600) }]);
    const logs = await chain.registryLogs(100n, 102n);
    expect(logs.map((l) => [l.blockNumber, l.blockTime])).toEqual([
      [100n, at(100)],
      [101n, at(101)],
      [102n, at(102)],
    ]);
  });

  it("read each block's header once, however many logs it holds", async () => {
    const { chain, headerReads } = logsNode([{ block: 101 }, { block: 101, blockTimestamp: "0x0" }, { block: 101 }, { block: 102 }]);
    expect(await chain.registryLogs(101n, 102n)).toHaveLength(4);
    expect(Object.fromEntries(headerReads)).toEqual({ 101: 1, 102: 1 });
  });
});

