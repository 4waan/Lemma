import type { Address, BuyerPass, Hex32, Resolution } from "@lemma/core";
import { describe, expect, it } from "vitest";

import { BUYER_PASS_RETRY_MS, BuyerPassKeeper } from "../src/index.js";

const PASS = `0x${"ab".repeat(32)}` as BuyerPass;
const BOUGHT = { previewId: `0x${"01".repeat(32)}` as Hex32, buyer: "0x00000000000000000000000000000000000000b1" as Address };
const flush = () => new Promise((resolve) => setImmediate(resolve));

function keeper(options: { stored?: BuyerPass; bought?: boolean; diskFull?: boolean } = {}) {
  let stored = options.stored;
  let mono = 0;
  const claims: Array<{ args: unknown[]; answer: (pass: BuyerPass | undefined) => void; fail: () => void }> = [];
  const inbox = {
    buyerPass: () => stored,
    putBuyerPass: (pass: BuyerPass) => {
      if (options.diskFull === true) throw new Error("ENOSPC");
      stored = pass;
    },
    resolutions: () => (options.bought === false ? [] : [BOUGHT as Resolution]),
  };
  const remote = {
    claimBuyerPass: (...args: unknown[]) => new Promise<BuyerPass | undefined>((answer, reject) => claims.push({ args, answer, fail: () => reject(new Error("offline")) })),
  };
  return { passes: new BuyerPassKeeper(inbox, remote, () => mono), claims, stored: () => stored, tick: (ms: number) => (mono += ms) };
}

describe("the buyer pass keeper", () => {
  it("sends a stored pass without claiming, and claims nothing before a purchase", () => {
    const withPass = keeper({ stored: PASS });
    expect(withPass.passes.current()).toBe(PASS);
    expect(withPass.claims).toHaveLength(0);
    const unbought = keeper({ bought: false });
    expect(unbought.passes.current()).toBeUndefined();
    expect(unbought.claims).toHaveLength(0);
  });

  it("claims once in the background after a purchase, never holding up a preview, and later previews carry the pass", async () => {
    const w = keeper();
    // The preview that starts the claim goes without the pass, and so does one sent while it runs: one claim, for the newest purchase.
    expect(w.passes.current()).toBeUndefined();
    expect(w.passes.current()).toBeUndefined();
    expect(w.claims.map((c) => c.args)).toEqual([[BOUGHT.previewId, BOUGHT.buyer]]);
    w.claims[0]?.answer(PASS);
    await flush();
    expect(w.passes.current()).toBe(PASS);
    expect(w.stored()).toBe(PASS);
    expect(w.claims).toHaveLength(1);
  });

  it("tries a failed or unanswered claim again only after the wait", async () => {
    const w = keeper();
    w.passes.current();
    w.claims[0]?.fail();
    await flush();
    w.tick(BUYER_PASS_RETRY_MS - 1);
    expect(w.passes.current()).toBeUndefined();
    expect(w.claims).toHaveLength(1);
    w.tick(1);
    w.passes.current();
    // The server cannot hand one out yet (for example, the purchase is still settling).
    w.claims[1]?.answer(undefined);
    await flush();
    w.passes.current();
    expect(w.claims).toHaveLength(2);
    w.tick(BUYER_PASS_RETRY_MS);
    w.passes.current();
    w.claims[2]?.answer(PASS);
    await flush();
    expect(w.passes.current()).toBe(PASS);
    expect(w.claims).toHaveLength(3);
  });

  it("keeps sending a pass the disk refused, for as long as this process runs", async () => {
    const w = keeper({ diskFull: true });
    w.passes.current();
    w.claims[0]?.answer(PASS);
    await flush();
    expect(w.passes.current()).toBe(PASS);
    expect(w.stored()).toBeUndefined();
  });
});
