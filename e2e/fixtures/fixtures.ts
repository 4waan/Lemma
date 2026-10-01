import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The third-party bytecode the end-to-end run puts on its local chain, and
 * where each file came from (`provenance.json`, explained in README.md). The
 * run never builds Circle's or ERC-8004's repositories: it reads these files,
 * and only after their sha256 matches the provenance record.
 */
export const FIXTURES_DIR = fileURLToPath(new URL(".", import.meta.url));
export const BYTECODE_DIR = join(FIXTURES_DIR, "bytecode");
export const PROVENANCE_FILE = join(FIXTURES_DIR, "provenance.json");
/** Every fixture file stays below this size. */
export const MAX_FIXTURE_BYTES = 200 * 1024;

/** The fixture files, by name without the `.hex` extension. */
export const FIXTURE_NAMES = [
  "FiatTokenV2_2.runtime",
  "SignatureChecker.runtime",
  "HardhatMinimalUUPS.initcode",
  "ERC1967Proxy.initcode",
  "IdentityRegistryUpgradeable.initcode",
  "ReputationRegistryUpgradeable.initcode",
] as const;

export type FixtureName = (typeof FIXTURE_NAMES)[number];

export interface FixtureSource {
  readonly repository: string;
  readonly commit: string;
  readonly license: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly compiler: {
    readonly solc: string;
    readonly solcSha256: string;
    readonly optimizer: { readonly enabled: boolean; readonly runs: number };
    readonly evmVersion: string;
    readonly viaIR: boolean;
    readonly bytecodeHash: string;
  };
  readonly build: string;
}

export interface FixtureEntry {
  /** The file under `bytecode/`. */
  readonly file: string;
  /** A key of `sources`. */
  readonly source: string;
  /** `<source path>:<contract>` in the source repository. */
  readonly contract: string;
  /** `runtime`: deployed code, put on chain with anvil_setCode; `initcode`: creation code, deployed by a transaction. */
  readonly kind: "runtime" | "initcode";
  /** The field of the Foundry artifact the file holds, followed by a newline. */
  readonly artifactField: "deployedBytecode.object" | "bytecode.object";
  /** Length of the bytecode in bytes. */
  readonly bytes: number;
  /** sha256 of the file as committed. */
  readonly sha256: string;
  /** Library placeholders (`__$<34 hex>$__`) and their byte offsets, linked at run time. */
  readonly linkReferences?: Readonly<Record<string, readonly number[]>>;
}

export interface Provenance {
  readonly schema: "lemma.e2e.fixtures.v1";
  readonly sources: Readonly<Record<string, FixtureSource>>;
  readonly files: readonly FixtureEntry[];
}

export function readProvenance(): Provenance {
  const value = JSON.parse(readFileSync(PROVENANCE_FILE, "utf8")) as Provenance;
  if (value.schema !== "lemma.e2e.fixtures.v1") throw new Error(`${PROVENANCE_FILE}: unknown schema`);
  return value;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const HEX_FILE = /^0x(?:[0-9a-f]{2}|__\$[0-9a-f]{34}\$__)+\n$/;

/**
 * Every problem with the committed fixtures: a file missing, changed (its
 * sha256), over the size limit, not hex, of another length than recorded, or
 * present without a provenance entry. Empty when all is well.
 */
export function checkFixtures(provenance: Provenance = readProvenance()): string[] {
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const entry of provenance.files) {
    listed.add(entry.file);
    if (provenance.sources[entry.source] === undefined) problems.push(`${entry.file}: unknown source ${entry.source}`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(BYTECODE_DIR, entry.file));
    } catch {
      problems.push(`${entry.file}: missing`);
      continue;
    }
    if (bytes.length >= MAX_FIXTURE_BYTES) problems.push(`${entry.file}: ${bytes.length} bytes, over the ${MAX_FIXTURE_BYTES}-byte limit`);
    const digest = sha256(bytes);
    if (digest !== entry.sha256) problems.push(`${entry.file}: sha256 ${digest}, but provenance.json records ${entry.sha256}`);
    const text = bytes.toString("utf8");
    if (!HEX_FILE.test(text)) problems.push(`${entry.file}: not 0x-prefixed lowercase hex followed by one newline`);
    else if ((text.length - 3) / 2 !== entry.bytes) problems.push(`${entry.file}: ${(text.length - 3) / 2} bytes of bytecode, but provenance.json records ${entry.bytes}`);
  }
  for (const name of FIXTURE_NAMES) if (!listed.has(`${name}.hex`)) problems.push(`${name}.hex: no provenance entry`);
  for (const file of readdirSync(BYTECODE_DIR)) {
    if (!statSync(join(BYTECODE_DIR, file)).isFile() || !listed.has(file)) problems.push(`bytecode/${file}: not recorded in provenance.json`);
  }
  return problems;
}

/**
 * A fixture's bytecode, as `0x` hex, only once its file matches its sha256 in
 * provenance.json: a changed or unrecorded fixture never reaches the chain.
 * Library placeholders stay in; `linkLibrary` fills them.
 */
export function fixtureBytecode(name: FixtureName, provenance: Provenance = readProvenance()): `0x${string}` {
  const entry = provenance.files.find((f) => f.file === `${name}.hex`);
  if (entry === undefined) throw new Error(`${name}.hex has no provenance entry`);
  const bytes = readFileSync(join(BYTECODE_DIR, entry.file));
  const digest = sha256(bytes);
  if (digest !== entry.sha256) throw new Error(`${entry.file} changed: sha256 ${digest}, provenance.json records ${entry.sha256}`);
  return bytes.toString("utf8").trim() as `0x${string}`;
}

/** Replaces every library placeholder (`__$<34 hex>$__`) with `address`. */
export function linkLibrary(bytecode: `0x${string}`, address: `0x${string}`): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("expected a library address");
  return bytecode.replace(/__\$[0-9a-f]{34}\$__/g, address.slice(2).toLowerCase()) as `0x${string}`;
}
