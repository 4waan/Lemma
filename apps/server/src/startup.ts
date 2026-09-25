import type { CatalogIndex } from "@lemma/catalog";

import type { ServerConfig } from "./config.js";

/**
 * Checks that must pass before the server listens, beyond `checkCatalog`.
 * A release that can produce an offer (evidence and a positive price) must pay
 * the configured provider: the server quotes for no other destination
 * (server README).
 */
export function startupProblems(config: ServerConfig, index: CatalogIndex): string[] {
  const problems: string[] = [];
  for (const r of index.releases) {
    const offers = BigInt(r.release.price) > 0n && r.release.supportedProfiles.some((p) => p.evidence !== null);
    if (!offers) continue;
    if (config.provider === undefined) problems.push(`${r.release.releaseId}@${r.release.version} can be sold, but PROVIDER_ADDRESS is not set`);
    else if (r.release.provider.payTo !== config.provider) {
      problems.push(`${r.release.releaseId}@${r.release.version} pays ${r.release.provider.payTo}, not the configured provider`);
    }
  }
  if (config.allowProvisionalEvidence && config.env === "production") {
    problems.push("ALLOW_PROVISIONAL_EVIDENCE is set in production; the provisional overlay is testnet-only and never public");
  }
  return problems;
}
