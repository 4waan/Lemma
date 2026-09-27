import { describeError } from "../errors.js";
import type { Logger } from "../log.js";
import { LOG_CHUNK_BLOCKS, isRpcRefusal } from "../payments/chain.js";
import type { LemmaStore, RegistryEventRow } from "../persistence.js";
import type { RegistryLog, WarrantyChain } from "./chain.js";
import { runEvery } from "./loop.js";

/** The indexer's cursor in `chain_cursors`. */
export const REGISTRY_CURSOR = "warranty-registry";
/** How often the indexer reads new blocks. */
export const INDEXER_INTERVAL_MS = 15_000;
/** Log ranges read per run at most: a run that is far behind catches up over several runs. */
export const INDEXER_RANGES_PER_RUN = 50;
/**
 * How many blocks behind the latest one the indexer stops by default
 * (`WARRANTY_INDEXER_CONFIRMATIONS`): about 16 seconds of Arbitrum's blocks,
 * well past how far one backend of a load-balanced RPC endpoint lags another
 * or a sequencer reorganizes its latest blocks.
 */
export const INDEXER_CONFIRMATIONS = 64n;

export interface RegistryIndexerDeps {
  readonly store: Pick<LemmaStore, "getChainCursor" | "advanceChainCursor">;
  readonly chain: Pick<WarrantyChain, "head" | "registryLogs">;
  /** `WARRANTY_REGISTRY_START_BLOCK`: where the first run starts; later runs go on from the cursor. */
  readonly startBlock: bigint;
  /**
   * `WARRANTY_INDEXER_CONFIRMATIONS`: how many blocks behind the latest one a
   * run stops. A block is read only once this many blocks are built on it, and
   * never again, so a log from a block that is reorganized away, or that the
   * node answering `eth_getLogs` does not have yet, must never be read before
   * that depth. 0 reads up to the latest block (tests, and a local chain that
   * mines only on transactions).
   */
  readonly confirmations: bigint;
  readonly clock: () => Date;
  readonly logger: Logger;
  /** The widest range asked of `eth_getLogs` at once (default 10,000 blocks, track C's). */
  readonly maxSpan?: bigint;
  readonly rangesPerRun?: number;
  /**
   * Called at the end of every run, whatever it stored (the outcome
   * snapshots refresh here). A failure is logged, never thrown.
   */
  readonly onIndexed?: () => Promise<unknown>;
}

export interface IndexReport {
  /** Ranges read and stored this run. */
  readonly ranges: number;
  /** Rows stored (a log already stored counts again; the store keeps it once). */
  readonly stored: number;
  /** Logs skipped because the node marked them removed (a reorg took them back). */
  readonly removed: number;
  /** The next block to read after this run. */
  readonly next: bigint;
  /** The latest block when the run began. */
  readonly head: bigint;
  /** The last block this run could read: `head` less the confirmations (below the start block while the chain is younger than that). */
  readonly confirmed: bigint;
}

/**
 * Reads the warranty registry's logs into `registry_events`: from
 * `WARRANTY_REGISTRY_START_BLOCK`, or from where its cursor stopped, up to
 * `confirmations` blocks behind the latest one, in ranges of up to `maxSpan`
 * blocks. A range is read once: plain `eth_getLogs` never reports a log a
 * reorg took back, and a node behind the head answers a range past its own
 * head with what it has, without an error, so only the depth keeps such logs
 * out, and a node lagging further, or a reorg deeper, is trusted. A range the RPC node
 * refuses (a JSON-RPC error, as for a range wider than it serves) is halved,
 * down to one block, as track C's log search does; after each stored range
 * the span doubles again, back up to `maxSpan`. Logs the node marks removed
 * are skipped. The cursor moves only in the same store step that stores the
 * range's rows, and only from where this run found it, so a crash re-reads a
 * range (each log is stored once) and two indexers never both advance.
 *
 * It is the only source of chain facts: every state, deadline, verdict and
 * transaction hash the server shows or acts on comes from its rows, so an
 * action anyone relayed shows up too.
 */
export class RegistryIndexer {
  private span: bigint;
  private readonly maxSpan: bigint;

  constructor(private readonly deps: RegistryIndexerDeps) {
    this.maxSpan = deps.maxSpan ?? LOG_CHUNK_BLOCKS;
    if (this.maxSpan < 1n) throw new RangeError("maxSpan must be at least one block");
    if (deps.confirmations < 0n) throw new RangeError("confirmations must not be negative");
    this.span = this.maxSpan;
  }

  /** One run. Throws when the chain or the store fails (the loop logs it); a refused range is halved instead. */
  async runOnce(): Promise<IndexReport> {
    const { store, chain, logger } = this.deps;
    let cursor = await store.getChainCursor(REGISTRY_CURSOR);
    let from = cursor ?? this.deps.startBlock;
    const head = await chain.head();
    const confirmed = head.number - this.deps.confirmations;
    let ranges = 0;
    let stored = 0;
    let removed = 0;
    const limit = this.deps.rangesPerRun ?? INDEXER_RANGES_PER_RUN;
    try {
      while (from <= confirmed && ranges < limit) {
        const to = from + this.span - 1n < confirmed ? from + this.span - 1n : confirmed;
        let logs: RegistryLog[];
        try {
          logs = await chain.registryLogs(from, to);
        } catch (error) {
          if (to === from || !isRpcRefusal(error)) throw error;
          this.span = (to - from + 1n) / 2n;
          continue;
        }
        const rows: RegistryEventRow[] = [];
        for (const { removed: gone, ...row } of logs) {
          if (gone) removed++;
          else rows.push(row);
        }
        if (!(await store.advanceChainCursor(REGISTRY_CURSOR, cursor, to + 1n, rows, this.deps.clock()))) {
          // Another indexer moved the cursor: it has this range; the next run goes on from there.
          logger.log("warn", "warranty.index_raced", { from: from.toString() });
          break;
        }
        ranges++;
        stored += rows.length;
        cursor = to + 1n;
        from = cursor;
        this.span = this.span * 2n < this.maxSpan ? this.span * 2n : this.maxSpan;
      }
    } finally {
      await this.refreshed();
    }
    if (stored > 0 || removed > 0) logger.log("info", "warranty.indexed", { ranges, stored, removed, next: from.toString(), head: head.number.toString(), confirmed: confirmed.toString() });
    return { ranges, stored, removed, next: from, head: head.number, confirmed };
  }

  /** The span the next range asks for: halved by refusals, grown back by successes. */
  get currentSpan(): bigint {
    return this.span;
  }

  private async refreshed(): Promise<void> {
    if (this.deps.onIndexed === undefined) return;
    try {
      await this.deps.onIndexed();
    } catch (error) {
      this.deps.logger.log("warn", "warranty.snapshot_failed", { error: describeError(error) });
    }
  }

  /** Runs now and then every `intervalMs`, one run at a time; returns a stop function. */
  start(intervalMs: number = INDEXER_INTERVAL_MS): () => void {
    return runEvery(intervalMs, () => this.runOnce(), this.deps.logger, "warranty.index_failed");
  }
}
