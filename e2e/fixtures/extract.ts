/**
 * Writes the fixture files from Foundry build outputs of the two upstream
 * repositories, and records each file's length and sha256 in provenance.json
 * (README.md says how each output is built). Run it only to re-derive or
 * audit the fixtures; the end-to-end run never calls it.
 *
 *   npx tsx e2e/fixtures/extract.ts --circle <stablecoin-evm>/artifacts/foundry --erc8004 <erc-8004-contracts>/out
 *
 * A clean `git diff` afterwards shows the committed files are what those
 * sources and compilers produce.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BYTECODE_DIR, type FixtureEntry, PROVENANCE_FILE, readProvenance } from "./fixtures.js";

function argument(name: string): string {
  const i = process.argv.indexOf(name);
  const value = i < 0 ? undefined : process.argv[i + 1];
  if (value === undefined) {
    console.error("usage: extract --circle <stablecoin-evm artifacts/foundry> --erc8004 <erc-8004-contracts out>");
    process.exit(2);
  }
  return value;
}

const outputs: Record<string, string> = { circle: argument("--circle"), erc8004: argument("--erc8004") };

interface Artifact {
  readonly bytecode: { readonly object: string };
  readonly deployedBytecode: { readonly object: string; readonly linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>> };
}

const provenance = readProvenance();
const files: FixtureEntry[] = provenance.files.map((entry) => {
  const [path, contract] = entry.contract.split(":") as [string, string];
  const file = path.split("/").at(-1) as string;
  const artifact = JSON.parse(readFileSync(join(outputs[entry.source] as string, file, `${contract}.json`), "utf8")) as Artifact;
  const object = entry.artifactField === "deployedBytecode.object" ? artifact.deployedBytecode.object : artifact.bytecode.object;
  const text = `${object.toLowerCase()}\n`;
  writeFileSync(join(BYTECODE_DIR, entry.file), text);
  const links = entry.kind === "runtime" ? artifact.deployedBytecode.linkReferences ?? {} : {};
  const linkReferences: Record<string, number[]> = {};
  for (const [source, libraries] of Object.entries(links)) {
    for (const [library, spots] of Object.entries(libraries)) linkReferences[`${source}:${library}`] = spots.map((s) => s.start);
  }
  const { linkReferences: _previous, ...rest } = entry;
  return {
    ...rest,
    bytes: (object.length - 2) / 2,
    sha256: createHash("sha256").update(text).digest("hex"),
    ...(Object.keys(linkReferences).length > 0 ? { linkReferences } : {}),
  };
});
writeFileSync(PROVENANCE_FILE, `${JSON.stringify({ ...provenance, files }, null, 2)}\n`);
for (const f of files) console.log(`${f.file}  ${f.bytes} bytes  sha256 ${f.sha256}`);
