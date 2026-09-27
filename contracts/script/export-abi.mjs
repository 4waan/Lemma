#!/usr/bin/env node
// Writes contracts/abi/<Contract>.json (the `abi` array only) from `forge build` output, so
// TypeScript code can import the registry's and the engine's ABIs without Foundry.
//
//   npm run contracts:abi              build, then write the ABI files
//   npm run contracts:abi -- --check   build, then fail if a committed ABI differs (CI)
//
// Node built-ins only. The build output is read from contracts/out.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const contractsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Each exported ABI: its source file (as forge names the output folder) and contract name. */
const EXPORTS = [
  { source: "ResolutionWarrantyRegistry.sol", contract: "ResolutionWarrantyRegistry" },
  { source: "ICompatibilityEngine.sol", contract: "ICompatibilityEngine" },
];

function fail(message) {
  console.error(`export-abi: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
for (const arg of args) {
  if (arg !== "--check") fail(`unknown argument ${JSON.stringify(arg)} (only --check)`);
}
const check = args.includes("--check");

async function readAbi({ source, contract }) {
  const artifactPath = path.join(contractsDir, "out", source, `${contract}.json`);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    fail(`cannot read ${path.relative(contractsDir, artifactPath)}: run forge build first (${error.code ?? error.message})`);
  }
  if (!Array.isArray(artifact.abi) || artifact.abi.length === 0) {
    fail(`${path.relative(contractsDir, artifactPath)} has no ABI`);
  }
  return `${JSON.stringify(canonicalOrder(artifact.abi), null, 2)}\n`;
}

/** Entries sorted by kind, name and input types, so the file does not depend on emit order. */
function canonicalOrder(abi) {
  const rank = { constructor: 0, fallback: 1, receive: 2, function: 3, event: 4, error: 5 };
  const key = (entry) => [
    String(rank[entry.type] ?? 9),
    entry.name ?? "",
    (entry.inputs ?? []).map((input) => input.type).join(","),
  ];
  return [...abi].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
    }
    return 0;
  });
}

const abiDir = path.join(contractsDir, "abi");
const stale = [];
for (const entry of EXPORTS) {
  const expected = await readAbi(entry);
  const target = path.join(abiDir, `${entry.contract}.json`);
  const relative = path.relative(contractsDir, target);
  if (check) {
    const committed = await readFile(target, "utf8").catch(() => null);
    if (committed !== expected) stale.push(relative);
  } else {
    await mkdir(abiDir, { recursive: true });
    await writeFile(target, expected);
    console.log(`export-abi: wrote ${relative}`);
  }
}

if (stale.length > 0) {
  fail(`${stale.join(", ")} differ from the build; run npm run contracts:abi and commit the result`);
}
if (check) console.log(`export-abi: ${EXPORTS.length} committed ABIs match the build`);
