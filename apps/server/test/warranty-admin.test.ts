import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { LoadedRelease } from "@lemma/catalog";
import type { CapabilityRelease } from "@lemma/core";
import { describe, expect, it } from "vitest";

import { AdminError, parseAdminArgs, priorsFor, registryAdminAbi, engineAdminAbi } from "../src/warranty/admin.js";
import { sellableIndex } from "./helpers.js";

const committed = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/abi/ResolutionWarrantyRegistry.json", import.meta.url)), "utf8")) as Array<{ type: string; name?: string }>;
const stylusInterface = readFileSync(fileURLToPath(new URL("../../../contracts/stylus/confidence-contract/ICompatibilityConfidence.sol", import.meta.url)), "utf8");

/** A key-shaped value, made from pieces so no scanner mistakes it for a real one. */
const keyShaped = `0x${"ab".repeat(16)}${"cd".repeat(16)}`;

describe("the operator script's ABIs", () => {
  it("has each registry entry exactly as contracts/abi/ResolutionWarrantyRegistry.json has it", () => {
    for (const entry of registryAdminAbi) {
      const matches = committed.filter((c) => c.type === entry.type && c.name === entry.name);
      expect(matches, `${entry.type} ${entry.name}`).toHaveLength(1);
      expect(entry, `${entry.type} ${entry.name}`).toEqual(matches[0]);
    }
  });

  it("calls the Stylus engine only as its exported interface declares", () => {
    const declared = new Map<string, { inputs: string; outputs: string }>();
    for (const match of stylusInterface.matchAll(/function (\w+)\(([^)]*)\) external(?: view)?(?: returns \(([^)]*)\))?;/g)) {
      const types = (list: string | undefined) => (list ?? "").split(",").map((p) => p.trim().split(/\s+/)[0]).filter((t) => t !== undefined && t !== "").join(",");
      declared.set(match[1] as string, { inputs: types(match[2]), outputs: types(match[3]) });
    }
    for (const entry of engineAdminAbi) {
      if (entry.type !== "function") continue;
      expect(declared.get(entry.name), entry.name).toEqual({ inputs: entry.inputs.map((i) => i.type).join(","), outputs: entry.outputs.map((o) => o.type).join(",") });
    }
    for (const name of ["NotOwner", "NotRegistry"]) expect(stylusInterface).toContain(`error ${name}(address);`);
  });
});

describe("parseAdminArgs", () => {
  it("reads each command", () => {
    expect(parseAdminArgs(["status"])).toEqual({ command: "status", catalog: undefined, provisional: false });
    expect(parseAdminArgs(["register-release", "gating@1.0.0+bench-1", "--catalog", "/tmp/catalog", "--provisional"])).toEqual({
      command: "register-release",
      release: "gating@1.0.0+bench-1",
      catalog: "/tmp/catalog",
      provisional: true,
    });
    expect(parseAdminArgs(["deposit-bond", "gating@1.0.0+bench-1", "5000000"])).toMatchObject({ command: "deposit-bond", amount: 5_000_000n });
    expect(parseAdminArgs(["set-engine", "0x00000000000000000000000000000000000000eE"])).toEqual({ command: "set-engine", engine: "0x00000000000000000000000000000000000000ee" });
    expect(parseAdminArgs(["set-priors"])).toEqual({ command: "set-priors", releases: [], catalog: undefined });
    expect(parseAdminArgs(["set-priors", "gating@1.0.0+bench-1", "other@2.0.0"])).toMatchObject({ releases: ["gating@1.0.0+bench-1", "other@2.0.0"] });
  });

  it("refuses a key-shaped argument without repeating it, with or without 0x", () => {
    const bare = keyShaped.slice(2);
    for (const argv of [["deposit-bond", "gating@1.0.0", keyShaped], ["status", `--catalog=${keyShaped}`], [keyShaped], ["deposit-bond", "gating@1.0.0", bare], ["status", "--catalog", bare], ["status", `--key=${bare}`], [bare.toUpperCase()]]) {
      const parsed = parseAdminArgs(argv);
      expect(parsed, argv.join(" ")).toMatchObject({ error: expect.stringContaining("never an argument") });
      expect(JSON.stringify(parsed).toLowerCase()).not.toContain(bare.slice(0, 16));
    }
    // A longer run of hex is not a key.
    expect(parseAdminArgs(["status", "--catalog", `/tmp/${bare}0`])).toMatchObject({ command: "status" });
  });

  it("never repeats an unknown option, which could hold a secret", () => {
    for (const option of ["--verbose", "--token=abc123", `--x=${"9f".repeat(20)}`]) {
      const parsed = parseAdminArgs(["status", option]);
      expect(parsed).toMatchObject({ error: expect.stringContaining("unknown option") });
      expect(JSON.stringify(parsed)).not.toContain(option.slice(2));
    }
  });

  it("refuses what an operator could mistype", () => {
    const refused = (argv: string[]) => expect(parseAdminArgs(argv), argv.join(" ")).toHaveProperty("error");
    refused([]);
    refused(["deploy"]);
    refused(["register-release"]);
    refused(["register-release", "Gating"]);
    refused(["register-release", "a@1", "b@2"]);
    refused(["deposit-bond", "gating@1.0.0"]);
    refused(["deposit-bond", "gating@1.0.0", "1.5"]);
    refused(["deposit-bond", "gating@1.0.0", "0"]);
    refused(["deposit-bond", "gating@1.0.0", "-1"]);
    refused(["set-engine"]);
    refused(["set-engine", "0x00000000000000000000000000000000000000EE"]);
    refused(["set-engine", "0x0000000000000000000000000000000000000000"]);
    refused(["set-engine", "0x00000000000000000000000000000000000000ee", "--catalog", "x"]);
    refused(["status", "--catalog"]);
    refused(["status", "--verbose"]);
    expect(parseAdminArgs(["set-priors", "--provisional"])).toMatchObject({ error: expect.stringContaining("frozen benchmark evidence") });
  });
});

describe("priorsFor", () => {
  const loaded = (): LoadedRelease => {
    const r = sellableIndex().releases[0]!;
    return { release: r.release, releaseDigest: r.releaseDigest, bundle: r.bundle, source: "public", dir: "releases/gating/1.0.0+bench-1" };
  };

  it("is each benchmarked profile's treatment arm, citing its run set, as the catalog's prior", () => {
    const base = loaded();
    const [profile] = base.release.supportedProfiles;
    const second = { ...profile!, evidence: { ...profile!.evidence!, runs: { control: 5, treatment: 8 }, passed: { control: 1, treatment: 6 }, runSetDigest: `0x${"34".repeat(32)}` } };
    const release: CapabilityRelease = { ...base.release, supportedProfiles: [profile!, { ...profile!, evidence: null }, second] };
    const priors = priorsFor(new Map([["gating@1.0.0+bench-1", { ...base, release }]]));
    expect(priors).toEqual([
      { ref: "gating@1.0.0+bench-1", releaseDigest: base.releaseDigest, profileIndex: 0, passes: 3, failures: 0, evidenceDigest: `0x${"12".repeat(32)}` },
      { ref: "gating@1.0.0+bench-1", releaseDigest: base.releaseDigest, profileIndex: 2, passes: 6, failures: 2, evidenceDigest: `0x${"34".repeat(32)}` },
    ]);
  });

  it("never sets a provisional prior, and names a release it does not know", () => {
    const provisional = { ...loaded(), source: "provisional" as const };
    expect(() => priorsFor(new Map([["gating@1.0.0+provisional-1", provisional]]))).toThrow(AdminError);
    expect(() => priorsFor(new Map([["gating@1.0.0+bench-1", loaded()]]), ["other@1.0.0"])).toThrow(/other@1.0.0 is not in the catalog/);
  });
});
