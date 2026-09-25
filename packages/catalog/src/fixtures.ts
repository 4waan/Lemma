import { CapabilityId, ExactVersion, IsoTimestamp, MAX_SUPPORTED_PROFILES, ReleaseId, Reasons, RepositoryProfile } from "@lemma/core";
import { z } from "zod";

import { listDirectories, listFilesRecursive, readJson } from "./files.js";
import { issues, message } from "./load.js";
import { FIXTURES_DIR } from "./paths.js";

/**
 * Fixture classes from fixtures/README.md. Every release needs an `exact` case;
 * every capability with a release needs a `near-miss` and an `unsupported`
 * case whose reasons include an unsupported language or runtime. `boundary`
 * cases are added where a release has a range edge worth pinning. `no-release`
 * pins the answer for a capability the catalog has no release for.
 */
export const FixtureClass = z.enum(["exact", "boundary", "near-miss", "unsupported", "no-release"]);

export type FixtureClass = z.infer<typeof FixtureClass>;

const SALE_BLOCKERS: readonly string[] = ["EVIDENCE_STALE", "PRICE_EXCEEDS_SAVING_RULE", "PROFILE_NOT_BENCHMARKED"];
const unsupported = (reasons: readonly string[]) => reasons.some((r) => r.startsWith("UNSUPPORTED_"));

const Expected = z
  .strictObject({
    decision: z.enum(["reuse", "build", "decline"]),
    reasons: Reasons,
    /** The release and profile a `reuse` must match; null for a no-match. */
    match: z
      .strictObject({
        releaseId: ReleaseId,
        version: ExactVersion,
        profileIndex: z.int().min(0).max(MAX_SUPPORTED_PROFILES - 1),
      })
      .nullable(),
    /** Whether the preview carries an offer. */
    offer: z.boolean(),
  })
  .superRefine((e, ctx) => {
    if ((e.decision === "reuse") !== (e.match !== null)) {
      ctx.addIssue({ code: "custom", path: ["match"], message: "a reuse names its match, and a no-match has none" });
    }
    if (e.offer && (e.decision !== "reuse" || e.reasons.length > 0)) {
      ctx.addIssue({ code: "custom", path: ["offer"], message: "only a reuse without reasons carries an offer" });
    }
    if (e.decision === "reuse" && !e.offer && e.reasons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "a reuse without an offer must say why" });
    }
    if (e.decision !== "reuse" && e.reasons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "a no-match must say why" });
    }
    // The answers the resolver can give: a reuse is held back only by one sale
    // blocker; a decline has an unsupported platform among its reasons; a build
    // has none, and NO_RELEASE_FOR_CAPABILITY stands alone.
    if (e.decision === "reuse" && (e.reasons.length > 1 || e.reasons.some((r) => !SALE_BLOCKERS.includes(r)))) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "a reuse can only be held back by one sale blocker" });
    }
    if (e.decision !== "reuse" && e.reasons.some((r) => SALE_BLOCKERS.includes(r))) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "sale blockers apply to matches only" });
    }
    if (e.decision === "decline" && !unsupported(e.reasons)) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "a decline names an unsupported platform" });
    }
    if (e.decision === "build" && unsupported(e.reasons)) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "an unsupported platform is a decline, not a build" });
    }
    if (e.reasons.includes("NO_RELEASE_FOR_CAPABILITY") && e.reasons.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "NO_RELEASE_FOR_CAPABILITY stands alone" });
    }
  });

/** One frozen compatibility case: a capability, a profile, the instant it is judged at, and the expected decision. */
export const FixtureCase = z
  .strictObject({
    class: FixtureClass,
    capability: CapabilityId,
    /** Pinned so expected decisions never change with the calendar. */
    now: IsoTimestamp,
    profile: RepositoryProfile,
    expected: Expected,
  })
  .superRefine((f, ctx) => {
    const ok =
      ((f.class === "exact" || f.class === "boundary") && f.expected.decision === "reuse") ||
      (f.class === "near-miss" && f.expected.decision !== "reuse") ||
      (f.class === "unsupported" && f.expected.decision === "decline") ||
      (f.class === "no-release" && f.expected.decision === "build" && f.expected.reasons.join() === "NO_RELEASE_FOR_CAPABILITY");
    if (!ok) ctx.addIssue({ code: "custom", path: ["expected", "decision"], message: `a ${f.class} case cannot expect ${f.expected.decision}` });
    if (f.class !== "no-release" && f.expected.reasons.includes("NO_RELEASE_FOR_CAPABILITY")) {
      ctx.addIssue({ code: "custom", path: ["expected", "reasons"], message: "only a no-release case expects NO_RELEASE_FOR_CAPABILITY" });
    }
  });

export type FixtureCase = z.infer<typeof FixtureCase>;

export interface LoadedFixture {
  /** `<capability>/<name>`, from `fixtures/<capability>/<name>.json`. */
  readonly id: string;
  readonly fixture: FixtureCase;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*\.json$/;

/** Loads every fixture case, sorted by id. Problems are appended to `problems`. */
export function loadFixtures(root: string, problems: string[]): LoadedFixture[] {
  const out: LoadedFixture[] = [];
  let capabilities: string[];
  try {
    capabilities = listDirectories(root, FIXTURES_DIR, { problems });
  } catch (error) {
    problems.push(message(error));
    return out;
  }
  for (const capability of capabilities) {
    if (!CapabilityId.safeParse(capability).success) {
      problems.push(`${FIXTURES_DIR}/${capability}: not a capability id`);
      continue;
    }
    let files: string[];
    try {
      files = listFilesRecursive(root, `${FIXTURES_DIR}/${capability}`, { problems });
    } catch (error) {
      problems.push(message(error));
      continue;
    }
    for (const file of files) {
      const path = `${FIXTURES_DIR}/${capability}/${file}`;
      if (!NAME.test(file)) {
        problems.push(`${path}: expected <kebab-case-name>.json directly in the capability directory`);
        continue;
      }
      try {
        const parsed = FixtureCase.safeParse(readJson(root, path));
        if (!parsed.success) problems.push(`${path}: ${issues(parsed.error)}`);
        else if (parsed.data.capability !== capability) problems.push(`${path}: capability ${parsed.data.capability} is not its directory`);
        else out.push({ id: `${capability}/${file.slice(0, -".json".length)}`, fixture: parsed.data });
      } catch (error) {
        problems.push(message(error));
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
