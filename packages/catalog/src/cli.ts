import { join } from "node:path";

import { bundleDigest, maxPriceFor } from "@lemma/core";

import { checkCatalog } from "./check.js";
import { listDirectories, writeText } from "./files.js";
import { formatBundle, packPayload } from "./pack.js";
import { BUNDLE_FILE, CATALOG_ROOT, PROVISIONAL_DIR, PUBLIC_DIR } from "./paths.js";
import { loadCatalog } from "./load.js";

/**
 * Authoring commands:
 *   catalog check          validate the catalog; exits 1 on any problem
 *   catalog pack           show each release's packed payload digest
 *   catalog pack --write   also write bundle.json from payload/
 */
const [command, ...flags] = process.argv.slice(2);

if (command === "check") {
  const result = checkCatalog();
  for (const problem of result.problems) console.error(`✗ ${problem}`);
  const releases = result.catalog?.releases.length ?? 0;
  console.log(`${result.problems.length === 0 ? "ok" : "failed"}: ${releases} releases, ${result.fixtureCount} fixtures, ${result.problems.length} problems`);
  process.exitCode = result.problems.length === 0 ? 0 : 1;
} else if (command === "pack") {
  const write = flags.includes("--write");
  let failed = 0;
  for (const base of [PUBLIC_DIR, PROVISIONAL_DIR]) {
    const ids = listDirectories(CATALOG_ROOT, base, { optional: base === PROVISIONAL_DIR });
    for (const id of ids) {
      for (const version of listDirectories(CATALOG_ROOT, `${base}/${id}`)) {
        const dir = `${base}/${id}/${version}`;
        try {
          const bundle = packPayload(join(CATALOG_ROOT, dir));
          // Written through a temporary file and a rename, so a linked bundle.json is replaced, never written through.
          if (write) writeText(CATALOG_ROOT, `${dir}/${BUNDLE_FILE}`, formatBundle(bundle));
          console.log(`${dir}: payloadDigest ${bundleDigest(bundle)}${write ? " (written)" : ""}`);
        } catch (error) {
          failed++;
          console.error(`✗ ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  if (failed > 0) process.exitCode = 1;
  try {
    const catalog = loadCatalog({ includeProvisional: true });
    const g = BigInt(catalog.economics.chainCostAtomic);
    for (const { release, dir } of catalog.releases) {
      release.supportedProfiles.forEach((p, i) => {
        if (p.evidence !== null) console.log(`${dir}: profile ${i} maxPriceFor ${maxPriceFor(p.evidence, { chainCostAtomic: g })} (price ${release.price}, economics ${catalog.economics.status})`);
      });
    }
  } catch {
    // Suggested prices need a loadable catalog; `catalog check` reports why it is not.
  }
} else {
  console.error("usage: catalog <check | pack [--write]>");
  process.exitCode = 2;
}
