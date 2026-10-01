import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readKeyFile, walletKeys } from "@lemma/bridge";
import { fold, priorFromEvidence, unixSeconds } from "@lemma/confidence";
import { type Address, CatalogView, type Hex32, ResolutionView, StatusView, VERDICT_FAILED, VERDICT_PASSED, adoptionReceiptDigest, formatUsdc, toAddress } from "@lemma/core";
import { ATTEMPT_LEASE_MS, MIGRATIONS_FOLDER, PgStore, type RegistryEventRow, WITHDRAWALS_PATH, reputationRegistryAbi, warrantyRegistryAbi } from "@lemma/server";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Hex, encodeDeployData, getAddress, keccak256, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { initSignerKey, startAgentProcess, startSignerProcess } from "./lib/agent.js";
import { type Bridge, inProcessSigner, startBridge } from "./lib/bridge.js";
import { CAPABILITY, type E2eCatalog, writeCatalog, writeWorkspace } from "./lib/catalog.js";
import { type LocalChain, type LocalUsdc, deployErc8004, engineAbi, installUsdc, localChain, registryReadAbi, runtimeKey } from "./lib/chain.js";
import { type RunningServer, crashableStore, recordingJsonLogger, startServer } from "./lib/server.js";
import { type Anvil, ROOT, type ScriptResult, forgeArtifact, freePort, runScript, startAnvil, until } from "./lib/tools.js";

/**
 * The outcome pipeline end to end on a local chain (docs/deployment.md,
 * "Rehearsing the runbook locally"): anvil as Arbitrum Sepolia, Circle's FiatTokenV2_2
 * at the USDC address, the warranty registry built from contracts/, a
 * Solidity stand-in with the Stylus engine's interface, and the official
 * ERC-8004 registries. Roles, releases, bonds, the engine and its priors, and
 * the provider's agent are set up with the runbook's own scripts; then the
 * real server app and its jobs, and real bridges buying through their
 * in-process signers, run the scenarios; the last purchase goes through the
 * shipped lemma-signer and lemma-mcp programs as processes. Every key is made
 * at run time.
 *
 * The scenarios run in order on one chain. Expiry runs last: it moves the
 * chain's clock an hour ahead, and x402 authorizations are timed by the wall
 * clock.
 */

const PUBLIC_BASE_URL = "https://lemma.e2e.test";
const PRICE = 250_000n;
const ROLES = ["deployer", "provider", "facilitator", "evaluator", "attester", "agent-owner", "buyer"] as const;
type Role = (typeof ROLES)[number];

describe("the outcome pipeline on a local chain", () => {
  let tmp: string;
  let anvil: Anvil;
  let chain: LocalChain;
  let usdc: LocalUsdc;
  const roles = {} as Record<Role, { readonly key: Hex; readonly address: Address }>;
  let registry: Address;
  let registryBlock: bigint;
  let engine: Address;
  let identity: Address;
  let reputation: Address;
  let catalog: E2eCatalog;
  let agentId: string;
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle>;
  let port: number;
  let server: RunningServer;
  let crash: ReturnType<typeof crashableStore>;
  /** The server's clock: the wall clock, moved ahead in the crash scenario. */
  let clockOffsetMs = 0;
  const clock = () => new Date(Date.now() + clockOffsetMs);
  const logger = recordingJsonLogger();
  const bridges: Bridge[] = [];
  /** Every private key and claim secret of the run: no log line or printed output may hold one. */
  const secrets: string[] = [];
  /** Every buyer and refund address: no server log line may hold one. */
  const hidden: string[] = [];
  const outputs: string[] = [];

  const script = async (path: string, args: readonly string[], env: Record<string, string>): Promise<ScriptResult> => {
    const result = await runScript(path, args, env);
    outputs.push(result.stdout, result.stderr);
    return result;
  };
  const admin = (args: readonly string[], env: Record<string, string> = {}) =>
    script("apps/server/src/scripts/warranty-admin.ts", [...args, ...(args[0] === "set-engine" ? [] : ["--catalog", catalog.root])], { ARBITRUM_SEPOLIA_RPC_URL: anvil.url, RESOLUTION_WARRANTY_REGISTRY_ADDRESS: getAddress(registry), ...env });

  const serverEnv = (): Record<string, string> => ({
    NODE_ENV: "test",
    PORT: String(port),
    // Satisfies the config gates only: the run hands the server a PgStore over in-process PGlite (e2e/lib/server.ts).
    DATABASE_URL: "postgres://lemma-e2e@127.0.0.1:5432/in-process-pglite",
    PAID_TOOLS: "on",
    PROVIDER_ADDRESS: getAddress(roles.provider.address),
    FACILITATOR_PRIVATE_KEY: roles.facilitator.key,
    ARBITRUM_SEPOLIA_RPC_URL: anvil.url,
    RESOLUTION_WARRANTY_REGISTRY_ADDRESS: getAddress(registry),
    WARRANTY_REGISTRY_START_BLOCK: registryBlock.toString(),
    PROVIDER_PRIVATE_KEY: roles.provider.key,
    EVALUATOR_PRIVATE_KEY: roles.evaluator.key,
    EVALUATOR_FAILURES: "auto",
    WARRANTY_ACTIVATION_JITTER_SECONDS: "0",
    WARRANTY_ACTIVATION_BATCH_SECONDS: "0",
    BUYER_COUNTS_REFRESH_SECONDS: "0",
    // A shallow depth, so the run waits seconds rather than the minute 64 blocks of anvil's one-second blocks take.
    WARRANTY_INDEXER_CONFIRMATIONS: "2",
    EXPLORER_BASE_URL: "",
    PUBLIC_BASE_URL,
    ERC8004_IDENTITY_REGISTRY: getAddress(identity),
    ERC8004_REPUTATION_REGISTRY: getAddress(reputation),
    LEMMA_AGENT_ID: agentId,
    ATTESTER_PRIVATE_KEY: roles.attester.key,
    RATE_LIMIT_PER_MINUTE: "10000",
  });

  const get = async (path: string) => {
    const res = await fetch(`${server.url}${path}`);
    if (!res.ok) throw new Error(`GET ${path} answered ${res.status}`);
    return (await res.json()) as unknown;
  };
  const view = async (id: Hex32) => ResolutionView.parse(await get(`/api/v1/resolutions/${id}`));
  const warrantyIn = (id: Hex32, state: string) =>
    until(
      async () => {
        const v = await view(id);
        return v.warranty?.state === state && v;
      },
      { what: `the warranty of ${id.slice(0, 10)} to be ${state}` },
    );
  const catalogProfile = async () => {
    const c = CatalogView.parse(await get("/api/v1/catalog"));
    const release = c.releases.find((r) => r.releaseDigest === catalog.releaseDigest);
    if (release === undefined) throw new Error("the release is not in the catalog");
    return { generatedAt: c.generatedAt, release, profile: release.profiles[0]! };
  };
  const registryEvents = async (id: Hex32, names: RegistryEventRow["name"][]) => new PgStore(db).listRegistryEvents({ resolutionId: id, names }, 16);
  const engineCalls = async () => Number(await chain.publicClient.readContract({ address: engine as Hex, abi: engineAbi, functionName: "callCount" }));
  const summary = async () => {
    const [count, value, decimals] = await chain.publicClient.readContract({
      address: reputation as Hex,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      args: [BigInt(agentId), [getAddress(roles.attester.address)], "lemma.adoption", CAPABILITY],
    });
    return { count, value, decimals };
  };
  const release = async () => chain.publicClient.readContract({ address: registry as Hex, abi: warrantyRegistryAbi, functionName: "release", args: [catalog.releaseDigest as Hex] });

  /** A buyer with its own key (made here) and `usdc` atomic USDC to spend. */
  const buyer = async (usdcAtomic: bigint) => {
    const b = runtimeKey();
    secrets.push(b.key);
    hidden.push(b.address);
    await usdc.mint(b.address, usdcAtomic);
    return b;
  };
  const bridgeFor = async (key: Hex, variant: "pass" | "fail", refundTo?: Address, signer = inProcessSigner(key, roles.provider.address, tmp)) => {
    // Purchases need a refund address apart from the paying wallet: a fresh one unless the scenario names it.
    const b = await startBridge({ apiUrl: server.url, signer, provider: roles.provider.address, variant, dir: tmp, refundTo: refundTo ?? runtimeKey().address });
    bridges.push(b);
    return b;
  };
  /** An agent's purchase through its bridge: preview, then buy; the resolution id from the stored delivery. */
  const purchase = async (bridge: Pick<Bridge, "call" | "inbox">): Promise<Hex32> => {
    const preview = await bridge.call("lemma_preview", { capability: CAPABILITY });
    expect(preview.text, preview.text).toContain("lemma_buy_resolution");
    const bought = await bridge.call("lemma_buy_resolution", { capability: CAPABILITY });
    expect(bought.text, bought.text).toContain("bought for 0.25 USDC");
    const [resolution] = bridge.inbox.resolutions();
    if (resolution === undefined) throw new Error("no delivery stored");
    const claim = bridge.inbox.claim(resolution.resolutionId as Hex32);
    if (claim === undefined) throw new Error("no warranty claim stored");
    secrets.push(claim.claimSecret);
    hidden.push(claim.refundTo);
    return resolution.resolutionId as Hex32;
  };
  /** The agent applies the resolution and runs its acceptance tests; the bridge signs and posts the receipt, which the server verifies. */
  const adopt = async (bridge: Pick<Bridge, "call">, id: Hex32, outcome: "passed" | "failed") => {
    const applied = await bridge.call("lemma_apply_resolution", { capability: CAPABILITY, mode: "apply" });
    expect(applied.text, applied.text).toContain("applied 1 file changes");
    const verified = await bridge.call("lemma_verify_adoption", { capability: CAPABILITY });
    expect(verified.text, verified.text).toContain(outcome === "passed" ? "acceptance passed" : "acceptance failed with exit code 1");
    const v = await until(
      async () => {
        const current = await view(id);
        return current.receipt?.verified === true && current;
      },
      { what: "the receipt's signature to be verified" },
    );
    expect(v.receipt).toEqual({ outcome, verified: true });
  };
  /** The outcome as the chain has it: the finalization's row, with its block time. */
  const finalization = async (id: Hex32) => {
    const [row] = await registryEvents(id, ["OutcomeFinalized"]);
    if (row === undefined) throw new Error("not finalized");
    return row;
  };

  beforeAll(async () => {
    // The bridges run in this process, and a bridge never runs acceptance tests while its environment holds a wallet key.
    const held = walletKeys();
    if (held.length > 0) throw new Error(`unset ${held.join(", ")} first: the bridge refuses to run acceptance tests while its environment holds a wallet key`);
    tmp = mkdtempSync(join(tmpdir(), "lemma-e2e-"));
    anvil = await startAnvil();
    chain = localChain(anvil.url);
    usdc = await installUsdc(chain);
  });

  let failed = false;
  afterEach((ctx) => {
    if (ctx.task.result?.state === "fail") failed = true;
  });

  afterAll(async () => {
    for (const b of bridges) await b.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    await pglite?.close().catch(() => undefined);
    await anvil?.stop();
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    // The server's log (JSON lines through core `redact`), with the run's own keys and claim secrets masked besides: in a
    // file when asked (LEMMA_E2E_SERVER_LOG), and its tail on stderr when a scenario failed.
    const scrub = (line: string) => secrets.reduce((text, secret) => text.split(secret.slice(2)).join("[secret]"), line);
    const lines = logger.lines.map(scrub);
    const file = process.env["LEMMA_E2E_SERVER_LOG"];
    if (file !== undefined && file !== "") writeFileSync(file, `${lines.join("\n")}\n`);
    if (failed) process.stderr.write(`\nthe server's last log lines:\n${lines.slice(-120).join("\n")}\n`);
  });

  it("sets up roles, contracts, the release, its bond and priors, and the provider's agent with the runbook's scripts", async () => {
    // The one key the runbook asks the user for: a funder with test ETH and USDC.
    const funder = runtimeKey();
    secrets.push(funder.key);
    await chain.fund(funder.address, "1");
    await usdc.mint(funder.address, 20_000_000n);
    const rolesEnv = { ARBITRUM_SEPOLIA_RPC_URL: anvil.url, ARBITRUM_SEPOLIA_FUNDER_PRIVATE_KEY: funder.key };
    const rolesDir = join(tmp, "roles");

    // The key directory must be outside the repository, and a key is never an argument.
    const inRepo = await script("ops/sepolia/setup-roles.ts", ["--dir", join(ROOT, "e2e", "roles-not-here")], rolesEnv);
    expect(inRepo).toMatchObject({ code: 1, stderr: expect.stringContaining("inside the repository") });
    expect(existsSync(join(ROOT, "e2e", "roles-not-here"))).toBe(false);
    const asArgument = await script("ops/sepolia/setup-roles.ts", ["--dir", rolesDir, "--gas-eth", funder.key], rolesEnv);
    expect(asArgument).toMatchObject({ code: 1, stderr: expect.stringContaining("never an argument") });
    // As many wallets export it, without 0x: refused too, and never made a directory name.
    const bare = await script("ops/sepolia/setup-roles.ts", ["--dir", join(tmp, funder.key.slice(2))], rolesEnv);
    expect(bare).toMatchObject({ code: 1, stderr: expect.stringContaining("never an argument") });
    expect(existsSync(join(tmp, funder.key.slice(2)))).toBe(false);

    const setup = await script("ops/sepolia/setup-roles.ts", ["--dir", rolesDir], rolesEnv);
    expect(setup.code, setup.stderr).toBe(0);
    expect(statSync(rolesDir).mode & 0o777).toBe(0o700);
    const recorded = JSON.parse(readFileSync(join(rolesDir, "roles.json"), "utf8")) as { chainId: number; roles: Record<Role, Address> };
    expect(recorded.chainId).toBe(421_614);
    for (const role of ROLES) {
      const file = join(rolesDir, `${role}.key`);
      expect(statSync(file).mode & 0o777, role).toBe(0o600);
      // lemma-signer's own reader: the buyer's file is a signer key file as it stands.
      const key = readKeyFile(file);
      roles[role] = { key, address: toAddress(privateKeyToAccount(key).address) };
      secrets.push(key);
      expect(recorded.roles[role]).toBe(roles[role].address);
    }
    hidden.push(roles.buyer.address);
    expect(new Set(ROLES.map((r) => roles[r].address)).size).toBe(ROLES.length);
    for (const role of ROLES.filter((r) => r !== "buyer")) {
      expect(await chain.publicClient.getBalance({ address: roles[role].address as Hex }), role).toBe(role === "deployer" ? 10n ** 16n : 3n * 10n ** 15n);
    }
    expect(await chain.publicClient.getBalance({ address: roles.buyer.address as Hex })).toBe(0n);
    expect(await usdc.balanceOf(roles.provider.address)).toBe(5_000_000n);
    expect(await usdc.balanceOf(roles.buyer.address)).toBe(2_000_000n);
    // A second run reuses the keys and sends nothing: every role is at its target.
    const again = await script("ops/sepolia/setup-roles.ts", ["--dir", rolesDir], rolesEnv);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).not.toMatch(/\+[0-9.]+ (ETH|USDC)/);
    for (const role of ROLES) expect(again.stdout).toContain(`${role.padEnd(11)} ${roles[role].address}`);

    // The registry, deployed and owned by the deployer (on Sepolia: contracts/script/DeployRegistry.s.sol, rehearsed by
    // npm run contracts:rehearse), and the engine's stand-in, owned by the deployer and recording only from the registry
    // (on Sepolia: the Stylus contract, deployed with the same constructor).
    const registryArtifact = forgeArtifact(join(ROOT, "contracts", "out"), "ResolutionWarrantyRegistry.sol", "ResolutionWarrantyRegistry");
    const deployed = await chain.deploy(roles.deployer.key, encodeDeployData({ abi: registryArtifact.abi, bytecode: registryArtifact.bytecode, args: [usdc.address, roles.deployer.address] }));
    registry = deployed.address;
    registryBlock = deployed.block;
    const standIn = forgeArtifact(join(ROOT, "e2e", "contracts", "out"), "ConfidenceStandIn.sol", "ConfidenceStandIn");
    engine = (await chain.deploy(roles.deployer.key, encodeDeployData({ abi: standIn.abi, bytecode: standIn.bytecode, args: [roles.deployer.address, registry] }))).address;
    ({ identity, reputation } = await deployErc8004(chain));
    catalog = writeCatalog(join(tmp, "catalog"), roles.provider.address);

    // The operator script, step by step, each refusal before anything is sent.
    const owner = { REGISTRY_OWNER_PRIVATE_KEY: roles.deployer.key };
    const releaseRoles = { PROVIDER_ADDRESS: getAddress(roles.provider.address), EVALUATOR_ADDRESS: getAddress(roles.evaluator.address) };
    const status = await admin(["status"]);
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toContain("engine: none");
    expect(status.stdout).toContain(`${catalog.ref} ${catalog.releaseDigest}: not registered`);
    expect(await admin(["deposit-bond", catalog.ref, roles.provider.key], { PROVIDER_PRIVATE_KEY: roles.provider.key })).toMatchObject({ code: 1, stderr: expect.stringContaining("never an argument") });
    expect(await admin(["set-engine", getAddress(engine)], { REGISTRY_OWNER_PRIVATE_KEY: roles.provider.key })).toMatchObject({ code: 1, stderr: expect.stringContaining("is not the registry's owner") });
    expect(await admin(["set-engine", getAddress(identity)], owner)).toMatchObject({ code: 1, stderr: expect.stringContaining("not a Lemma compatibility engine") });
    expect(await admin(["deposit-bond", catalog.ref, "5000000"], { PROVIDER_PRIVATE_KEY: roles.provider.key })).toMatchObject({ code: 1, stderr: expect.stringContaining("is not registered") });
    expect(await admin(["set-priors"], { ENGINE_OWNER_PRIVATE_KEY: roles.deployer.key })).toMatchObject({ code: 1, stderr: expect.stringContaining("has no engine") });
    expect(await admin(["register-release", catalog.ref], { ...owner, ...releaseRoles, PROVIDER_ADDRESS: getAddress(roles.facilitator.address) })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not PROVIDER_ADDRESS"),
    });
    expect(await admin(["register-release", catalog.ref], { ...owner, ...releaseRoles, EVALUATOR_ADDRESS: getAddress(roles.provider.address) })).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("the same account"),
    });

    const setEngine = await admin(["set-engine", getAddress(engine)], owner);
    expect(setEngine.code, setEngine.stderr).toBe(0);
    expect(setEngine.stdout).toMatch(new RegExp(`engine ${engine}: set, tx 0x[0-9a-f]{64}`));
    expect(toAddress(await chain.publicClient.readContract({ address: registry as Hex, abi: registryReadAbi, functionName: "engine" }))).toBe(engine);

    const registered = await admin(["register-release", catalog.ref], { ...owner, ...releaseRoles });
    expect(registered.code, registered.stderr).toBe(0);
    expect(registered.stdout).toMatch(/: registered \(provider .*, claim window 3600 s\), tx 0x[0-9a-f]{64}/);
    expect(await release()).toMatchObject({ provider: getAddress(roles.provider.address), evaluator: getAddress(roles.evaluator.address), claimWindowSeconds: 3600, active: true, available: 0n });
    const twice = await admin(["register-release", catalog.ref], { ...owner, ...releaseRoles });
    expect(twice).toMatchObject({ code: 0, stdout: expect.stringContaining("registered already") });

    expect(await admin(["deposit-bond", catalog.ref, "5000000"], { PROVIDER_PRIVATE_KEY: roles.evaluator.key })).toMatchObject({ code: 1, stderr: expect.stringContaining("PROVIDER_PRIVATE_KEY is not") });
    const bond = await admin(["deposit-bond", catalog.ref, "5000000"], { PROVIDER_PRIVATE_KEY: roles.provider.key });
    expect(bond.code, bond.stderr).toBe(0);
    expect(bond.stdout).toContain("deposited 5 USDC (testnet); available 5, reserved 0");
    expect((await release()).available).toBe(5_000_000n);

    const priors = await admin(["set-priors"], { ENGINE_OWNER_PRIVATE_KEY: roles.deployer.key });
    expect(priors.code, priors.stderr).toBe(0);
    // The catalog's own prior: the evidence's treatment arm, 4 passed of 5.
    expect(priorFromEvidence(catalog.evidence)).toEqual({ passes: 4, failures: 1 });
    expect(priors.stdout).toContain(`${catalog.ref} profile 0: prior 4 passed, 1 failed (evidence ${catalog.evidence.runSetDigest}), tx 0x`);
    expect(await chain.publicClient.readContract({ address: engine as Hex, abi: engineAbi, functionName: "stats", args: [catalog.releaseDigest as Hex, 0] })).toEqual([0n, 0n, 0n, 4, 1]);
    const [priorSet] = parseEventLogs({ abi: engineAbi, eventName: "PriorSet", logs: await chain.publicClient.getLogs({ address: engine as Hex, fromBlock: registryBlock }) });
    expect(priorSet?.args).toMatchObject({ releaseDigest: catalog.releaseDigest, profileIndex: 0, passes: 4, failures: 1, evidenceDigest: catalog.evidence.runSetDigest });
    expect(await admin(["set-priors", catalog.ref], { ENGINE_OWNER_PRIVATE_KEY: roles.deployer.key })).toMatchObject({ code: 0, stdout: expect.stringContaining("set already") });
    const after = await admin(["status"]);
    expect(after.stdout).toContain(`engine ${engine}: owner ${roles.deployer.address}, records from ${registry}`);
    expect(after.stdout).toContain(`${catalog.ref} ${catalog.releaseDigest}: active, provider ${roles.provider.address}, evaluator ${roles.evaluator.address}, claim window 3600 s, bond available 5, reserved 0`);

    // The provider's ERC-8004 agent, registered by its owner with track F's script.
    const agent = await script("apps/server/src/scripts/register-agent.ts", [], {
      AGENT_OWNER_PRIVATE_KEY: roles["agent-owner"].key,
      ARBITRUM_SEPOLIA_RPC_URL: anvil.url,
      PUBLIC_BASE_URL,
      ERC8004_IDENTITY_REGISTRY: getAddress(identity),
    });
    expect(agent.code, agent.stderr).toBe(0);
    agentId = /registered agent (\d+)/.exec(agent.stdout)?.[1] as string;
    expect(agentId).toMatch(/^\d+$/);

    // The server, as configured from the runbook's settings, and its first look at the chain.
    pglite = new PGlite();
    db = drizzle(pglite);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    port = await freePort();
    server = await startServer({ env: serverEnv(), catalogRoot: catalog.root, db, clock, logger, port, wrapStore: (s) => (crash = crashableStore(s)).store });
    const chainView = await until(
      async () => {
        const s = StatusView.parse(await get("/api/v1/status"));
        return s.chain.engine !== null && s;
      },
      { what: "the indexer to find the engine" },
    );
    expect(chainView).toMatchObject({ paidTools: true, store: "postgres", economics: "measured" });
    expect(chainView.chain).toEqual({ explorer: null, usdc: usdc.address, registry, engine, identityRegistry: identity, reputationRegistry: reputation, providerAgentId: agentId });
  });

  it("scenario 1, pass: purchase, settlement, activation, a passing receipt, PASSED into the engine, the catalog and ERC-8004 feedback", async () => {
    const bridge = await bridgeFor(roles.buyer.key, "pass");
    const before = { buyer: await usdc.balanceOf(roles.buyer.address), provider: await usdc.balanceOf(roles.provider.address) };
    const id = await purchase(bridge);

    // Settlement: the facilitator moved the price from the buyer to the provider; the buyer paid no gas.
    expect(await usdc.balanceOf(roles.buyer.address)).toBe(before.buyer - PRICE);
    expect(await usdc.balanceOf(roles.provider.address)).toBe(before.provider + PRICE);
    expect(await chain.publicClient.getBalance({ address: roles.buyer.address as Hex })).toBe(0n);
    expect((await view(id)).state).toBe("settled");

    // Activation: the provider's voucher reserved the price from the bond; the indexer shows it.
    const active = await warrantyIn(id, "active");
    expect(active.warranty).toMatchObject({ amount: "250000", outcome: null, feedback: null });
    const activationTx = await chain.publicClient.getTransaction({ hash: active.warranty?.activation as Hex });
    expect(toAddress(activationTx.from)).toBe(roles.provider.address);
    expect((await release()).reserved).toBe(PRICE);

    await adopt(bridge, id, "passed");
    const passed = await warrantyIn(id, "passed");
    const finalized = await finalization(id);
    expect(finalized).toMatchObject({ verdict: VERDICT_PASSED, weightBps: 10_000, txHash: passed.warranty?.outcome });
    expect(finalized.evidenceHash).toBe(adoptionReceiptDigest(bridge.inbox.receipt(id)!.receipt));
    const finalizeTx = await chain.publicClient.getTransaction({ hash: finalized.txHash as Hex });
    expect(toAddress(finalizeTx.from)).toBe(roles.evaluator.address);
    expect((await release()).reserved).toBe(0n);

    // The registry recorded the outcome into the engine.
    expect(await engineCalls()).toBe(1);
    const call = await chain.publicClient.readContract({ address: engine as Hex, abi: engineAbi, functionName: "callAt", args: [0n] });
    expect(call).toMatchObject({ releaseDigest: catalog.releaseDigest, profileIndex: 0, passed: true, weightBps: 10_000, caller: getAddress(registry) });

    // The catalog's confidence: the benchmark prior plus the outcome at its block's time, as @lemma/confidence folds it.
    const { generatedAt, profile } = await until(
      async () => {
        const p = await catalogProfile();
        return p.profile.compatibility?.outcomes === 1 && p;
      },
      { what: "the catalog to count the outcome" },
    );
    const expected = fold(priorFromEvidence(catalog.evidence), [{ passed: true, weightBps: 10_000, at: unixSeconds(finalized.blockTime) }], unixSeconds(new Date(generatedAt)));
    expect(profile.compatibility).toEqual({ confidenceBps: expected.confidenceBps, effectiveNMilli: expected.effectiveNMilli.toString(), outcomes: 1, source: "benchmark+outcomes", buyers: null });

    // ERC-8004: the attester's feedback on the real reputation registry, counted by getSummary.
    const withFeedback = await until(
      async () => {
        const v = await view(id);
        return v.warranty?.feedback !== null && v;
      },
      { what: "the attester's feedback" },
    );
    const receipt = await chain.publicClient.getTransactionReceipt({ hash: withFeedback.warranty?.feedback as Hex });
    const [feedback] = parseEventLogs({ abi: reputationRegistryAbi, eventName: "NewFeedback", logs: receipt.logs });
    expect(feedback?.args).toMatchObject({ agentId: BigInt(agentId), clientAddress: getAddress(roles.attester.address), value: 100n, valueDecimals: 0, tag1: "lemma.adoption", tag2: CAPABILITY, endpoint: "" });
    expect(await summary()).toEqual({ count: 1n, value: 100n, decimals: 0 });
    // The feedback's evidence file, served by the server, hashes to the feedbackHash on chain.
    const path = new URL(feedback!.args.feedbackURI).pathname;
    expect(feedback!.args.feedbackURI.startsWith(`${PUBLIC_BASE_URL}/api/v1/evidence/${id}/`)).toBe(true);
    const file = await fetch(`${server.url}${path}`);
    expect(keccak256(new Uint8Array(await file.arrayBuffer()))).toBe(feedback!.args.feedbackHash);
    // The catalog's cached record, once refreshed from getSummary.
    await server.reputation.summaries?.refresh(CAPABILITY);
    expect((await catalogProfile()).release.reputation).toEqual({ passBps: 10_000, count: 1, buyers: null });
  });

  it("scenario 2, refund: a failing receipt finalizes FAILED (EVALUATOR_FAILURES=auto), and the claim refunds the price", async () => {
    const b = await buyer(1_000_000n);
    const refundTo = runtimeKey().address;
    hidden.push(refundTo);
    const bridge = await bridgeFor(b.key, "fail", refundTo);
    const id = await purchase(bridge);
    expect(bridge.inbox.claim(id)?.refundTo).toBe(refundTo);
    await warrantyIn(id, "active");
    await adopt(bridge, id, "failed");
    const failed = await warrantyIn(id, "failed");
    expect(await finalization(id)).toMatchObject({ verdict: VERDICT_FAILED, weightBps: 10_000, txHash: failed.warranty?.outcome });
    expect(await engineCalls()).toBe(2);
    expect(await chain.publicClient.readContract({ address: engine as Hex, abi: engineAbi, functionName: "callAt", args: [1n] })).toMatchObject({ passed: false, weightBps: 10_000 });

    // The agent collects the refund with lemma_claim_refund: the bridge sees the warranty failed and posts the
    // claim's secret and refund address to the server's relay, for the evaluator to send. The answer names the
    // resolution by its short id and the amount in testnet USDC, and never the secret or the refund address.
    const claim = bridge.inbox.claim(id)!;
    const shortId = `${id.slice(0, 10)}…`;
    expect(await bridge.tools()).toContain("lemma_claim_refund");
    const answer = await bridge.call("lemma_claim_refund", {});
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text.length).toBeLessThanOrEqual(600);
    expect(answer.text).toMatch(new RegExp(`${shortId} (queued|refunded) ${formatUsdc(PRICE).replace(".", "\\.")} testnet USDC`));
    expect(answer.text.toLowerCase()).not.toContain(claim.claimSecret.slice(2).toLowerCase());
    expect(answer.text.toLowerCase()).not.toContain(claim.refundTo.slice(2).toLowerCase());
    const refunded = await warrantyIn(id, "refunded");
    expect(await usdc.balanceOf(refundTo)).toBe(PRICE);
    const withdrawTx = await chain.publicClient.getTransaction({ hash: refunded.warranty?.withdrawal as Hex });
    expect(toAddress(withdrawTx.from)).toBe(roles.evaluator.address);
    // Asked again, the tool reads the refund from the server's view.
    const second = await bridge.call("lemma_claim_refund", { resolutionId: id });
    expect(second.text).toContain(`${shortId} refunded ${formatUsdc(PRICE)} testnet USDC`);
    // Asking the route again relays nothing more; a wrong secret is refused.
    const again = await fetch(`${server.url}${WITHDRAWALS_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolutionId: id, claimSecret: claim.claimSecret, to: claim.refundTo }) });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ resolutionId: id, state: "done" });
    const wrong = await fetch(`${server.url}${WITHDRAWALS_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolutionId: id, claimSecret: `0x${"77".repeat(32)}`, to: claim.refundTo }) });
    expect(wrong.status).toBe(403);
    expect(await registryEvents(id, ["CreditWithdrawn"])).toHaveLength(1);
    expect(await usdc.balanceOf(refundTo)).toBe(PRICE);

    // The failure is public too: the attester posts 0, so the summary is one pass in two.
    await until(async () => (await summary()).count === 2n, { what: "the failure's feedback" });
    expect(await summary()).toEqual({ count: 2n, value: 50n, decimals: 0 });
  });

  it("scenario 4, damper: one buyer's fourth outcome on one profile finalizes with weight 0 and counts nowhere", async () => {
    const c = await buyer(2_000_000n);
    const signer = inProcessSigner(c.key, roles.provider.address, tmp);
    const ids: Hex32[] = [];
    // The same wallet in four repositories: four purchases, four passing receipts, one after another.
    for (let i = 0; i < 4; i++) {
      const bridge = await bridgeFor(c.key, "pass", undefined, signer);
      const id = await purchase(bridge);
      await warrantyIn(id, "active");
      await adopt(bridge, id, "passed");
      await warrantyIn(id, "passed");
      ids.push(id);
    }
    const weights = await Promise.all(ids.map(async (id) => (await finalization(id)).weightBps));
    expect(weights).toEqual([10_000, 10_000, 10_000, 0]);
    expect(logger.lines.some((l) => l.includes('"event":"warranty.outcome_queued"') && l.includes(ids[3]!) && l.includes('"code":"DAMPED"'))).toBe(true);
    // The registry sent the engine only the three weighted outcomes.
    expect(await engineCalls()).toBe(5);

    // The catalog: five outcomes from three distinct buyers (so the count is published), folded as the engine holds them;
    // the damped fourth is not among them.
    const { generatedAt, profile } = await until(
      async () => {
        const p = await catalogProfile();
        return p.profile.compatibility?.outcomes === 5 && p;
      },
      { what: "the catalog to count five outcomes" },
    );
    const finalizations = await new PgStore(db).listRegistryEvents({ names: ["OutcomeFinalized"] }, 32);
    const counted = finalizations.filter((row) => (row.weightBps ?? 0) > 0).map((row) => ({ passed: row.verdict === VERDICT_PASSED, weightBps: row.weightBps as number, at: unixSeconds(row.blockTime) }));
    expect(finalizations).toHaveLength(6);
    expect(counted).toHaveLength(5);
    const expected = fold(priorFromEvidence(catalog.evidence), counted, unixSeconds(new Date(generatedAt)));
    expect(profile.compatibility).toEqual({ confidenceBps: expected.confidenceBps, effectiveNMilli: expected.effectiveNMilli.toString(), outcomes: 5, source: "benchmark+outcomes", buyers: 3 });

    // ERC-8004: feedback for the three weighted outcomes only.
    await until(async () => (await summary()).count === 5n, { what: "feedback for the weighted outcomes" });
    // The attester records each post after it is mined, so its ledger may trail the chain for a moment.
    await until(async () => (await Promise.all(ids.slice(0, 3).map(view))).every((v) => /^0x[0-9a-f]{64}$/.test(v.warranty?.feedback ?? "")), { what: "the attester to record its posts" });
    // The feed never offers the damped one to the attester: a few more runs later, its ledger has no post for it.
    await new Promise((r) => setTimeout(r, 1500));
    expect(await new PgStore(db).getReputationPost(ids[3]!, "provider")).toBeUndefined();
    expect((await view(ids[3]!)).warranty?.feedback).toBeNull();
    expect(await summary()).toEqual({ count: 5n, value: 80n, decimals: 0 });
    await server.reputation.summaries?.refresh(CAPABILITY);
    expect((await catalogProfile()).release.reputation).toEqual({ passBps: 8000, count: 5, buyers: 3 });
  });

  it("scenario 5, crash safety: an activator killed after its send and restarted never sends twice", async () => {
    const d = await buyer(1_000_000n);
    const bridge = await bridgeFor(d.key, "pass");
    const providerNonce = () => chain.publicClient.getTransactionCount({ address: roles.provider.address as Hex });
    const sentBefore = await providerNonce();
    crash.arm();
    const id = await purchase(bridge);
    // The activator broadcasts the activation; the server dies before the outbox learns its hash.
    await until(() => crash.dead(), { what: "the activator to send and the server to die" });
    await server.stop();
    expect(await providerNonce()).toBe(sentBefore + 1);
    const activations = async () => (await chain.publicClient.getContractEvents({ address: registry as Hex, abi: warrantyRegistryAbi, eventName: "ResolutionActivated", args: { resolutionId: id as Hex }, fromBlock: registryBlock })).length;
    expect(await activations()).toBe(1);
    const outbox = () => new PgStore(db).getWarrantyAction(id, "activate");
    expect(await outbox()).toMatchObject({ state: "sent", attempts: 1, txHash: null });

    // A new server process over the same database, with fresh chain clients.
    server = await startServer({ env: serverEnv(), catalogRoot: catalog.root, db, clock, logger, port });
    // While the dead attempt's lease holds, the restarted activator leaves it alone.
    await new Promise((r) => setTimeout(r, 2000));
    expect(await outbox()).toMatchObject({ state: "sent", attempts: 1 });
    expect(await providerNonce()).toBe(sentBefore + 1);
    // After the lease, it reads the provider's nonces and the registry, finds the warranty active, and closes the action.
    clockOffsetMs = ATTEMPT_LEASE_MS + 60_000;
    await until(async () => (await outbox())?.state === "done", { what: "the restarted activator to close the action" });
    expect(await providerNonce()).toBe(sentBefore + 1);
    expect(await activations()).toBe(1);
    // The dead server's activation is the warranty's, and the purchase goes on as any other.
    const active = await warrantyIn(id, "active");
    expect(toAddress((await chain.publicClient.getTransaction({ hash: active.warranty?.activation as Hex })).from)).toBe(roles.provider.address);
    await adopt(bridge, id, "passed");
    await warrantyIn(id, "passed");
    expect(await engineCalls()).toBe(6);
  });

  it("scenario 6, the shipped programs: lemma-signer and lemma-mcp, run as a buyer runs them, buy and adopt over stdio", async () => {
    // The buyer's setup from the bridge's README: lemma-signer init makes the key file, and the address it prints is funded.
    const signerState = mkdtempSync(join(tmp, "signer-state-"));
    const key = await initSignerKey(signerState);
    outputs.push(key.output);
    secrets.push(readKeyFile(key.keyFile));
    hidden.push(key.address);
    await usdc.mint(key.address, 1_000_000n);
    const signer = await startSignerProcess({ stateDir: signerState, provider: roles.provider.address });
    const agent = await startAgentProcess({
      apiUrl: server.url,
      workspace: writeWorkspace(mkdtempSync(join(tmp, "workspace-")), "pass"),
      stateDir: mkdtempSync(join(tmp, "state-")),
      signerSocket: signer.socket,
      provider: roles.provider.address,
    });
    try {
      expect(await agent.tools()).toEqual(expect.arrayContaining(["lemma_preview", "lemma_buy_resolution", "lemma_apply_resolution", "lemma_verify_adoption", "lemma_claim_refund"]));
      const id = await purchase(agent);
      await warrantyIn(id, "active");
      await adopt(agent, id, "passed");
      await warrantyIn(id, "passed");
      expect(await engineCalls()).toBe(7);
      // The buyer paid the price in USDC and no gas; its key stayed in the signer's key file.
      expect(await usdc.balanceOf(key.address)).toBe(1_000_000n - PRICE);
      expect(await chain.publicClient.getBalance({ address: key.address as Hex })).toBe(0n);
    } finally {
      await agent.close();
      await signer.stop();
      outputs.push(agent.stderr(), signer.output());
    }
  });

  it("scenario 3, expiry: a warranty without a receipt expires once the chain passes its claim deadline", async () => {
    const e = await buyer(1_000_000n);
    const bridge = await bridgeFor(e.key, "pass");
    const id = await purchase(bridge);
    const active = await warrantyIn(id, "active");
    const deadline = Date.parse(active.warranty?.claimDeadline as string) / 1000;
    const reserved = (await release()).reserved;
    expect(reserved).toBe(PRICE);
    // No receipt comes. The chain's clock passes the one-hour claim window (and the expirer's minute of margin).
    const chainNow = Number(await chain.now());
    await chain.test.increaseTime({ seconds: deadline - chainNow + 120 });
    await chain.test.mine({ blocks: 1 });
    const expired = await warrantyIn(id, "expired");
    expect(expired.receipt).toBeNull();
    const expiryTx = await chain.publicClient.getTransaction({ hash: expired.warranty?.expiry as Hex });
    expect(toAddress(expiryTx.from)).toBe(roles.provider.address);
    expect((await release()).reserved).toBe(0n);
    // Nothing was recorded or posted for it.
    expect(await engineCalls()).toBe(7);
    expect(expired.warranty?.feedback).toBeNull();
  });

  it("never logs or prints a key or a claim secret, and never logs a buyer or refund address", () => {
    // In any letter case: a checksummed address or upper-case hex is the same value.
    const logs = logger.lines.join("\n").toLowerCase();
    const printed = outputs.join("\n").toLowerCase();
    expect(logger.lines.length).toBeGreaterThan(20);
    expect(secrets.length).toBeGreaterThan(ROLES.length);
    for (const secret of secrets) {
      expect(logs).not.toContain(secret.slice(2).toLowerCase());
      expect(printed).not.toContain(secret.slice(2).toLowerCase());
    }
    for (const address of hidden) expect(logs).not.toContain(address.slice(2).toLowerCase());
  });
});
