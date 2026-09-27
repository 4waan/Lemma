import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { type Hex, encodeAbiParameters, encodeEventTopics, getAddress, numberToHex } from "viem";
import { describe, expect, it } from "vitest";

import { INDEXED_EVENTS, REGISTRY_STATUSES, decodeRegistryLog, errorCodeOf, registryRevertOf, warrantyRegistryAbi } from "../src/index.js";
import { registryError } from "./fake-registry.js";

const committed = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/abi/ResolutionWarrantyRegistry.json", import.meta.url)), "utf8")) as Array<{ type: string; name?: string }>;
/** The vendored entry with this name, if any. */
const itemNamed = (name: string) => warrantyRegistryAbi.find((entry) => entry.name === name);
const SOURCE = readFileSync(fileURLToPath(new URL("../../../contracts/src/ResolutionWarrantyRegistry.sol", import.meta.url)), "utf8");

describe("the vendored registry ABI", () => {
  it("has each entry exactly as contracts/abi/ResolutionWarrantyRegistry.json has it", () => {
    for (const entry of warrantyRegistryAbi) {
      const matches = committed.filter((c) => c.type === entry.type && c.name === entry.name);
      expect(matches, `${entry.type} ${entry.name}`).toHaveLength(1);
      expect(entry, `${entry.type} ${entry.name}`).toEqual(matches[0]);
    }
  });

  it("names every event the indexer stores, and every error the calls it sends can revert with", () => {
    for (const name of INDEXED_EVENTS) expect(itemNamed(name), name).toMatchObject({ type: "event" });
    // The contract's own custom errors (its source), besides the OpenZeppelin ones, that the four calls reach.
    const reached = [
      "VoucherExpired", "ZeroAmount", "InvalidVoucher", "UnknownRelease", "ReleaseNotActive", "ResolutionAlreadyExists", "PaymentRefAlreadyUsed", "InvalidProviderSignature",
      "InsufficientAvailableBond", "ResolutionNotActive", "InvalidVerdict", "InvalidWeight", "OutcomeExpired", "ClaimWindowClosed", "InvalidEvaluatorSignature",
      "InsufficientGasForEngine", "ClaimWindowOpen", "NoCredit", "InvalidRecipient", "InvalidClaim",
    ];
    for (const name of reached) {
      expect(SOURCE, name).toContain(`revert ${name}`);
      expect(itemNamed(name), name).toMatchObject({ type: "error" });
    }
    for (const name of ["EnforcedPause", "ReentrancyGuardReentrantCall", "SafeERC20FailedOperation"]) expect(itemNamed(name), name).toMatchObject({ type: "error" });
    // The registry's Status enum, in the contract's order.
    expect(SOURCE).toMatch(/enum Status \{\s*None,\s*Active,\s*Passed,\s*Failed,\s*Refunded,\s*Voided,\s*Expired\s*\}/);
    expect(REGISTRY_STATUSES).toEqual(["none", "active", "passed", "failed", "refunded", "voided", "expired"]);
  });
});

describe("registry reverts and logs", () => {
  it("decode a custom error into an upper snake case code with its arguments", () => {
    expect(registryRevertOf(registryError("activateResolution", "InsufficientAvailableBond", [5n, 250_000n]))).toEqual({ code: "INSUFFICIENT_AVAILABLE_BOND", name: "InsufficientAvailableBond", args: [5n, 250_000n] });
    expect(registryRevertOf(registryError("expireResolution", "ClaimWindowOpen", [1_790_000_000n]))?.args).toEqual([1_790_000_000n]);
    expect(registryRevertOf(new Error("socket hang up"))).toBeUndefined();
    expect(errorCodeOf("SafeERC20FailedOperation")).toBe("SAFE_ERC20_FAILED_OPERATION");
    expect(errorCodeOf("EnforcedPause")).toBe("ENFORCED_PAUSE");
  });

  const at = (fields: Partial<Parameters<typeof decodeRegistryLog>[0]>) => ({
    address: "0x4c454d4d41000000000000000000000000000001" as Hex,
    blockNumber: numberToHex(12n),
    logIndex: numberToHex(3),
    transactionHash: `0x${"AB".repeat(32)}` as Hex,
    data: "0x" as Hex,
    topics: [] as Hex[],
    ...fields,
  });
  const time = new Date("2026-10-01T00:00:00.000Z");
  const id = `0x${"11".repeat(32)}` as Hex;
  const digest = `0x${"44".repeat(32)}` as Hex;

  it("decode each indexed event into its row, never keeping an activation's payment reference", () => {
    const activation = decodeRegistryLog(
      at({
        topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "ResolutionActivated", args: { resolutionId: id, releaseDigest: digest } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint8" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint64" }], [2, 250_000n, `0x${"55".repeat(32)}`, 1_790_259_200n]),
      }),
      time,
    );
    expect(activation).toEqual({
      name: "ResolutionActivated",
      blockNumber: 12n,
      logIndex: 3,
      txHash: `0x${"ab".repeat(32)}`,
      blockTime: time,
      removed: false,
      resolutionId: id,
      releaseDigest: digest,
      profileIndex: 2,
      verdict: null,
      weightBps: null,
      evidenceHash: null,
      amount: "250000",
      claimDeadline: 1_790_259_200n,
      engine: null,
    });
    expect(JSON.stringify(activation, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("5555");

    const finalized = decodeRegistryLog(
      at({
        topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "OutcomeFinalized", args: { resolutionId: id, releaseDigest: digest } }) as Hex[],
        data: encodeAbiParameters([{ type: "uint8" }, { type: "uint16" }, { type: "bytes32" }], [2, 10_000, `0x${"66".repeat(32)}`]),
        removed: true,
      }),
      time,
    );
    expect(finalized).toMatchObject({ name: "OutcomeFinalized", verdict: 2, weightBps: 10_000, evidenceHash: `0x${"66".repeat(32)}`, removed: true });

    const engineSet = decodeRegistryLog(
      at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "EngineSet", args: { previousEngine: "0x0000000000000000000000000000000000000000", newEngine: getAddress("0x00000000000000000000000000000000000000ee") } }) as Hex[] }),
      time,
    );
    expect(engineSet).toMatchObject({ name: "EngineSet", engine: "0x00000000000000000000000000000000000000ee", resolutionId: null });
    expect(decodeRegistryLog(at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "EngineRecordFailed", args: { resolutionId: id } }) as Hex[] }), time)).toMatchObject({ name: "EngineRecordFailed", resolutionId: id });
    expect(
      decodeRegistryLog(
        at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "CreditWithdrawn", args: { resolutionId: id } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [250_000n]) }),
        time,
      ),
    ).toMatchObject({ name: "CreditWithdrawn", amount: "250000" });
    expect(
      decodeRegistryLog(
        at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "ResolutionExpired", args: { resolutionId: id, releaseDigest: digest } }) as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [250_000n]) }),
        time,
      ),
    ).toMatchObject({ name: "ResolutionExpired", amount: "250000", releaseDigest: digest });
    expect(decodeRegistryLog(at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "Paused" }) as Hex[], data: encodeAbiParameters([{ type: "address" }], ["0x00000000000000000000000000000000000000a1"]) }), time)).toMatchObject({ name: "Paused" });
  });

  it("skip a log that is not an indexed event, or not mined", () => {
    const bond = encodeEventTopics({ abi: [{ type: "event", name: "BondDeposited", inputs: [{ name: "releaseDigest", type: "bytes32", indexed: true }, { name: "from", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] }], eventName: "BondDeposited", args: { releaseDigest: digest, from: "0x00000000000000000000000000000000000000a1" } });
    expect(decodeRegistryLog(at({ topics: bond as Hex[], data: encodeAbiParameters([{ type: "uint256" }], [1n]) }), time)).toBeUndefined();
    expect(decodeRegistryLog(at({ topics: encodeEventTopics({ abi: warrantyRegistryAbi, eventName: "EngineRecordFailed", args: { resolutionId: id } }) as Hex[], blockNumber: null }), time)).toBeUndefined();
  });
});
