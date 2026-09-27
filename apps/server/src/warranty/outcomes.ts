import type { CatalogIndex } from "@lemma/catalog";
import type { Outcome } from "@lemma/confidence";
import { type Address, type CapabilityId, type Hex32, VERDICT_FAILED, VERDICT_PASSED, acceptanceRecipeDigest } from "@lemma/core";

import type { OutcomeSource } from "../compatibility.js";
import type { Logger } from "../log.js";
import { type EventPosition, type LemmaStore, type RegistryEventRow, compareEventPositions } from "../persistence.js";
import type { FedBuyers, FinalizedOutcome, OutcomeFeed, OutcomePage } from "../reputation/feed.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NONE: readonly Outcome[] = Object.freeze([]);

/** One indexed `OutcomeFinalized`, with its warranty's profile index (from its activation) and payer (from its resolution, if the server sold it). */
interface Finalization {
  readonly position: EventPosition;
  readonly txHash: Hex32;
  readonly resolutionId: Hex32;
  readonly releaseDigest: Hex32;
  readonly profileIndex: number;
  readonly verdict: number;
  readonly weightBps: number;
  readonly blockTime: Date;
}

const keyOf = (releaseDigest: Hex32, profileIndex: number) => `${releaseDigest}:${profileIndex}`;
const positionKey = (p: EventPosition) => `${p.blockNumber}:${p.logIndex}`;

/**
 * The indexed registry events the catalog, the attester and the warranty
 * view read, held in memory and refreshed after each indexer run: every
 * finalization with its warranty's profile index and payer, which engine was
 * set when, which records failed, and when the registry was paused.
 *
 * `refresh` reads only the rows stored since the last one, in chain order,
 * and applies them only once every lookup they need (the payers) succeeded,
 * so a failed refresh changes nothing and the next one reads the same rows
 * again. Refreshes run one at a time. Everything else answers from memory.
 */
export class RegistrySnapshot {
  private position: EventPosition | undefined;
  private readonly activations = new Map<Hex32, { readonly releaseDigest: Hex32; readonly profileIndex: number }>();
  private readonly finalizations: Finalization[] = [];
  /** `EngineRecordFailed`, by transaction and resolution. */
  private readonly recordFailures = new Set<string>();
  private readonly engineSets: Array<{ readonly position: EventPosition; readonly engine: Address }> = [];
  private readonly pauses: PauseEvent[] = [];
  private readonly payers = new Map<Hex32, Address | null>();
  /** Finalizations logged once as unusable (no indexed activation). */
  private readonly unkeyed = new Set<Hex32>();
  private queue: Promise<unknown> = Promise.resolve();

  // What the reads answer: rebuilt after each refresh that changed something.
  private recorded = new Map<string, readonly Outcome[]>();
  private recordedPayers = new Map<string, number>();
  private fed: readonly Finalization[] = [];
  private fedPayers = new Map<CapabilityId, number>();
  private current: Address | null = null;
  // The distinct-buyer counts the reads publish: the live ones as they stood at the start of the current period.
  private publishedPeriod: number | undefined;
  private publishedRecordedPayers = new Map<string, number>();
  private publishedFedPayers = new Map<CapabilityId, number>();

  constructor(
    private readonly deps: {
      readonly store: Pick<LemmaStore, "listRegistryEvents" | "getResolution">;
      /** The catalog: an outcome counts per capability only while its release is in it. */
      readonly index: CatalogIndex;
      readonly logger: Logger;
      /** Rows read per store query (default 1000). */
      readonly pageSize?: number;
      /**
       * How often the published distinct-buyer counts move, in milliseconds
       * (`BUYER_COUNTS_REFRESH_SECONDS`; 0, the default here, publishes them
       * live). The counts are taken at the first read in each period of this
       * length since the Unix epoch and held for the rest of it, so a new
       * outcome that leaves the count unchanged does not show that its buyer
       * bought before.
       */
      readonly buyersRefreshMs?: number;
      readonly clock?: () => Date;
    },
  ) {}

  /** Reads the rows stored since the last refresh; true when something changed. Throws when the store does (nothing is applied then). */
  refresh(): Promise<boolean> {
    const run = this.queue.then(() => this.read());
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<boolean> {
    const pageSize = this.deps.pageSize ?? 1000;
    const fresh: RegistryEventRow[] = [];
    let after = this.position;
    for (;;) {
      const page = await this.deps.store.listRegistryEvents({ after }, pageSize);
      fresh.push(...page);
      const last = page.at(-1);
      if (page.length < pageSize || last === undefined) break;
      after = last;
    }
    if (fresh.length === 0) return false;
    // Every lookup first: a failure leaves the snapshot as it was.
    const payers = new Map<Hex32, Address | null>();
    for (const e of fresh) {
      if (e.name !== "OutcomeFinalized" || e.resolutionId === null || this.payers.has(e.resolutionId) || payers.has(e.resolutionId)) continue;
      payers.set(e.resolutionId, (await this.deps.store.getResolution(e.resolutionId))?.payer ?? null);
    }
    for (const [id, payer] of payers) this.payers.set(id, payer);
    for (const e of fresh) this.apply(e);
    this.position = fresh.at(-1);
    this.rebuild();
    return true;
  }

  private apply(e: RegistryEventRow): void {
    const position = { blockNumber: e.blockNumber, logIndex: e.logIndex };
    switch (e.name) {
      case "ResolutionActivated":
        if (e.resolutionId !== null && e.releaseDigest !== null) this.activations.set(e.resolutionId, { releaseDigest: e.releaseDigest, profileIndex: e.profileIndex ?? 0 });
        return;
      case "OutcomeFinalized": {
        if (e.resolutionId === null || e.releaseDigest === null || e.verdict === null || e.weightBps === null) return;
        const activation = this.activations.get(e.resolutionId);
        if (activation === undefined) {
          // Activated before the indexer's start block: its profile is unknown, so it cannot be keyed.
          if (!this.unkeyed.has(e.resolutionId)) this.deps.logger.log("warn", "warranty.outcome_unkeyed", { resolutionId: e.resolutionId, code: "NO_ACTIVATION" });
          this.unkeyed.add(e.resolutionId);
          return;
        }
        this.finalizations.push({ position, txHash: e.txHash, resolutionId: e.resolutionId, releaseDigest: e.releaseDigest, profileIndex: activation.profileIndex, verdict: e.verdict, weightBps: e.weightBps, blockTime: e.blockTime });
        return;
      }
      case "EngineRecordFailed":
        if (e.resolutionId !== null) this.recordFailures.add(`${e.txHash}:${e.resolutionId}`);
        return;
      case "EngineSet":
        this.engineSets.push({ position, engine: e.engine ?? ZERO_ADDRESS });
        return;
      case "Paused":
      case "Unpaused":
        this.pauses.push({ position, paused: e.name === "Paused", time: BigInt(Math.floor(e.blockTime.getTime() / 1000)) });
        return;
      default:
        return;
    }
  }

  /** The engine in force at a position: the last `EngineSet` before it, or none. */
  private engineAt(position: EventPosition): Address {
    let engine: Address = ZERO_ADDRESS;
    for (const set of this.engineSets) {
      if (compareEventPositions(set.position, position) >= 0) break;
      engine = set.engine;
    }
    return engine;
  }

  private rebuild(): void {
    const last = this.engineSets.at(-1);
    this.current = last === undefined || last.engine === ZERO_ADDRESS ? null : last.engine;
    // The engine that holds the outcomes: the last one ever set (a later disable does not erase what it recorded).
    const holder = [...this.engineSets].reverse().find((s) => s.engine !== ZERO_ADDRESS)?.engine;
    const grouped = new Map<string, Finalization[]>();
    const fed: Finalization[] = [];
    for (const f of this.finalizations) {
      const counted = (f.verdict === VERDICT_PASSED || f.verdict === VERDICT_FAILED) && f.weightBps > 0;
      if (!counted) continue;
      fed.push(f);
      // Recorded by the engine: an engine was set, it is the one holding outcomes now, and its call did not fail.
      if (holder === undefined || this.engineAt(f.position) !== holder || this.recordFailures.has(`${f.txHash}:${f.resolutionId}`)) continue;
      const key = keyOf(f.releaseDigest, f.profileIndex);
      grouped.set(key, [...(grouped.get(key) ?? []), f]);
    }
    const recorded = new Map<string, readonly Outcome[]>();
    const recordedPayers = new Map<string, number>();
    for (const [key, list] of grouped) {
      const outcomes = list.map((f) => ({ passed: f.verdict === VERDICT_PASSED, weightBps: f.weightBps, at: BigInt(Math.floor(f.blockTime.getTime() / 1000)) }));
      const previous = this.recorded.get(key);
      // The same frozen array while nothing changed, so the catalog folds it once.
      const same = previous !== undefined && previous.length === outcomes.length && previous.every((p, i) => p.passed === outcomes[i]?.passed && p.weightBps === outcomes[i]?.weightBps && p.at === outcomes[i]?.at);
      recorded.set(key, same ? previous : Object.freeze(outcomes.map((o) => Object.freeze(o))));
      recordedPayers.set(key, this.distinctPayers(list));
    }
    const byCapability = new Map<CapabilityId, Finalization[]>();
    for (const f of fed) {
      const capability = this.deps.index.byDigest.get(f.releaseDigest)?.release.capability;
      if (capability !== undefined) byCapability.set(capability, [...(byCapability.get(capability) ?? []), f]);
    }
    this.recorded = recorded;
    this.recordedPayers = recordedPayers;
    this.fed = Object.freeze(fed);
    this.fedPayers = new Map([...byCapability].map(([capability, list]) => [capability, this.distinctPayers(list)]));
  }

  /** Distinct known payers; an outcome of a resolution this server did not sell counts for none. */
  private distinctPayers(list: readonly Finalization[]): number {
    return new Set(list.map((f) => this.payers.get(f.resolutionId)).filter((p): p is Address => p !== null && p !== undefined)).size;
  }

  // --- Reads, all from memory -----------------------------------------------------------------------------------

  /** The outcomes the engine holds for (release, profile), in chain order: a frozen array of frozen outcomes. */
  recordedOutcomes(releaseDigest: Hex32, profileIndex: number): readonly Outcome[] {
    return this.recorded.get(keyOf(releaseDigest, profileIndex)) ?? NONE;
  }

  recordedBuyers(releaseDigest: Hex32, profileIndex: number): number {
    return this.publishedBuyers().recorded.get(keyOf(releaseDigest, profileIndex)) ?? 0;
  }

  /** PASSED and FAILED finalizations with a weight, in chain order, after `after`. */
  fedAfter(after: EventPosition | undefined): readonly Finalization[] {
    return after === undefined ? this.fed : this.fed.filter((f) => compareEventPositions(f.position, after) > 0);
  }

  fedBuyers(capability: CapabilityId): number {
    return this.publishedBuyers().fed.get(capability) ?? 0;
  }

  /** The distinct-buyer counts to publish: live without a refresh period, else as taken at the period's first read. */
  private publishedBuyers(): { readonly recorded: ReadonlyMap<string, number>; readonly fed: ReadonlyMap<CapabilityId, number> } {
    const every = this.deps.buyersRefreshMs ?? 0;
    if (every <= 0) return { recorded: this.recordedPayers, fed: this.fedPayers };
    const period = Math.floor((this.deps.clock ?? (() => new Date()))().getTime() / every);
    if (period !== this.publishedPeriod) {
      this.publishedPeriod = period;
      this.publishedRecordedPayers = this.recordedPayers;
      this.publishedFedPayers = this.fedPayers;
    }
    return { recorded: this.publishedRecordedPayers, fed: this.publishedFedPayers };
  }

  /** The engine the registry records into now (the last `EngineSet`), or null when none is set. */
  engine(): Address | null {
    return this.current;
  }

  /**
   * Seconds the registry was paused after `position` and before `until` (when
   * given), an ongoing pause counted up to `nowSeconds`: what moved the claim
   * deadline of a warranty activated at `position` (a warranty can only be
   * activated, finalized or expired while unpaused), until it ended.
   */
  pausedSecondsAfter(position: EventPosition, nowSeconds: bigint, until?: EventPosition): bigint {
    return pausedSecondsAfter(this.pauses, position, nowSeconds, until);
  }
}

/** An indexed `Paused` or `Unpaused`: where it sits and its block's time in Unix seconds. */
export interface PauseEvent {
  readonly position: EventPosition;
  readonly paused: boolean;
  readonly time: bigint;
}

/** `RegistrySnapshot.pausedSecondsAfter` over pauses in chain order, for readers without a snapshot. */
export function pausedSecondsAfter(pauses: readonly PauseEvent[], position: EventPosition, nowSeconds: bigint, until?: EventPosition): bigint {
  let total = 0n;
  let started: bigint | undefined;
  for (const p of pauses) {
    if (compareEventPositions(p.position, position) <= 0) continue;
    if (until !== undefined && compareEventPositions(p.position, until) >= 0) break;
    if (p.paused) started ??= p.time;
    else if (started !== undefined) {
      total += p.time - started;
      started = undefined;
    }
  }
  if (started !== undefined && nowSeconds > started) total += nowSeconds - started;
  return total;
}

/** Pauses read at most per call of `claimDeadlinesInForce`: the registry is paused only in an emergency. */
const PAUSES_READ = 1_000;

/**
 * The claim deadline in force of each active warranty, in Unix seconds, from
 * the stored registry events alone (the evaluator command has no snapshot):
 * the one set at activation plus every second the registry was paused since,
 * an ongoing pause counted up to `nowSeconds`. A warranty whose activation is
 * not indexed has none.
 */
export async function claimDeadlinesInForce(store: Pick<LemmaStore, "listRegistryEvents">, resolutionIds: readonly Hex32[], nowSeconds: bigint): Promise<Map<Hex32, bigint>> {
  const deadlines = new Map<Hex32, bigint>();
  if (resolutionIds.length === 0) return deadlines;
  const pauses = (await store.listRegistryEvents({ names: ["Paused", "Unpaused"] }, PAUSES_READ)).map((e) => ({
    position: { blockNumber: e.blockNumber, logIndex: e.logIndex },
    paused: e.name === "Paused",
    time: BigInt(Math.floor(e.blockTime.getTime() / 1000)),
  }));
  for (const id of resolutionIds) {
    const [activation] = await store.listRegistryEvents({ resolutionId: id, names: ["ResolutionActivated"] }, 1);
    if (activation === undefined || activation.claimDeadline === null) continue;
    deadlines.set(id, activation.claimDeadline + pausedSecondsAfter(pauses, activation, nowSeconds));
  }
  return deadlines;
}

/**
 * Track E's `OutcomeSource` over the indexed registry: exactly the outcomes
 * the engine recorded for (release digest, profile index). The registry
 * calls the engine's `record` only for a PASSED or FAILED verdict with a
 * weight above zero while an engine is set, and an `EngineRecordFailed` for
 * the resolution in the same transaction means the call failed. So these
 * are the indexed `OutcomeFinalized` rows with verdict 1 or 2 and weight
 * above zero, finalized while the engine in force was the one holding
 * outcomes now (the last engine ever set: a new engine starts empty, and
 * disabling the engine erases nothing it recorded), with no
 * `EngineRecordFailed` in their transaction; `at` is their block's
 * timestamp, in chain order. Answers from `RegistrySnapshot`'s memory: the
 * same frozen array while nothing changed.
 *
 * `buyersFor` counts the distinct payers behind those outcomes (only the
 * server knows them); the catalog publishes the count from three up.
 */
export class RegistryOutcomeSource implements OutcomeSource {
  constructor(private readonly snapshot: RegistrySnapshot) {}

  outcomesFor(releaseDigest: Hex32, profileIndex: number): readonly Outcome[] {
    return this.snapshot.recordedOutcomes(releaseDigest, profileIndex);
  }

  buyersFor(releaseDigest: Hex32, profileIndex: number): number {
    return this.snapshot.recordedBuyers(releaseDigest, profileIndex);
  }
}

/** Why the feed passed over an outcome (logged with its resolution id). */
export const RELEASE_NOT_IN_CATALOG = "RELEASE_NOT_IN_CATALOG";
export const NO_RECEIPT = "NO_RECEIPT";

/** Parses the feed's cursor, `"<block>:<logIndex>"`; undefined for none or a malformed one (read from the start). */
export function parseFeedCursor(cursor: string | null): EventPosition | undefined {
  const match = cursor === null ? null : /^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.exec(cursor);
  return match === null ? undefined : { blockNumber: BigInt(match[1] as string), logIndex: Number(match[2]) };
}

/**
 * Track F's `OutcomeFeed` over the indexed registry: every finalization with
 * a PASSED or FAILED verdict and a weight above zero (whether or not the
 * engine recorded it), in chain order, cursor `"<block>:<logIndex>"` of the
 * last one read. Each is built as a `FinalizedOutcome`: the release id,
 * version and capability from the catalog by digest, the acceptance recipe's
 * digest from core, the acceptance result and the buyer agent from the
 * stored receipt, `finalizedAt` from the block's timestamp, and the registry.
 * One whose release left the catalog, or whose receipt this server does not
 * hold, is passed over with a logged code; passed-over outcomes do not count
 * against `limit`, so a short page is the end.
 *
 * `buyersFor(capability)` counts the distinct payers behind the outcomes fed
 * for the capability; the catalog publishes it from three up.
 */
export class RegistryOutcomeFeed implements OutcomeFeed, FedBuyers {
  constructor(
    private readonly snapshot: RegistrySnapshot,
    private readonly deps: {
      readonly store: Pick<LemmaStore, "getReceipt">;
      readonly index: CatalogIndex;
      /** The registry's chain id and address, named by each outcome's evidence. */
      readonly registry: { readonly chainId: number; readonly address: Address };
      readonly logger: Logger;
    },
  ) {}

  async read(cursor: string | null, limit: number): Promise<OutcomePage> {
    const outcomes: FinalizedOutcome[] = [];
    let last = cursor;
    for (const f of this.snapshot.fedAfter(parseFeedCursor(cursor))) {
      if (outcomes.length >= limit) break;
      last = positionKey(f.position);
      const release = this.deps.index.byDigest.get(f.releaseDigest)?.release;
      if (release === undefined) {
        this.deps.logger.log("warn", "warranty.feed_skipped", { resolutionId: f.resolutionId, code: RELEASE_NOT_IN_CATALOG });
        continue;
      }
      const receipt = await this.deps.store.getReceipt(f.resolutionId);
      if (receipt === undefined) {
        this.deps.logger.log("warn", "warranty.feed_skipped", { resolutionId: f.resolutionId, code: NO_RECEIPT });
        continue;
      }
      outcomes.push({
        resolutionId: f.resolutionId,
        releaseDigest: f.releaseDigest,
        releaseId: release.releaseId,
        version: release.version,
        profileIndex: f.profileIndex,
        capability: release.capability,
        verdict: f.verdict === VERDICT_PASSED ? "passed" : "failed",
        acceptanceRecipeDigest: acceptanceRecipeDigest(release.acceptanceRecipe),
        acceptance: receipt.receipt.acceptance,
        registry: this.deps.registry,
        buyerAgentId: receipt.buyerAgentId,
        finalizedAt: f.blockTime.toISOString(),
      });
    }
    return { outcomes, cursor: last };
  }

  buyersFor(capability: CapabilityId): number {
    return this.snapshot.fedBuyers(capability);
  }
}
