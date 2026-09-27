import { type Hex, createPublicClient, createWalletClient, custom, decodeFunctionData, encodeFunctionResult, numberToHex } from "viem";
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
