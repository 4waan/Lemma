import { describe, expect, it } from "vitest";

import { loadCatalog } from "../src/index.js";

/**
 * Calendar guards for the committed catalog. Every other test injects its
 * clock; these read the real one on purpose, to warn ahead of a date that
 * will stop the product: a release past `expiresAt` is no longer offered,
 * and a profile past its evidence's `staleAfter` is no longer sold.
 *
 * They run only with LEMMA_DATE_GUARDS=1, which CI sets on its daily
 * scheduled run, so the calendar never turns a pull request red; the
 * scheduled run does, ahead of time, and says what to renew.
 */
const DAY = 86_400_000;
/** A release's expiry needs a new version, so it warns two months ahead. */
const RELEASE_WARNING_DAYS = 60;
/** Evidence is measured again on a cadence, so it warns two weeks ahead. */
const EVIDENCE_WARNING_DAYS = 14;

describe.skipIf(process.env["LEMMA_DATE_GUARDS"] !== "1")("the committed catalog's calendar", () => {
  const now = Date.now();
  const releases = loadCatalog({ includeProvisional: true }).releases;

  it(`has no release that expires within ${RELEASE_WARNING_DAYS} days`, () => {
    const soon = releases
      .filter(({ release }) => Date.parse(release.expiresAt) - now < RELEASE_WARNING_DAYS * DAY)
      .map(({ release }) => `${release.releaseId}@${release.version} expires ${release.expiresAt}: publish a new version`);
    expect(soon).toEqual([]);
  });

  it(`has no evidence that goes stale within ${EVIDENCE_WARNING_DAYS} days`, () => {
    const soon = releases.flatMap(({ release }) =>
      release.supportedProfiles.flatMap((profile, index) =>
        profile.evidence !== null && Date.parse(profile.evidence.staleAfter) - now < EVIDENCE_WARNING_DAYS * DAY
          ? [`${release.releaseId}@${release.version} profile ${index}: evidence ${profile.evidence.benchmarkVersion} goes stale ${profile.evidence.staleAfter}: run the benchmark again`]
          : [],
      ),
    );
    expect(soon).toEqual([]);
  });
});
