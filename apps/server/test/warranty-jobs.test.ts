import { type Hex32, WarrantyOutcome, WarrantyVoucher, adoptionReceiptDigest, warrantyClaimHash } from "@lemma/core";
import { describe, expect, it, vi } from "vitest";

import {
  ATTEMPT_LEASE_MS,
  BOND_RETRY_MS,
  CreditRelay,
  DAMPER_WINDOW_MS,
  type LemmaStore,
  type RegistryCall,
  type RegistryStatus,
  type WarrantyChain,
  WarrantyActivator,
  WarrantyEvaluator,
  WarrantyExpirer,
  decideReview,
  listReview,
  requestWithdrawal,
} from "../src/index.js";
import { type FakeRegistry, registryError } from "./fake-registry.js";
import { BUYER } from "./helpers.js";
import { type Bought, idOf, warrantyWorld } from "./warranty-helpers.js";

const OTHER_BUYER = "0x00000000000000000000000000000000000000c1";
const HOUR = 3600;
const DAY = 24 * HOUR;
/** The fake registry's claim window: 72 hours. */
const WINDOW = 72 * HOUR;

type World = Awaited<ReturnType<typeof warrantyWorld>>;

/** A chain whose next send is refused with this registry error, as a simulation would refuse it. */
function refusing(chain: FakeRegistry, errorName: string, args: readonly unknown[] = []): WarrantyChain {
  let armed = true;
  return new Proxy(chain, {
    get(target, property, receiver) {
      if (property === "send") {
        return async (call: RegistryCall, options: Parameters<WarrantyChain["send"]>[1]) => {
          if (armed) {
            armed = false;
            throw registryError(call.fn, errorName, args);
          }
          return target.send(call, options);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Answers the next resolution read as a node behind the indexed events would:
 * a lagging backend of a load-balanced endpoint answers `getBlockNumber` with
 * an old block, and reads the registry there.
 */
function behind(chain: FakeRegistry, status: RegistryStatus): void {
  const read = chain.resolution.bind(chain);
  vi.spyOn(chain, "resolution").mockImplementationOnce(async (id) => ({ ...(await read(id)), status }));
}

/** The one line the outbox logs when an attempt failed on the chain's side, here a stale read. */
const staleReadLogged = (w: World, kind: string) => w.logger.lines.some((l) => l.event === "warranty.attempt_failed" && l.fields["kind"] === kind && l.fields["error"] === "StaleReadError STALE_READ");

const common = (w: World, over: { chain?: WarrantyChain; store?: LemmaStore } = {}) => ({ store: over.store ?? w.store, chain: over.chain ?? w.chain, clock: () => w.clock.now, logger: w.logger, jitter: () => 0 });

/** Nothing a log line carries may name the payer, a claim secret or a refund address. */
function expectNothingSecretLogged(w: World, bought: readonly Bought[]): void {
  const text = JSON.stringify(w.logger.lines);
  for (const b of bought) {
    expect(text).not.toContain(b.payer.slice(2));
    expect(text).not.toContain(b.secret.slice(2));
    expect(text).not.toContain(b.refundTo.slice(2));
  }
}

describe("the activator", () => {
  it("activates each settled resolution with its price, its claim and a random payment reference, as the provider", async () => {
    const w = await warrantyWorld();
    // One transaction settled both: each resolution still activates, with its own reference.
    const shared = idOf("one multicall settled both");
    const [a, b] = [await w.buy(BUYER, shared), await w.buy(OTHER_BUYER, shared)];
    expect(await w.jobs.activator.runOnce()).toMatchObject({ queued: 2, sent: 2, done: 2 });
    const refs = new Set<Hex32>();
    for (const bought of [a!, b!]) {
      const onChain = w.chain.resolutions.get(bought.id);
      expect(onChain).toMatchObject({ status: "active", amount: 250_000n, profileIndex: 0, releaseDigest: w.entry.releaseDigest, claimHash: warrantyClaimHash(bought.id, bought.secret, bought.refundTo) });
      const action = await w.store.getWarrantyAction(bought.id, "activate");
      expect(action).toMatchObject({ state: "done", attempts: 1, lastCode: null });
      expect(action?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
      const voucher = WarrantyVoucher.parse(action?.payload);
      expect(voucher.activateBy).toBe(Number(w.chain.now) + 900);
      // Opaque: not the resolution, the payer, the nonce or the settlement.
      for (const known of [bought.id, bought.previewId, shared, idOf("nonce 1"), idOf("nonce 2")]) expect(voucher.paymentRef).not.toBe(known);
      refs.add(voucher.paymentRef);
    }
    expect(refs.size).toBe(2);
    expect(w.chain.sent.map((s) => [s.sender, s.call.fn])).toEqual([
      ["provider", "activateResolution"],
      ["provider", "activateResolution"],
    ]);
    // Nothing left to do: a second run sends nothing.
    expect(await w.jobs.activator.runOnce()).toMatchObject({ queued: 0, sent: 0 });
    expectNothingSecretLogged(w, [a!, b!]);
  });

  it("waits a random delay of up to the jitter before each activation", async () => {
    const w = await warrantyWorld();
    await w.buy();
    const jitter = vi.fn((max: number) => (max === 300 ? 120 : 0));
    const activator = new WarrantyActivator({ ...common(w), jitter, jitterSeconds: 300 });
    expect(await activator.runOnce()).toMatchObject({ queued: 1, sent: 0 });
    expect(jitter).toHaveBeenCalledWith(300);
    w.advance(119);
    expect(await activator.runOnce()).toMatchObject({ sent: 0 });
    w.advance(1);
    expect(await activator.runOnce()).toMatchObject({ sent: 1, done: 1 });
  });

  it("never signs for a release that is not registered, deactivated, or registered with other roles", async () => {
    for (const [setup, code] of [
      [(w: World) => w.chain.releases.delete(w.entry.releaseDigest), "RELEASE_NOT_REGISTERED"],
      [(w: World) => (w.chain.releases.get(w.entry.releaseDigest)!.active = false), "RELEASE_INACTIVE"],
      [(w: World) => w.chain.registerRelease(w.entry.releaseDigest, { evaluator: "0x00000000000000000000000000000000000000e7" }), "RELEASE_ROLES_MISMATCH"],
      [(w: World) => w.chain.registerRelease(w.entry.releaseDigest, { provider: "0x00000000000000000000000000000000000000e8" }), "RELEASE_ROLES_MISMATCH"],
    ] as const) {
      const w = await warrantyWorld();
      setup(w);
      const b = await w.buy();
      const sign = vi.spyOn(w.chain, "signVoucher");
      expect(await w.jobs.activator.runOnce()).toMatchObject({ queued: 1, skipped: 1, sent: 0 });
      expect(sign).not.toHaveBeenCalled();
      expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "skipped", lastCode: code, attempts: 0 });
      expect(w.logger.events()).toContain("warranty.release_refused");
    }
  });

  it("backs off while the bond is short, activates once it is topped up, and gives up loudly after a day", async () => {
    const w = await warrantyWorld({ bond: 0n });
    const b = await w.buy();
    expect(await w.jobs.activator.runOnce()).toMatchObject({ queued: 1, sent: 0, waiting: 1 });
    const waiting = await w.store.getWarrantyAction(b.id, "activate");
    expect(waiting).toMatchObject({ state: "queued", attempts: 0, lastCode: "INSUFFICIENT_AVAILABLE_BOND" });
    expect(waiting?.nextAttemptAt).toEqual(new Date(w.clock.now.getTime() + 30_000));
    w.chain.depositBond(w.entry.releaseDigest, 250_000n);
    w.advance(30);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ done: 1 });

    // Two in one run on a bond for one: the second meets the registry's own refusal and backs off.
    const [c, d] = [await w.buy(), await w.buy()];
    w.chain.depositBond(w.entry.releaseDigest, 250_000n);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ queued: 2, done: 1, waiting: 1 });
    const refused = (await w.store.getWarrantyAction(c!.id, "activate"))?.state === "done" ? d! : c!;
    expect(await w.store.getWarrantyAction(refused.id, "activate")).toMatchObject({ state: "sent", attempts: 1, lastCode: "INSUFFICIENT_AVAILABLE_BOND" });
    // A day after it was written, still short: abandoned, with an alert.
    w.advance(BOND_RETRY_MS / 1000);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ abandoned: 1 });
    expect(await w.store.getWarrantyAction(refused.id, "activate")).toMatchObject({ state: "abandoned", lastCode: "BOND_EXHAUSTED" });
    expect(w.logger.lines.find((l) => l.event === "warranty.bond_exhausted")).toMatchObject({ level: "error", fields: { resolutionId: refused.id, code: "BOND_EXHAUSTED" } });
  });

  it("signs a voucher again, with the same payment reference, once its deadline has passed", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.failSends = 1;
    expect(await w.jobs.activator.runOnce()).toMatchObject({ failed: 1, sent: 0 });
    const first = await w.store.getWarrantyAction(b.id, "activate");
    expect(first).toMatchObject({ state: "sent", attempts: 1, txHash: null, lastCode: "ECONNRESET" });
    const firstVoucher = WarrantyVoucher.parse(first?.payload);
    expect(first?.signature).not.toBeNull();
    w.advance(1000);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ done: 1, sent: 1 });
    const [sent] = w.chain.sentOf("activateResolution") as Array<Extract<RegistryCall, { fn: "activateResolution" }>>;
    expect(sent?.voucher.paymentRef).toBe(firstVoucher.paymentRef);
    expect(sent?.voucher.activateBy).toBe(Number(w.chain.now) + 900);
    expect(sent?.voucher.activateBy).toBeGreaterThan(firstVoucher.activateBy);
    expect(w.chain.status(b.id)).toBe("active");
  });

  it("judges each action of a batch by the chain's clock when its attempt begins, not when the run began", async () => {
    const w = await warrantyWorld();
    const [first, second] = [await w.buy(), await w.buy(OTHER_BUYER)];
    // The first activation's receipt is slow: 1000 seconds pass on both clocks while the run waits for it.
    const waitForReceipt = w.chain.waitForReceipt.bind(w.chain);
    let slow = true;
    w.chain.waitForReceipt = async (txHash) => {
      if (slow) {
        slow = false;
        w.advance(1000);
      }
      return waitForReceipt(txHash);
    };
    // The second voucher is signed from the head read when its own attempt begins, so the registry takes it in the same run.
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 2, done: 2, waiting: 0 });
    for (const b of [first, second]) expect(w.chain.status(b.id)).toBe("active");
    const [, sent] = w.chain.sentOf("activateResolution") as Array<Extract<RegistryCall, { fn: "activateResolution" }>>;
    expect(sent?.voucher.activateBy).toBe(Number(w.chain.now) + 900);
  });

  it("never sends twice across a crash between the send and the outbox write", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    let crashed = false;
    const dying = Object.assign(Object.create(w.store) as LemmaStore, {
      updateWarrantyAction: async (...args: Parameters<LemmaStore["updateWarrantyAction"]>) => {
        if (w.chain.sent.length > 0) {
          crashed = true;
          throw new Error("process killed");
        }
        return w.store.updateWarrantyAction(...args);
      },
    });
    await new WarrantyActivator({ ...common(w, { store: dying }), jitterSeconds: 0 }).runOnce();
    expect(crashed).toBe(true);
    expect(w.chain.sent).toHaveLength(1);
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "sent", attempts: 1, txHash: null });
    // Nothing while the dead process's claim holds the action; after it, the registry shows the activation.
    w.advance(60);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 0, done: 0 });
    w.advance(ATTEMPT_LEASE_MS / 1000);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 0, done: 1 });
    expect(w.chain.sent).toHaveLength(1);
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "done", attempts: 1 });
  });

  it("waits for its own unmined transaction, and then takes its receipt instead of sending again", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.mineOnSend = false;
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 1, waiting: 1 });
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "sent", lastCode: "UNCONFIRMED" });
    w.advance(30);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 0, waiting: 1 });
    expect((await w.store.getWarrantyAction(b.id, "activate"))?.lastCode).toBe("PENDING_TX");
    await w.chain.mine();
    w.advance(15);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 0, done: 1 });
    expect(w.chain.sent).toHaveLength(1);
  });

  it("resends with the nonce read before its checks, so on a node without a mempool only one of two sends can land", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.mineOnSend = false;
    w.chain.pendingVisible = false;
    await w.jobs.activator.runOnce();
    w.advance(30);
    // The node shows nothing pending and nothing activated: the resend goes out with the first one's nonce.
    expect(await w.jobs.activator.runOnce()).toMatchObject({ sent: 1 });
    expect(w.chain.sent.map((s) => s.nonce)).toEqual([0, 0]);
    await w.chain.mine();
    expect(w.chain.status(b.id)).toBe("active");
    // The second attempt's retry: 60 s.
    w.advance(60);
    await w.jobs.activator.runOnce();
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "done" });
    expect(w.chain.logs.filter((l) => l.name === "ResolutionActivated")).toHaveLength(1);
  });

  it("backs off while the registry is paused and activates after", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.pause();
    expect(await w.jobs.activator.runOnce()).toMatchObject({ waiting: 1, sent: 0 });
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "sent", attempts: 1, lastCode: "ENFORCED_PAUSE" });
    w.chain.unpause();
    w.advance(30);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ done: 1 });
    expect(w.chain.status(b.id)).toBe("active");
  });

  it("closes an activation as done when the registry already has it, whoever sent it", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.failSends = 1;
    await w.jobs.activator.runOnce();
    // Someone relays the voucher the claim wrote down before the send failed.
    const action = await w.store.getWarrantyAction(b.id, "activate");
    await w.chain.relay({ fn: "activateResolution", voucher: WarrantyVoucher.parse(action?.payload), signature: action?.signature as `0x${string}` });
    w.advance(30);
    expect(await w.jobs.activator.runOnce()).toMatchObject({ done: 1, sent: 0 });
    expect(w.chain.sent).toHaveLength(0);
  });
});

describe("the evaluator", () => {
  it("finalizes a verified pass as PASSED, with the receipt's digest as evidence, as the evaluator", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    const receipt = await w.receipt(b, "passed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 1, review: 0, sent: 1, done: 1 });
    const outcome = WarrantyOutcome.parse((await w.store.getWarrantyAction(b.id, "finalize"))?.payload);
    expect(outcome).toEqual({
      schemaVersion: "1",
      resolutionId: b.id,
      verdict: "passed",
      weightBps: 10_000,
      evidenceHash: adoptionReceiptDigest(receipt),
      validUntil: Number(w.chain.now) + 3600,
    });
    expect(w.chain.sent.at(-1)).toMatchObject({ sender: "evaluator", call: { fn: "finalizeOutcome" } });
    expect(w.chain.status(b.id)).toBe("passed");
    await w.jobs.indexer.runOnce();
    expect(await w.store.listRegistryEvents({ resolutionId: b.id, names: ["OutcomeFinalized"] }, 5)).toMatchObject([{ verdict: 1, weightBps: 10_000, evidenceHash: adoptionReceiptDigest(receipt) }]);
    expectNothingSecretLogged(w, [b]);
  });

  it("finalizes an abandoned run as VOID with no weight, and a failure as FAILED when failures are automatic", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const [abandoned, failed] = [await w.activeWarranty(), await w.activeWarranty(OTHER_BUYER)];
    await w.receipt(abandoned!, "abandoned");
    await w.receipt(failed!, "failed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 2, review: 0, done: 2 });
    expect(WarrantyOutcome.parse((await w.store.getWarrantyAction(abandoned!.id, "finalize"))?.payload)).toMatchObject({ verdict: "void", weightBps: 0 });
    expect(WarrantyOutcome.parse((await w.store.getWarrantyAction(failed!.id, "finalize"))?.payload)).toMatchObject({ verdict: "failed", weightBps: 10_000 });
    expect([w.chain.status(abandoned!.id), w.chain.status(failed!.id)]).toEqual(["voided", "failed"]);
  });

  it("holds a failure for an operator's decision, and finalizes what the operator decides", async () => {
    const w = await warrantyWorld();
    const [first, second] = [await w.activeWarranty(), await w.activeWarranty(OTHER_BUYER)];
    await w.receipt(first!, "failed");
    await w.receipt(second!, "failed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 2, review: 2, sent: 0 });
    w.advance(2 * HOUR);
    const listed = await listReview(w.store, w.clock.now);
    expect(listed.map((i) => [i.resolutionId, i.release, i.profileIndex, i.receiptOutcome, i.exitCode, i.ageSeconds])).toEqual([
      [first!.id, "gating@1.0.0+bench-1", 0, "failed", 1, 2 * HOUR],
      [second!.id, "gating@1.0.0+bench-1", 0, "failed", 1, 2 * HOUR],
    ]);
    expect(JSON.stringify(listed)).not.toContain(BUYER.slice(2));
    expect(await decideReview(w.store, first!.id, "failed", w.clock.now)).toBe("QUEUED");
    expect(await decideReview(w.store, second!.id, "void", w.clock.now)).toBe("QUEUED");
    expect(await decideReview(w.store, first!.id, "void", w.clock.now)).toBe("NOT_IN_REVIEW");
    expect(await decideReview(w.store, idOf("nobody"), "void", w.clock.now)).toBe("UNKNOWN_RESOLUTION");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ done: 2 });
    expect([w.chain.status(first!.id), w.chain.status(second!.id)]).toEqual(["failed", "voided"]);
    expect(WarrantyOutcome.parse((await w.store.getWarrantyAction(second!.id, "finalize"))?.payload)).toMatchObject({ verdict: "void", weightBps: 0 });
  });

  it("lists each failure in review with its claim deadline in force, and alerts once, at error level, six hours before it", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    await w.receipt(b, "failed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ review: 1 });
    // An hour's pause moves the deadline an hour later, on the chain and in the list.
    const set = (await w.chain.resolution(b.id)).claimDeadline;
    w.chain.pause();
    w.advance(HOUR);
    w.chain.unpause();
    await w.jobs.indexer.runOnce();
    const deadline = (await w.chain.resolution(b.id)).claimDeadline;
    expect(deadline).toBe(set + BigInt(HOUR));
    expect((await listReview(w.store, w.clock.now)).map((i) => i.claimDeadline)).toEqual([new Date(Number(deadline) * 1000)]);
    const alerts = () => w.logger.lines.filter((l) => l.event === "warranty.review_deadline");
    // Seven hours before it, nothing; five hours before it, one alert, and only one.
    w.advance(WINDOW - 7 * HOUR);
    await w.jobs.evaluator.runOnce();
    expect(alerts()).toEqual([]);
    w.advance(2 * HOUR);
    await w.jobs.evaluator.runOnce();
    await w.jobs.evaluator.runOnce();
    expect(alerts()).toEqual([{ level: "error", event: "warranty.review_deadline", fields: { resolutionId: b.id, claimDeadline: new Date(Number(deadline) * 1000).toISOString(), secondsLeft: 5 * HOUR } }]);
    expectNothingSecretLogged(w, [b]);
  });

  it("never finalizes on an unverified or missing receipt: the warranty runs to its expiry", async () => {
    const w = await warrantyWorld();
    const [unverified, silent] = [await w.activeWarranty(), await w.activeWarranty(OTHER_BUYER)];
    await w.receipt(unverified!, "passed", false);
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 0, sent: 0 });
    w.advance(WINDOW + 1);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 2, done: 2 });
    expect([w.chain.status(unverified!.id), w.chain.status(silent!.id)]).toEqual(["expired", "expired"]);
    expect(w.chain.sentOf("finalizeOutcome")).toHaveLength(0);
  });

  it("weighs a buyer's fourth outcome on one release and profile in 30 days at zero, and not one 31 days old", async () => {
    const w = await warrantyWorld();
    const old = await w.activeWarranty();
    await w.receipt(old, "passed");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    w.advance(31 * DAY);
    const recent: Bought[] = [];
    for (let i = 0; i < 4; i++) recent.push(await w.buy());
    const theirs = await w.buy(OTHER_BUYER);
    await w.jobs.activator.runOnce();
    await w.jobs.indexer.runOnce();
    for (const b of [...recent, theirs]) await w.receipt(b, "passed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 5, done: 5 });
    const weight = async (b: Bought) => WarrantyOutcome.parse((await w.store.getWarrantyAction(b.id, "finalize"))?.payload).weightBps;
    // The 31-day-old outcome is not counted: three weighed in full, the fourth at zero; another buyer is not affected.
    expect(await Promise.all(recent.map(weight))).toEqual([10_000, 10_000, 10_000, 0]);
    expect(await weight(theirs)).toBe(10_000);
    expect(w.logger.lines.find((l) => l.event === "warranty.outcome_queued" && l.fields["resolutionId"] === recent[3]!.id)?.fields).toMatchObject({ weightBps: 0, code: "DAMPED" });
    // The damped outcome still finalizes: the registry records it with no weight (not into the engine).
    expect(w.chain.status(recent[3]!.id)).toBe("passed");
  });

  it("counts toward the damper an outcome exactly 30 days old, and not one a second older", async () => {
    /** The weight of a buyer's fourth outcome, `age` seconds after its first three finalized. */
    const fourthWeight = async (age: number) => {
      const w = await warrantyWorld();
      const earlier: Bought[] = [];
      for (let i = 0; i < 3; i++) earlier.push(await w.buy());
      await w.jobs.activator.runOnce();
      await w.jobs.indexer.runOnce();
      for (const b of earlier) await w.receipt(b, "passed");
      expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 3, done: 3 });
      await w.jobs.indexer.runOnce();
      w.advance(age);
      const fourth = await w.activeWarranty();
      await w.receipt(fourth, "passed");
      await w.jobs.evaluator.runOnce();
      return WarrantyOutcome.parse((await w.store.getWarrantyAction(fourth.id, "finalize"))?.payload).weightBps;
    };
    expect(DAMPER_WINDOW_MS).toBe(30 * DAY * 1000);
    expect(await fourthWeight(DAMPER_WINDOW_MS / 1000)).toBe(0);
    expect(await fourthWeight(DAMPER_WINDOW_MS / 1000 + 1)).toBe(10_000);
  });

  it("finalizes within a claim window a pause extended, and abandons one whose window closed", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    w.advance(WINDOW - HOUR);
    w.chain.pause();
    w.advance(5 * HOUR);
    w.chain.unpause();
    // Four hours past the deadline set at activation, an hour inside the one in force.
    await w.receipt(b, "passed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ done: 1 });
    expect(WarrantyOutcome.parse((await w.store.getWarrantyAction(b.id, "finalize"))?.payload).validUntil).toBe(Number(w.chain.resolutions.get(b.id)!.claimDeadline) + 5 * HOUR);

    const late = await w.activeWarranty(OTHER_BUYER);
    w.advance(WINDOW + 1);
    await w.receipt(late, "passed");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 1, abandoned: 1, sent: 0 });
    expect(await w.store.getWarrantyAction(late.id, "finalize")).toMatchObject({ state: "abandoned", lastCode: "CLAIM_WINDOW_CLOSED" });
  });

  it("closes a finalization someone relayed with its signature as done, without sending again", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    await w.receipt(b, "passed");
    w.chain.failSends = 1;
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ failed: 1 });
    const action = await w.store.getWarrantyAction(b.id, "finalize");
    await w.chain.relay({ fn: "finalizeOutcome", outcome: WarrantyOutcome.parse(action?.payload), signature: action?.signature as `0x${string}` });
    w.advance(30);
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ done: 1, sent: 0 });
    expect(w.chain.sentOf("finalizeOutcome")).toHaveLength(0);
  });

  it("retries a finalization, never abandons it, when a node behind the indexed activation answers none", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    await w.receipt(b, "passed");
    behind(w.chain, "none");
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ queued: 1, failed: 1, abandoned: 0, sent: 0 });
    expect(await w.store.getWarrantyAction(b.id, "finalize")).toMatchObject({ state: "queued", lastCode: "STALE_READ" });
    expect(staleReadLogged(w, "finalize")).toBe(true);
    w.advance(30);
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ sent: 1, done: 1 });
    expect(w.chain.status(b.id)).toBe("passed");
  });

  it("closes a failure still in review once its warranty ended", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    await w.receipt(b, "failed");
    await w.jobs.evaluator.runOnce();
    w.advance(WINDOW + 1);
    await w.jobs.expirer.runOnce();
    await w.jobs.indexer.runOnce();
    expect(await w.jobs.evaluator.runOnce()).toMatchObject({ closed: 1 });
    expect(await w.store.getWarrantyAction(b.id, "finalize")).toMatchObject({ state: "abandoned", lastCode: "WARRANTY_ENDED" });
    expect(await listReview(w.store, w.clock.now)).toEqual([]);
  });
});

describe("the expirer", () => {
  it("expires a warranty once its claim window closed on the chain's clock, as the provider", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    w.advance(WINDOW - 10);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 0 });
    w.advance(11);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 1, sent: 1, done: 1 });
    expect(w.chain.status(b.id)).toBe("expired");
    expect(w.chain.sent.at(-1)).toMatchObject({ sender: "provider", call: { fn: "expireResolution", resolutionId: b.id } });
    await w.jobs.indexer.runOnce();
    expect(await w.store.listRegistryEvents({ resolutionId: b.id, names: ["ResolutionExpired"] }, 5)).toHaveLength(1);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 0, sent: 0 });
  });

  it("waits for a deadline a pause moved, and for a finalization on its way", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    w.advance(HOUR);
    w.chain.pause();
    w.advance(HOUR);
    w.chain.unpause();
    // Past the deadline set at activation, an hour before the one in force.
    w.advance(WINDOW - 2 * HOUR + 60);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 1, sent: 0, waiting: 1 });
    const waiting = await w.store.getWarrantyAction(b.id, "expire");
    expect(waiting).toMatchObject({ state: "queued", lastCode: "CLAIM_WINDOW_OPEN" });
    expect(waiting?.nextAttemptAt).toEqual(new Date(w.clock.now.getTime() + (HOUR - 60 + 60) * 1000));

    // A finalization queued meanwhile holds the expiry back.
    const other = await w.activeWarranty(OTHER_BUYER);
    w.advance(WINDOW + 1);
    await w.store.insertWarrantyAction({ resolutionId: other.id, kind: "expire", payload: { schemaVersion: "1", resolutionId: other.id }, signature: null, state: "queued", nextAttemptAt: w.clock.now }, w.clock.now);
    await w.store.insertWarrantyAction(
      { resolutionId: other.id, kind: "finalize", payload: { schemaVersion: "1", resolutionId: other.id, verdict: "passed", weightBps: 10_000, evidenceHash: idOf("e"), validUntil: 1 }, signature: null, state: "queued", nextAttemptAt: new Date(w.clock.now.getTime() + DAY * 1000) },
      w.clock.now,
    );
    await w.jobs.expirer.runOnce();
    expect(await w.store.getWarrantyAction(other.id, "expire")).toMatchObject({ state: "queued", lastCode: "FINALIZATION_PENDING" });
    expect(w.chain.status(b.id)).toBe("expired");
    expect(w.chain.status(other.id)).toBe("active");
  });

  it("closes an expiry someone else sent as done, and one a finalization beat as skipped", async () => {
    const w = await warrantyWorld();
    const [relayed, finalized] = [await w.activeWarranty(), await w.activeWarranty(OTHER_BUYER)];
    w.advance(WINDOW + 1);
    await w.chain.relay({ fn: "expireResolution", resolutionId: relayed!.id });
    // Finalized just before the window closed (per the fake, finalize ignores it here: it is relayed directly).
    w.chain.resolutions.get(finalized!.id)!.status = "passed";
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 2, done: 1, skipped: 1, sent: 0 });
    expect(await w.store.getWarrantyAction(finalized!.id, "expire")).toMatchObject({ state: "skipped", lastCode: "RESOLUTION_NOT_ACTIVE" });
    expect(w.chain.sentOf("expireResolution")).toHaveLength(0);
  });

  it("retries an expiry, never skips it, when a node behind the indexed activation answers none", async () => {
    const w = await warrantyWorld();
    const b = await w.activeWarranty();
    w.advance(WINDOW + 1);
    behind(w.chain, "none");
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ queued: 1, failed: 1, skipped: 0, sent: 0 });
    expect(await w.store.getWarrantyAction(b.id, "expire")).toMatchObject({ state: "queued", lastCode: "STALE_READ" });
    expect(staleReadLogged(w, "expire")).toBe(true);
    w.advance(30);
    expect(await w.jobs.expirer.runOnce()).toMatchObject({ sent: 1, done: 1 });
    expect(w.chain.status(b.id)).toBe("expired");
  });
});

describe("the credit relay", () => {
  async function failedWarranty(w: World, payer = BUYER) {
    const b = await w.activeWarranty(payer);
    await w.receipt(b, "failed");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    return b;
  }

  it("queues a withdrawal the claim unlocks, pays the refund address as the evaluator, and forgets the claim", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const b = await failedWarranty(w);
    const request = { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo };
    const deps = { store: w.store, clock: () => w.clock.now, logger: w.logger };
    expect(await requestWithdrawal(deps, request)).toEqual({ status: 202, body: { resolutionId: b.id, state: "queued" } });
    expect(await requestWithdrawal(deps, request)).toEqual({ status: 202, body: { resolutionId: b.id, state: "queued" } });
    expect(await w.jobs.relay.runOnce()).toMatchObject({ sent: 1, done: 1 });
    expect(w.chain.paid.get(b.refundTo)).toBe(250_000n);
    expect(w.chain.sent.at(-1)).toMatchObject({ sender: "evaluator", call: { fn: "withdrawCredit", resolutionId: b.id, to: b.refundTo } });
    const action = await w.store.getWarrantyAction(b.id, "withdraw");
    expect(action).toMatchObject({ state: "done", payload: { schemaVersion: "1", resolutionId: b.id } });
    expect(JSON.stringify(action)).not.toContain(b.secret.slice(2));
    // The same request answers the same action, now done, even though the credit is gone.
    await w.jobs.indexer.runOnce();
    expect(await requestWithdrawal(deps, request)).toEqual({ status: 202, body: { resolutionId: b.id, state: "done" } });
    expectNothingSecretLogged(w, [b]);
  });

  it("refuses what the claim does not unlock, and queues nothing", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const b = await failedWarranty(w);
    const passed = await w.activeWarranty(OTHER_BUYER);
    await w.receipt(passed, "passed");
    await w.jobs.evaluator.runOnce();
    await w.jobs.indexer.runOnce();
    const deps = { store: w.store, clock: () => w.clock.now, logger: w.logger };
    const ask = (body: unknown) => requestWithdrawal(deps, body);
    expect(await ask({ resolutionId: b.id, claimSecret: b.secret })).toEqual({ status: 400, body: { error: "BAD_REQUEST" } });
    expect(await ask({ resolutionId: b.id, claimSecret: b.secret, to: b.refundTo, extra: 1 })).toEqual({ status: 400, body: { error: "BAD_REQUEST" } });
    expect(await ask({ resolutionId: idOf("nobody"), claimSecret: b.secret, to: b.refundTo })).toEqual({ status: 404, body: { error: "UNKNOWN_RESOLUTION" } });
    expect(await ask({ resolutionId: b.id, claimSecret: idOf("wrong secret"), to: b.refundTo })).toEqual({ status: 403, body: { error: "CLAIM_MISMATCH" } });
    expect(await ask({ resolutionId: b.id, claimSecret: b.secret, to: "0x00000000000000000000000000000000000000e5" })).toEqual({ status: 403, body: { error: "CLAIM_MISMATCH" } });
    expect(await ask({ resolutionId: passed.id, claimSecret: passed.secret, to: passed.refundTo })).toEqual({ status: 409, body: { error: "NO_CREDIT" } });
    expect(await w.store.listWarrantyActions({ kind: "withdraw" }, 10)).toEqual([]);
  });

  it("closes a withdrawal the buyer relayed first as done, without sending", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const b = await failedWarranty(w);
    await requestWithdrawal({ store: w.store, clock: () => w.clock.now, logger: w.logger }, { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo });
    await w.chain.relay({ fn: "withdrawCredit", resolutionId: b.id, claimSecret: b.secret, to: b.refundTo });
    expect(await w.jobs.relay.runOnce()).toMatchObject({ done: 1, sent: 0 });
    // Once indexed, a new request finds no credit: it was withdrawn.
    const other = await failedWarranty(w, OTHER_BUYER);
    await w.chain.relay({ fn: "withdrawCredit", resolutionId: other.id, claimSecret: other.secret, to: other.refundTo });
    await w.jobs.indexer.runOnce();
    expect(await requestWithdrawal({ store: w.store, clock: () => w.clock.now, logger: w.logger }, { resolutionId: other.id, claimSecret: other.secret, to: other.refundTo })).toEqual({ status: 409, body: { error: "NO_CREDIT" } });
  });

  it("retries a withdrawal, never abandons it, when a node behind the indexed FAILED outcome answers another status", async () => {
    const w = await warrantyWorld({ failures: "auto" });
    const b = await failedWarranty(w);
    await requestWithdrawal({ store: w.store, clock: () => w.clock.now, logger: w.logger }, { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo });
    for (const status of ["none", "active", "passed", "voided", "expired"] as const) {
      behind(w.chain, status);
      expect(await w.jobs.relay.runOnce(), status).toMatchObject({ failed: 1, abandoned: 0, sent: 0 });
      expect(await w.store.getWarrantyAction(b.id, "withdraw"), status).toMatchObject({ state: "queued", lastCode: "STALE_READ" });
      w.advance(30);
    }
    expect(staleReadLogged(w, "withdraw")).toBe(true);
    expect(await w.jobs.relay.runOnce()).toMatchObject({ sent: 1, done: 1 });
    expect(w.chain.paid.get(b.refundTo)).toBe(250_000n);
  });
});

describe("registry refusals", () => {
  /** Runs one attempt of `kind` against a chain that refuses the next send with `errorName`, then returns the action. */
  async function refused(kind: "activate" | "finalize" | "expire" | "withdraw", errorName: string, args: readonly unknown[] = [], setup: (w: World, b: Bought) => void | Promise<void> = () => {}) {
    const w = await warrantyWorld({ failures: "auto" });
    let b: Bought;
    if (kind === "activate") b = await w.buy();
    else {
      b = await w.activeWarranty();
      if (kind === "finalize") await w.receipt(b, "passed");
      if (kind === "expire") w.advance(WINDOW + 1);
      if (kind === "withdraw") {
        await w.receipt(b, "failed");
        await w.jobs.evaluator.runOnce();
        await w.jobs.indexer.runOnce();
        await requestWithdrawal({ store: w.store, clock: () => w.clock.now, logger: w.logger }, { resolutionId: b.id, claimSecret: b.secret, to: b.refundTo });
      }
    }
    await setup(w, b);
    const deps = { ...common(w, { chain: refusing(w.chain, errorName, args) }) };
    const job = { activate: new WarrantyActivator({ ...deps, jitterSeconds: 0 }), finalize: new WarrantyEvaluator({ ...deps, failures: "auto" }), expire: new WarrantyExpirer(deps), withdraw: new CreditRelay(deps) }[kind];
    await job.runOnce();
    return { w, b, action: await w.store.getWarrantyAction(b.id, kind) };
  }

  it("turns each activation refusal into what it means", async () => {
    expect((await refused("activate", "ResolutionAlreadyExists", [idOf("x")])).action).toMatchObject({ state: "done", lastCode: null });
    expect((await refused("activate", "VoucherExpired", [1n])).action).toMatchObject({ state: "sent", lastCode: "VOUCHER_EXPIRED" });
    expect((await refused("activate", "InsufficientAvailableBond", [0n, 250_000n])).action).toMatchObject({ state: "sent", lastCode: "INSUFFICIENT_AVAILABLE_BOND" });
    expect((await refused("activate", "UnknownRelease", [idOf("x")])).action).toMatchObject({ state: "skipped", lastCode: "RELEASE_NOT_REGISTERED" });
    expect((await refused("activate", "ReleaseNotActive", [idOf("x")])).action).toMatchObject({ state: "skipped", lastCode: "RELEASE_INACTIVE" });
    expect((await refused("activate", "InvalidProviderSignature")).action).toMatchObject({ state: "skipped", lastCode: "RELEASE_ROLES_MISMATCH" });
    expect((await refused("activate", "PaymentRefAlreadyUsed", [idOf("x")])).action).toMatchObject({ state: "abandoned", lastCode: "PAYMENT_REF_ALREADY_USED" });
    expect((await refused("activate", "EnforcedPause")).action).toMatchObject({ state: "sent", lastCode: "ENFORCED_PAUSE" });
    // An expired voucher is signed again at the next attempt.
    const { w, b } = await refused("activate", "VoucherExpired", [1n]);
    w.advance(60);
    await w.jobs.activator.runOnce();
    expect(w.chain.status(b.id)).toBe("active");
  });

  it("turns each finalization refusal into what it means", async () => {
    expect((await refused("finalize", "ClaimWindowClosed", [1n])).action).toMatchObject({ state: "abandoned", lastCode: "CLAIM_WINDOW_CLOSED" });
    expect((await refused("finalize", "ResolutionNotActive", [idOf("x")], (w, b) => void (w.chain.resolutions.get(b.id)!.status = "passed"))).action).toMatchObject({ state: "done" });
    expect((await refused("finalize", "OutcomeExpired", [1n])).action).toMatchObject({ state: "sent", lastCode: "OUTCOME_EXPIRED" });
    expect((await refused("finalize", "InvalidEvaluatorSignature")).action).toMatchObject({ state: "skipped", lastCode: "RELEASE_ROLES_MISMATCH" });
    expect((await refused("finalize", "InsufficientGasForEngine")).action).toMatchObject({ state: "sent", lastCode: "INSUFFICIENT_GAS_FOR_ENGINE" });
    expect((await refused("finalize", "EnforcedPause")).action).toMatchObject({ state: "sent", lastCode: "ENFORCED_PAUSE" });
    // An expired outcome is signed again at the next attempt.
    const { w, b } = await refused("finalize", "OutcomeExpired", [1n]);
    w.advance(60);
    await w.jobs.evaluator.runOnce();
    expect(w.chain.status(b.id)).toBe("passed");
  });

  it("turns each expiry and withdrawal refusal into what it means", async () => {
    const open = await refused("expire", "ClaimWindowOpen", [BigInt(Math.floor(Date.now() / 1000))], () => {});
    expect(open.action).toMatchObject({ state: "sent", lastCode: "CLAIM_WINDOW_OPEN" });
    expect((await refused("expire", "ResolutionNotActive", [idOf("x")], (w, b) => void (w.chain.resolutions.get(b.id)!.status = "expired"))).action).toMatchObject({ state: "done" });
    expect((await refused("expire", "EnforcedPause")).action).toMatchObject({ state: "sent", lastCode: "ENFORCED_PAUSE" });
    expect((await refused("withdraw", "NoCredit", [idOf("x")], (w, b) => void (w.chain.resolutions.get(b.id)!.status = "refunded"))).action).toMatchObject({ state: "done" });
    // Refused while the registry still shows the credit: nothing to withdraw after all. (A status a FAILED outcome rules out is a stale read, retried.)
    expect((await refused("withdraw", "NoCredit", [idOf("x")])).action).toMatchObject({ state: "abandoned", lastCode: "NO_CREDIT" });
    expect((await refused("withdraw", "InvalidClaim")).action).toMatchObject({ state: "abandoned", lastCode: "INVALID_CLAIM", payload: { schemaVersion: "1" } });
    expect((await refused("withdraw", "InvalidRecipient")).action).toMatchObject({ state: "abandoned", lastCode: "INVALID_RECIPIENT" });
  });

  it("backs off with jitter, doubling from 30 seconds up to an hour", async () => {
    const w = await warrantyWorld();
    const b = await w.buy();
    w.chain.down = true;
    const jitter = vi.fn((max: number) => max);
    const activator = new WarrantyActivator({ ...common(w), jitter, jitterSeconds: 0 });
    await activator.runOnce();
    // The chain is down: nothing is claimed, nothing sent; the loop never throws.
    expect(await w.store.getWarrantyAction(b.id, "activate")).toMatchObject({ state: "queued", attempts: 0 });
    w.chain.down = false;
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      w.chain.failSends = 1;
      const before = w.clock.now.getTime();
      await activator.runOnce();
      const next = (await w.store.getWarrantyAction(b.id, "activate"))!.nextAttemptAt.getTime();
      delays.push((next - before) / 1000);
      w.clock.now = new Date(next);
      w.chain.advance((next - before) / 1000);
    }
    // 30 s doubling, each with a fifth more (the jitter here gives its most), up to an hour and its fifth.
    expect(delays).toEqual([36, 72, 144, 288, 576, 1152, 2304, 4320, 4320]);
  });
});
