import { createHmac, randomBytes } from "node:crypto";

import type { Preview, RepositoryProfile } from "@lemma/core";
import { canonicalize } from "@lemma/core";

import { describeError } from "./errors.js";
import type { Logger } from "./log.js";
import type { LemmaStore } from "./persistence.js";

/** Buckets with fewer distinct profiles are never published (k-anonymity). */
export const DEMAND_MIN_PROFILES = 5;

/**
 * The demand bucket of a preview: capability, decision, matched release and
 * profile (or the reasons of a no-match), and a coarse repository class. It
 * carries no dependency names or versions, so a bucket cannot single out a
 * repository.
 */
export function demandBucket(preview: Preview, capability: string, profile: RepositoryProfile): string {
  return canonicalize({
    capability,
    decision: preview.decision,
    release: "release" in preview ? `${preview.release.releaseId}@${preview.release.version}` : null,
    profileIndex: "release" in preview ? preview.release.profileIndex : null,
    reasons: preview.reasons,
    offer: "offer" in preview && preview.offer !== null,
    class: {
      packageManager: profile.packageManager.name,
      moduleSystem: profile.moduleSystem,
      nodeMajor: profile.runtime.major,
      frameworks: profile.frameworks,
    },
  });
}

/** The longest a preview waits for demand recording before answering anyway. */
export const DEMAND_RECORD_BUDGET_MS = 250;

/**
 * Counts every preview, offer or not, as one salted profile and one salted
 * client source per bucket and UTC day (scale lever and roadmap input,
 * docs/economic-gates.md). A bucket is published only when both counts reach
 * k, because a single caller can make up profiles far more easily than
 * addresses. Recording never fails or stalls a preview: errors are logged, and
 * after DEMAND_RECORD_BUDGET_MS the preview is answered while the write
 * finishes on its own.
 *
 * The client address is keyed with `sourceKey` (HMAC) before it reaches the
 * store. The key lives only in the server's configuration, never in the
 * database, so the database (or a backup of it) holds no address it could
 * recover by trying all 2^32 IPv4 values against the day's salt.
 */
export class DemandRecorder {
  private readonly sourceKey: Uint8Array;

  constructor(
    private readonly store: LemmaStore,
    private readonly logger: Logger,
    sourceKey?: Uint8Array,
    private readonly budgetMs: number = DEMAND_RECORD_BUDGET_MS,
  ) {
    this.sourceKey = sourceKey ?? randomBytes(32);
  }

  async record(preview: Preview, capability: string, profile: RepositoryProfile, now: Date, source: string): Promise<void> {
    const day = now.toISOString().slice(0, 10);
    const keyedSource = createHmac("sha256", this.sourceKey).update(`${day}\n${source}`).digest("hex");
    const write = this.store
      .recordDemand(day, demandBucket(preview, capability, profile), preview.profileDigest, keyedSource)
      .catch((error: unknown) => this.logger.log("warn", "demand.record_failed", { error: describeError(error) }));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([write, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.budgetMs)))]);
    clearTimeout(timer);
  }
}
