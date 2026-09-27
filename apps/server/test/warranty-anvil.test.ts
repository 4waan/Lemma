import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { type Address, type Hex32, type WarrantyOutcome, type WarrantyVoucher, toAddress, warrantyClaimHash, warrantyOutcomeTypedData, warrantyVoucherTypedData } from "@lemma/core";
import { type Abi, type Hex, type PublicClient, createPublicClient, createTestClient, createWalletClient, hashTypedData, http, keccak256, nonceManager, parseEther, stringToHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Secret, SendDeadlineError, type WarrantyChain, registryRevertOf, requestWithdrawal, startWarrantyPipeline, viemWarrantyChain } from "../src/index.js";
import { recordingLogger, warrantyWorld } from "./warranty-helpers.js";

/**
 * `viemWarrantyChain` against the real registry on a local anvil node (chain
 * id 421614): typed data the contract accepts, tuple arguments, decoded
 * events with block times, decoded custom errors, the engine hook's gas, and
 * each sender's nonce manager. Runs when LEMMA_REGISTRY_ARTIFACTS names the
 * `forge build` output directory of contracts/ (contracts/out, with the
 * test mocks MockUSDC and RecordingEngine) and anvil is on PATH (or
 * LEMMA_ANVIL); skipped otherwise. Every key is made here, at run time.
 */
const artifacts = process.env["LEMMA_REGISTRY_ARTIFACTS"];
const anvilBin = process.env["LEMMA_ANVIL"] ?? "anvil";

const artifact = (file: string, name: string) => {
  const json = JSON.parse(readFileSync(join(artifacts as string, file, `${name}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
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

const id = (label: string) => keccak256(stringToHex(label)) as Hex32;

describe.skipIf(artifacts === undefined || artifacts === "")("the warranty chain client against the registry on anvil", () => {
  let anvil: ChildProcess;
  let rpcUrl: string;
  let publicClient: PublicClient;
  let chain: WarrantyChain;
  let registry: Address;
  let usdc: Address;
  let engine: Address;
  const keys = { owner: generatePrivateKey(), provider: generatePrivateKey(), evaluator: generatePrivateKey() };
  const owner = privateKeyToAccount(keys.owner);
  const RELEASE = id("release");
  const refundTo = toAddress(privateKeyToAccount(generatePrivateKey()).address);

  const wallet = (key: Hex, managed = false) =>
    createWalletClient({ account: managed ? privateKeyToAccount(key, { nonceManager }) : privateKeyToAccount(key), chain: arbitrumSepolia, transport: http(rpcUrl) });
  const test = () => createTestClient({ chain: arbitrumSepolia, mode: "anvil", transport: http(rpcUrl) });
  const clock = () => new Date();
  const later = () => ({ notAfter: new Date(Date.now() + 60_000), clock });
  /** A transaction from one of the test's own keys, mined. */
  let sendAs: (key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => Promise<void>;

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
    for (const key of Object.values(keys)) await test().setBalance({ address: privateKeyToAccount(key).address, value: parseEther("10") });
    const deployer = wallet(keys.owner);
    const deploy = async (file: string, name: string, args: readonly unknown[] = []) => {
      const { abi, bytecode } = artifact(file, name);
      const hash = await deployer.deployContract({ abi, bytecode, args, account: owner, chain: arbitrumSepolia });
      return toAddress((await publicClient.waitForTransactionReceipt({ hash })).contractAddress as string);
    };
    usdc = await deploy("MockUSDC.sol", "MockUSDC");
    registry = await deploy("ResolutionWarrantyRegistry.sol", "ResolutionWarrantyRegistry", [usdc, owner.address]);
    engine = await deploy("MockEngines.sol", "RecordingEngine");
    const registryAbi = artifact("ResolutionWarrantyRegistry.sol", "ResolutionWarrantyRegistry").abi;
    const usdcAbi = artifact("MockUSDC.sol", "MockUSDC").abi;
    const provider = privateKeyToAccount(keys.provider);
    const evaluator = privateKeyToAccount(keys.evaluator);
    const send = async (key: Hex, address: Address, abi: Abi, functionName: string, args: readonly unknown[]) => {
      const hash = await wallet(key).writeContract({ address: address as Hex, abi, functionName, args, chain: arbitrumSepolia, account: privateKeyToAccount(key) });
      expect((await publicClient.waitForTransactionReceipt({ hash })).status).toBe("success");
    };
    sendAs = send;
    await send(keys.owner, registry, registryAbi, "registerRelease", [RELEASE, provider.address, evaluator.address, 3600]);
    await send(keys.owner, registry, registryAbi, "setEngine", [engine]);
    await send(keys.owner, usdc, usdcAbi, "mint", [provider.address, 10_000_000n]);
    await send(keys.provider, usdc, usdcAbi, "approve", [registry, 10_000_000n]);
    await send(keys.provider, registry, registryAbi, "depositBond", [RELEASE, 2_000_000n]);
    chain = viemWarrantyChain({ publicClient, providerWallet: wallet(keys.provider, true), evaluatorWallet: wallet(keys.evaluator, true), registry, chainId: 421614, receiptTimeoutMs: 10_000 });
  }, 120_000);

  afterAll(() => {
    anvil?.kill();
  });

  const head = async () => (await chain.head()).timestamp.getTime() / 1000;
  const voucher = async (resolutionId: Hex32, over: Partial<WarrantyVoucher> = {}): Promise<WarrantyVoucher> => ({
    schemaVersion: "1",
    resolutionId,
    releaseDigest: RELEASE,
    profileIndex: 1,
    amount: "250000",
    paymentRef: id(`ref ${resolutionId}`),
    claimHash: warrantyClaimHash(resolutionId, id(`secret ${resolutionId}`), refundTo),
    activateBy: Math.floor(await head()) + 900,
    ...over,
  });
  const activate = async (v: WarrantyVoucher) => chain.send({ fn: "activateResolution", voucher: v, signature: await chain.signVoucher(v) }, later());
  const finalize = async (o: WarrantyOutcome) => chain.send({ fn: "finalizeOutcome", outcome: o, signature: await chain.signOutcome(o) }, later());
  const outcome = async (resolutionId: Hex32, verdict: WarrantyOutcome["verdict"]): Promise<WarrantyOutcome> => ({
    schemaVersion: "1",
    resolutionId,
    verdict,
    weightBps: 10_000,
    evidenceHash: id(`evidence ${resolutionId}`),
    validUntil: Math.floor(await head()) + 600,
  });

  it("is the registry the server signs for: its token and its voucher digest", async () => {
    const v = await voucher(id("identity"));
    expect(await chain.registryIdentity(v)).toEqual({ usdc, voucherDigest: hashTypedData(warrantyVoucherTypedData(v, { chainId: 421614, registry })) });
    expect(await chain.release(RELEASE)).toEqual({ provider: chain.provider, evaluator: chain.evaluator, claimWindowSeconds: 3600, active: true, available: 2_000_000n, reserved: 0n });
    expect((await chain.release(id("unknown"))).provider).toBe("0x0000000000000000000000000000000000000000");
  });

  it("activates, finalizes into the engine and relays a credit, and reads each event back with its block time", async () => {
    const passed = id("passed");
    const failed = id("failed");
    const from = (await chain.head()).number;
    for (const r of [passed, failed]) expect(await chain.waitForReceipt(await activate(await voucher(r)))).toBe("success");
    const active = await chain.resolution(passed);
    expect(active).toMatchObject({ status: "active", releaseDigest: RELEASE, profileIndex: 1, amount: 250_000n });
    expect(active.claimDeadline).toBeGreaterThan(BigInt(Math.floor(await head())));
    expect(await chain.waitForReceipt(await finalize(await outcome(passed, "passed")))).toBe("success");
    expect(await chain.waitForReceipt(await finalize(await outcome(failed, "failed")))).toBe("success");
    // The engine got both outcomes: the gas estimate plus a fifth covers its full budget.
    const calls = await publicClient.readContract({ address: engine as Hex, abi: artifact("MockEngines.sol", "RecordingEngine").abi, functionName: "callCount" });
    expect(calls).toBe(2n);
    expect((await chain.resolution(failed)).status).toBe("failed");
    const tx = await chain.send({ fn: "withdrawCredit", resolutionId: failed, claimSecret: id(`secret ${failed}`), to: refundTo }, later());
    expect(await chain.waitForReceipt(tx)).toBe("success");
    expect(await chain.receiptStatus(tx)).toBe("success");
    expect((await chain.resolution(failed)).status).toBe("refunded");
    const balance = await publicClient.readContract({ address: usdc as Hex, abi: artifact("MockUSDC.sol", "MockUSDC").abi, functionName: "balanceOf", args: [refundTo] });
    expect(balance).toBe(250_000n);

    const logs = await chain.registryLogs(from, (await chain.head()).number);
    expect(logs.map((l) => [l.name, l.resolutionId])).toEqual([
      ["ResolutionActivated", passed],
      ["ResolutionActivated", failed],
      ["OutcomeFinalized", passed],
      ["OutcomeFinalized", failed],
      ["CreditWithdrawn", failed],
    ]);
    expect(logs[0]).toMatchObject({ releaseDigest: RELEASE, profileIndex: 1, amount: "250000", removed: false });
    expect(logs[2]).toMatchObject({ verdict: 1, weightBps: 10_000, evidenceHash: id(`evidence ${passed}`) });
    for (const log of logs) {
      const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
      expect(log.blockTime.getTime()).toBe(Number(block.timestamp) * 1000);
    }
  });

  it("decodes the registry's refusals from the simulation, before anything is sent", async () => {
    const r = id("refusals");
    await chain.waitForReceipt(await activate(await voucher(r)));
    const before = await chain.nonces("provider");
    const again = await voucher(r);
    await expect(activate(again)).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "RESOLUTION_ALREADY_EXISTS");
    await expect(activate(await voucher(id("too big"), { amount: "900000000" }))).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "INSUFFICIENT_AVAILABLE_BOND");
    await expect(activate(await voucher(id("stale"), { activateBy: 1 }))).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "VOUCHER_EXPIRED");
    const { claimDeadline } = await chain.resolution(r);
    await expect(chain.send({ fn: "expireResolution", resolutionId: r }, later())).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "CLAIM_WINDOW_OPEN" && registryRevertOf(e)?.args[0] === claimDeadline);
    await expect(chain.send({ fn: "withdrawCredit", resolutionId: r, claimSecret: id("x"), to: refundTo }, later())).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "NO_CREDIT");
    // A signature by anyone but the release's evaluator.
    const o = await outcome(r, "passed");
    const forged = await privateKeyToAccount(generatePrivateKey()).signTypedData(warrantyOutcomeTypedData(o, { chainId: 421614, registry }));
    await expect(chain.send({ fn: "finalizeOutcome", outcome: o, signature: forged }, later())).rejects.toSatisfy((e) => registryRevertOf(e)?.code === "INVALID_EVALUATOR_SIGNATURE");
    expect(await chain.nonces("provider")).toEqual(before);
  });

  it("expires a warranty after its claim window, by the chain's clock", async () => {
    const r = id("expiring");
    await chain.waitForReceipt(await activate(await voucher(r)));
    await test().increaseTime({ seconds: 3601 });
    await test().mine({ blocks: 1 });
    const tx = await chain.send({ fn: "expireResolution", resolutionId: r }, later());
    expect(await chain.waitForReceipt(tx)).toBe("success");
    expect((await chain.resolution(r)).status).toBe("expired");
    const [expired] = await chain.registryLogs((await chain.head()).number, (await chain.head()).number);
    expect(expired).toMatchObject({ name: "ResolutionExpired", resolutionId: r, amount: "250000" });
  });

  it("gives concurrent sends from one sender consecutive nonces, and a send past its deadline leaves no gap", async () => {
    const [a, b] = [id("parallel a"), id("parallel b")];
    const [va, vb] = [await voucher(a), await voucher(b)];
    const hashes = await Promise.all([activate(va), activate(vb)]);
    for (const hash of hashes) expect(await chain.waitForReceipt(hash)).toBe("success");
    const v = await voucher(id("late"));
    await expect(chain.send({ fn: "activateResolution", voucher: v, signature: await chain.signVoucher(v) }, { notAfter: new Date(0), clock })).rejects.toBeInstanceOf(SendDeadlineError);
    expect(await chain.waitForReceipt(await activate(v))).toBe("success");
    const counts = await chain.nonces("provider");
    expect(counts.pending).toBe(counts.mined);
  });

  it("runs the pipeline's jobs against it: activation, a pass into the engine, a refunded failure and an expiry", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    w.clock.now = new Date();
    const digest = w.entry.releaseDigest;
    const registryAbi = artifact("ResolutionWarrantyRegistry.sol", "ResolutionWarrantyRegistry").abi;
    await sendAs(keys.owner, registry, registryAbi, "registerRelease", [digest, chain.provider, chain.evaluator, 3600]);
    await sendAs(keys.provider, registry, registryAbi, "depositBond", [digest, 1_000_000n]);
    const logger = recordingLogger();
    const pipeline = await startWarrantyPipeline({
      config: { registry, startBlock: 0n, providerKey: new Secret("held by the chain client"), providerAddress: chain.provider, evaluatorKey: new Secret("held by the chain client"), evaluatorAddress: chain.evaluator, failures: "auto", activationJitterSeconds: 0, activationBatchSeconds: 0, indexerConfirmations: 0n },
      store: w.store,
      index: w.index,
      chain,
      usdc,
      clock: () => w.clock.now,
      logger,
      start: false,
    });
    const [passed, failed, silent] = [await w.buy(), await w.buy("0x00000000000000000000000000000000000000c1"), await w.buy("0x00000000000000000000000000000000000000c2")];
    expect((await pipeline.views.forResolution(passed!.id)).state).toBe("pending");
    expect(await pipeline.activator.runOnce()).toMatchObject({ queued: 3, done: 3 });
    await pipeline.indexer.runOnce();
    expect((await pipeline.views.forResolution(passed!.id)).state).toBe("active");

    await w.receipt(passed!, "passed");
    await w.receipt(failed!, "failed");
    expect(await pipeline.evaluator.runOnce()).toMatchObject({ queued: 2, done: 2 });
    await pipeline.indexer.runOnce();
    expect((await pipeline.views.forResolution(passed!.id)).state).toBe("passed");
    // The pass went into the engine: the catalog's source holds it, at its block's time.
    const [finalized] = await w.store.listRegistryEvents({ resolutionId: passed!.id, names: ["OutcomeFinalized"] }, 1);
    expect(pipeline.source.outcomesFor(digest, 0)).toEqual([
      { passed: true, weightBps: 10_000, at: BigInt(finalized!.blockTime.getTime() / 1000) },
      { passed: false, weightBps: 10_000, at: expect.any(BigInt) },
    ]);

    expect(await requestWithdrawal({ store: w.store, clock: () => w.clock.now, logger }, { resolutionId: failed!.id, claimSecret: failed!.secret, to: failed!.refundTo })).toMatchObject({ status: 202 });
    expect(await pipeline.relay.runOnce()).toMatchObject({ done: 1 });
    const balance = await publicClient.readContract({ address: usdc as Hex, abi: artifact("MockUSDC.sol", "MockUSDC").abi, functionName: "balanceOf", args: [failed!.refundTo] });
    expect(balance).toBe(250_000n);

    await test().increaseTime({ seconds: 3601 });
    await test().mine({ blocks: 1 });
    // Every warranty past its window: this one, and those the earlier tests left active on this chain.
    const expiries = await pipeline.expirer.runOnce();
    expect(expiries).toMatchObject({ failed: 0, abandoned: 0 });
    expect(expiries.done).toBe(expiries.queued);
    expect(expiries.done).toBeGreaterThanOrEqual(1);
    await pipeline.indexer.runOnce();
    expect((await pipeline.views.forResolution(failed!.id)).state).toBe("refunded");
    expect((await pipeline.views.forResolution(silent!.id)).state).toBe("expired");
    expect(pipeline.views.engine()).toBe(engine);
    const text = JSON.stringify(logger.lines);
    for (const b of [passed!, failed!, silent!]) for (const hidden of [b.payer, b.secret, b.refundTo]) expect(text).not.toContain(hidden.slice(2));
  });
});
