import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolve } from "@lemma/catalog";
import { type Address, AdoptionFeedbackFile, type Hex32, deriveResolutionId, toAddress } from "@lemma/core";
import { type Abi, type Hex, type PublicClient, createPublicClient, createTestClient, createWalletClient, encodeFunctionData, http, keccak256, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ATTEMPT_LEASE_MS,
  Attester,
  MemoryOutcomeFeed,
  MemoryStore,
  ResolutionService,
  SecretKey,
  SendDeadlineError,
  isRevert,
  refusalOf,
  registerAgent,
  reputationRegistryAbi,
  setAgentUri,
  silentLogger,
  toReputation,
  viemReputationChain,
} from "../src/index.js";
import { outcomeFor } from "./fake-reputation-chain.js";
import { NOW, app, gatingTask, matchingProfile, nextPreviewId, sellableIndex } from "./helpers.js";

/**
 * The reputation chain client, the attester and the register logic against
 * the official ERC-8004 registries on a local anvil node (chain id 421614).
 * Runs when LEMMA_ERC8004_ARTIFACTS names a `forge build` output directory of
 * erc-8004/erc-8004-contracts at b9e466c (contracts/IdentityRegistryUpgradeable.sol,
 * ReputationRegistryUpgradeable.sol, HardhatMinimalUUPS.sol and ERC1967Proxy.sol,
 * with its OpenZeppelin 5.4 dependencies, the optimizer at 200 runs and via-IR,
 * as upstream builds them) and anvil is on PATH (or LEMMA_ANVIL); skipped otherwise.
 */
const artifacts = process.env["LEMMA_ERC8004_ARTIFACTS"];
const anvilBin = process.env["LEMMA_ANVIL"] ?? "anvil";
const exec = promisify(execFile);

const artifact = (name: string) => {
  const json = JSON.parse(readFileSync(join(artifacts as string, `${name}.sol`, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address !== null ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

describe.skipIf(artifacts === undefined || artifacts === "")("ERC-8004 registries on anvil", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let identity: Address;
  let reputation: Address;
  // Every key is made here, at runtime; anvil's well-known accounts are not used.
  const ownerKey = generatePrivateKey();
  const attesterKey = generatePrivateKey();
  const buyerKey = generatePrivateKey();
  const deployerKey = generatePrivateKey();
  const owner = privateKeyToAccount(ownerKey);
  const buyer = privateKeyToAccount(buyerKey);
  let publicClient: PublicClient;

  const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: arbitrumSepolia, transport: http(rpcUrl) });
  const clientsFor = (key: Hex) => ({ publicClient, walletClient: wallet(key), account: privateKeyToAccount(key) });

  beforeAll(async () => {
    const port = await freePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn(anvilBin, ["--chain-id", "421614", "--port", String(port), "--silent"], { stdio: "ignore" });
    publicClient = createPublicClient({ chain: arbitrumSepolia, transport: http(rpcUrl), pollingInterval: 50 });
    for (let i = 0; ; i++) {
      try {
        await publicClient.getChainId();
        break;
      } catch (error) {
        if (i > 100) throw error;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const test = createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport: http(rpcUrl) });
    for (const key of [ownerKey, attesterKey, buyerKey, deployerKey]) await test.setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });

    // The upstream deployment pattern: a proxy on a minimal UUPS implementation, then upgraded to the registry.
    const deployer = wallet(deployerKey);
    const deploy = async (name: string, args: readonly unknown[] = []) => {
      const { abi, bytecode } = artifact(name);
      const hash = await deployer.deployContract({ abi, bytecode, args, account: deployer.account, chain: arbitrumSepolia });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return toAddress(receipt.contractAddress as string);
    };
    const minimal = artifact("HardhatMinimalUUPS");
    const minimalImpl = await deploy("HardhatMinimalUUPS");
    const upgrade = async (proxy: Address, name: string, data: Hex) => {
      const hash = await deployer.writeContract({
        address: proxy as Hex,
        abi: [{ type: "function", name: "upgradeToAndCall", stateMutability: "payable", inputs: [{ name: "newImplementation", type: "address" }, { name: "data", type: "bytes" }], outputs: [] }],
        functionName: "upgradeToAndCall",
        args: [(await deploy(name)) as Hex, data],
        account: deployer.account,
        chain: arbitrumSepolia,
      });
      expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
    };
    const init = (arg: Address) => encodeFunctionData({ abi: minimal.abi, functionName: "initialize", args: [arg] });
    identity = await deploy("ERC1967Proxy", [minimalImpl, init("0x0000000000000000000000000000000000000000")]);
    await upgrade(identity, "IdentityRegistryUpgradeable", encodeFunctionData({ abi: artifact("IdentityRegistryUpgradeable").abi, functionName: "initialize", args: [] }));
    reputation = await deploy("ERC1967Proxy", [minimalImpl, init(identity)]);
    await upgrade(reputation, "ReputationRegistryUpgradeable", encodeFunctionData({ abi: artifact("ReputationRegistryUpgradeable").abi, functionName: "initialize", args: [identity] }));
  }, 120_000);

  afterAll(() => {
    anvil?.kill();
  });

  const chainFor = (key: Hex) =>
    viemReputationChain({ rpcUrl, key: new SecretKey(key), identityRegistry: identity, reputationRegistry: reputation, receiptTimeoutMs: 10_000, logRange: 5n });

  it("registers an agent, points it at a new file, and reads who controls it", async () => {
    const first = await registerAgent(clientsFor(ownerKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    const { agentId } = await registerAgent(clientsFor(ownerKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    expect(agentId).toBe(first.agentId + 1n);
    await setAgentUri(clientsFor(ownerKey), identity, agentId, "https://lemma.example/v2/registration.json");
    const uri = await publicClient.readContract({ address: identity as Hex, abi: [{ type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ name: "id", type: "uint256" }], outputs: [{ type: "string" }] }], functionName: "tokenURI", args: [agentId] });
    expect(uri).toBe("https://lemma.example/v2/registration.json");
    const chain = chainFor(attesterKey);
    expect(await chain.controlsAgent(agentId, toAddress(owner.address))).toBe(true);
    expect(await chain.controlsAgent(agentId, chain.attester)).toBe(false);
    expect(await chain.controlsAgent(999n, toAddress(owner.address))).toBe(false);
    // Only the owner may repoint it.
    await expect(setAgentUri(clientsFor(buyerKey), identity, agentId, "https://evil.example/")).rejects.toSatisfy(isRevert);
  });

  it("posts, finds and summarizes feedback through the attester, and never posts twice after a crash", async () => {
    const { agentId } = await registerAgent(clientsFor(ownerKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    const { agentId: buyerAgent } = await registerAgent(clientsFor(buyerKey), identity, "https://buyer.example/agent.json");
    const chain = chainFor(attesterKey);
    expect(await chain.summary({ agentId, tag1: "lemma.adoption", tag2: "mcp-server.add-payment-gating" })).toEqual({ count: 0n, value: 0n, decimals: 0 });

    const store = new MemoryStore();
    const index = sellableIndex();
    await store.saveCatalog(index, NOW);
    const service = new ResolutionService(store, () => NOW, silentLogger);
    const feed = new MemoryOutcomeFeed();
    const buyerAddress = toAddress(buyer.address);
    for (const verdict of ["passed", "passed", "failed"] as const) {
      const previewId = nextPreviewId();
      const offer = resolve({ task: gatingTask, profile: matchingProfile }, index, {
        now: NOW,
        previewId,
        payment: { network: "eip155:421614", asset: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d", maxTimeoutSeconds: 300 },
        offerTtlSeconds: 900,
      });
      await store.saveOffer(offer);
      await service.prepare(previewId, { payer: buyerAddress, nonce: previewId, validBefore: new Date(NOW.getTime() + 300_000) });
      await service.commit(deriveResolutionId(previewId, buyerAddress), { nonce: previewId, settlementRef: previewId });
      feed.add(
        outcomeFor(previewId, buyerAddress, {
          verdict,
          acceptance: verdict === "passed" ? { exitCode: 0, durationMs: 10, outputDigest: null } : { exitCode: 1, durationMs: 10, outputDigest: null },
          buyerAgentId: buyerAgent.toString(),
        }),
      );
    }

    // The first process dies right after its first send lands on chain.
    let sends = 0;
    const counting = { ...chain, attester: chain.attester, giveFeedback: async (...a: Parameters<typeof chain.giveFeedback>) => (sends++, chain.giveFeedback(...a)) };
    const dying = Object.assign(Object.create(store) as MemoryStore, {
      updateReputationPost: async (...args: Parameters<MemoryStore["updateReputationPost"]>) => {
        if (sends > 0) throw new Error("process killed");
        return store.updateReputationPost(...args);
      },
    });
    // The attester's clock runs a month behind the wall clock. Each send's deadline is read on the attester's own clock, so
    // its sends still go out (read on the wall clock, every deadline would have passed, and nothing would be sent).
    const start = new Date(Date.now() - 30 * 86_400_000);
    let now = start;
    const deps = { chain: counting, feed, providerAgentId: agentId.toString(), publicBaseUrl: "https://lemma.example", clock: () => now, logger: silentLogger };
    await new Attester({ ...deps, store: dying }).tick();
    expect(sends).toBe(1);

    // Once the dead process's claim has lapsed.
    now = new Date(start.getTime() + ATTEMPT_LEASE_MS);
    const restarted = new Attester({ ...deps, store });
    const result = await restarted.tick();
    expect(result).toMatchObject({ posted: 6, skipped: 0 });
    // Six feedbacks: three outcomes, to the provider and to the buyer's own agent; the crashed send was found, not repeated.
    expect(sends).toBe(6);
    const logs = await publicClient.getContractEvents({ address: reputation as Hex, abi: reputationRegistryAbi, eventName: "NewFeedback", fromBlock: 0n, strict: true });
    expect(logs.filter((l) => l.args.agentId === agentId)).toHaveLength(3);
    expect(logs.filter((l) => l.args.agentId === buyerAgent)).toHaveLength(3);
    expect(logs.every((l) => l.args.clientAddress.toLowerCase() === chain.attester && l.args.tag1 === "lemma.adoption" && l.args.tag2 === "mcp-server.add-payment-gating" && l.args.endpoint === "")).toBe(true);
    // Each feedback points at its own file, served byte for byte: its keccak256 is the hash in the event, and its ERC-8004
    // fields are the event's, from the attester, to an agent of this identity registry.
    const served = app({ store });
    for (const log of logs) {
      const path = new URL(log.args.feedbackURI).pathname;
      expect(path).toMatch(new RegExp(`^/api/v1/evidence/0x[0-9a-f]{64}/${log.args.agentId === agentId ? "provider" : "buyer-agent"}$`));
      const res = await served.request(path);
      expect(res.status).toBe(200);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(keccak256(bytes)).toBe(log.args.feedbackHash.toLowerCase());
      const file = AdoptionFeedbackFile.parse(JSON.parse(new TextDecoder().decode(bytes)));
      expect(file).toMatchObject({ agentRegistry: `eip155:421614:${identity}`, clientAddress: `eip155:421614:${chain.attester}` });
      expect(file.lemma.resolutionId).toBe(path.split("/")[4]);
      expect([BigInt(file.agentId), BigInt(file.value), file.valueDecimals, file.tag1, file.tag2, file.endpoint]).toEqual([
        log.args.agentId,
        log.args.value,
        log.args.valueDecimals,
        log.args.tag1,
        log.args.tag2,
        log.args.endpoint,
      ]);
    }
    const first = logs[0];
    if (first === undefined) throw new Error("no feedback");
    expect(await chain.findFeedback({ agentId: first.args.agentId, feedbackHash: first.args.feedbackHash.toLowerCase() as Hex32, fromBlock: 0n })).toBe(first.transactionHash.toLowerCase());
    expect(await chain.findFeedback({ agentId, feedbackHash: `0x${"00".repeat(32)}`, fromBlock: 0n })).toBeUndefined();
    expect(await chain.nonces()).toEqual({ pending: 6, mined: 6 });
    expect(await chain.receiptStatus(first.transactionHash.toLowerCase() as Hex32)).toBe("success");
    expect(await chain.receiptStatus(`0x${"ab".repeat(32)}`)).toBe("unknown");

    // A send past its deadline broadcasts nothing: the attester's nonce does not move.
    const nonce = await publicClient.getTransactionCount({ address: chain.attester as Hex });
    const late = { agentId, value: 100n, valueDecimals: 0, tag1: "lemma.adoption", tag2: "x", endpoint: "", feedbackURI: "https://lemma.example/e", feedbackHash: `0x${"22".repeat(32)}` as Hex32 };
    await expect(chain.giveFeedback(late, { notAfter: new Date(now.getTime() - 1), clock: () => now })).rejects.toBeInstanceOf(SendDeadlineError);
    expect(await publicClient.getTransactionCount({ address: chain.attester as Hex, blockTag: "pending" })).toBe(nonce);
    // A resend with a nonce an earlier transaction took is refused by the node, never mined.
    await expect(chain.giveFeedback(late, { notAfter: new Date(now.getTime() + 60_000), clock: () => now, nonce: nonce - 1 })).rejects.toThrow();
    expect(await chain.nonces()).toEqual({ pending: nonce, mined: nonce });
    expect(await chain.findFeedback({ agentId, feedbackHash: late.feedbackHash, fromBlock: 0n })).toBeUndefined();

    const summary = await chain.summary({ agentId, tag1: "lemma.adoption", tag2: "mcp-server.add-payment-gating" });
    expect(summary).toEqual({ count: 3n, value: 66n, decimals: 0 });
    expect(toReputation(summary)).toEqual({ passBps: 6600, count: 3 });
    // The summary counts only the attester: nobody else's feedback moves it.
    expect(await chain.summary({ agentId, tag1: "lemma.adoption", tag2: "other" })).toMatchObject({ count: 0n });
  });

  it("refuses self-feedback by the registry's own rule (owner, approved address or operator), and feedback to no agent", async () => {
    const chain = chainFor(attesterKey);
    const request = (agentId: bigint) => ({ agentId, value: 100n, valueDecimals: 0, tag1: "lemma.adoption", tag2: "x", endpoint: "", feedbackURI: "https://lemma.example/e", feedbackHash: `0x${"11".repeat(32)}` as Hex32 });
    const refusalOfSend = async (agentId: bigint) => refusalOf(await chain.giveFeedback(request(agentId), { notAfter: new Date(Date.now() + 60_000), clock: () => new Date() }).catch((e: unknown) => e));
    const erc721 = [
      { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] },
      { type: "function", name: "setApprovalForAll", stateMutability: "nonpayable", inputs: [{ name: "operator", type: "address" }, { name: "approved", type: "bool" }], outputs: [] },
    ] as const;
    const mined = async (hash: Hex) => expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
    const approve = async (key: Hex, agentId: bigint) => {
      const w = wallet(key);
      await mined(await w.writeContract({ address: identity as Hex, abi: erc721, functionName: "approve", args: [chain.attester as Hex, agentId], account: w.account, chain: arbitrumSepolia }));
    };
    const approveForAll = async (key: Hex) => {
      const w = wallet(key);
      await mined(await w.writeContract({ address: identity as Hex, abi: erc721, functionName: "setApprovalForAll", args: [chain.attester as Hex, true], account: w.account, chain: arbitrumSepolia }));
    };

    // The attester owns the agent.
    const { agentId: owned } = await registerAgent(clientsFor(attesterKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    // The owner approved the attester for one agent, or as an operator of all its agents.
    const { agentId: approved } = await registerAgent(clientsFor(ownerKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    await approve(ownerKey, approved);
    const otherOwnerKey = generatePrivateKey();
    await createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport: http(rpcUrl) }).setBalance({ address: privateKeyToAccount(otherOwnerKey).address, value: parseEther("1") });
    const { agentId: operated } = await registerAgent(clientsFor(otherOwnerKey), identity, "https://lemma.example/api/v1/agent/registration.json");
    await approveForAll(otherOwnerKey);
    for (const agentId of [owned, approved, operated]) {
      expect(await chain.feedbackRefusal(agentId)).toBe("SELF_FEEDBACK");
      expect(await refusalOfSend(agentId)).toBe("SELF_FEEDBACK");
    }
    // An agent that does not exist.
    expect(await chain.feedbackRefusal(999_999n)).toBe("NO_SUCH_AGENT");
    expect(await refusalOfSend(999_999n)).toBe("NO_SUCH_AGENT");
    // The owner's own agent, with nobody approved: the registry takes the attester's feedback.
    const { agentId: clean } = await registerAgent(clientsFor(buyerKey), identity, "https://buyer.example/agent.json");
    expect(await chain.feedbackRefusal(clean)).toBeUndefined();

    // The attester stops before sending, and says why.
    for (const [agentId, event] of [[approved, "reputation.self_feedback"], [999_999n, "reputation.no_such_agent"]] as const) {
      const events: string[] = [];
      const attester = new Attester({ store: new MemoryStore(), chain, feed: new MemoryOutcomeFeed(), providerAgentId: agentId.toString(), publicBaseUrl: "https://lemma.example", clock: () => NOW, logger: { log: (_l, e) => void events.push(e) } });
      await attester.tick();
      expect(events).toEqual([event]);
    }
  });

  it("runs the register script end to end, with the owner key only in its environment", async () => {
    const script = fileURLToPath(new URL("../src/scripts/register-agent.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    const env = { PATH: process.env["PATH"] ?? "", AGENT_OWNER_PRIVATE_KEY: ownerKey, ARBITRUM_SEPOLIA_RPC_URL: rpcUrl, PUBLIC_BASE_URL: "https://lemma.example", ERC8004_IDENTITY_REGISTRY: identity };
    const { stdout } = await exec(tsx, [script], { env });
    const id = /registered agent (\d+)/.exec(stdout)?.[1];
    expect(id).toBeDefined();
    expect(stdout).toContain(`set LEMMA_AGENT_ID=${id}`);
    expect(stdout).not.toContain(ownerKey.slice(2));
    const updated = await exec(tsx, [script, "--update", id as string, "--uri", "https://lemma.example/v3.json"], { env });
    expect(updated.stdout).toContain(`agent ${id} now points at https://lemma.example/v3.json`);
    // The attester's key is refused as the owner's, and no key is taken from the arguments.
    await expect(exec(tsx, [script], { env: { ...env, ATTESTER_PRIVATE_KEY: ownerKey } })).rejects.toMatchObject({ stderr: expect.stringContaining("attester's key") });
    const refused = await exec(tsx, [script, "--update", ownerKey], { env }).catch((e: { stderr: string }) => e);
    expect(refused.stderr).toContain("never an argument");
    expect(refused.stderr).not.toContain(ownerKey.slice(2));
  }, 60_000);
});
