import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Hex32, type PatchBundle, fileDigest } from "@lemma/core";
import { afterEach, describe, expect, it } from "vitest";

import { applyPlan, checkApply, journalDirFor, processStart, psStart, recoverJournals, takeJournal } from "../src/index.js";
import { ID, bundle, removeTemps, snapshot, start, temp, tree } from "./fixtures.js";

afterEach(removeTemps);

describe("checkApply", () => {
  it("plans a clean bundle and reports every drifted path without writing", () => {
    const root = tree(start);
    const check = checkApply(bundle, root);
    expect(check).toMatchObject({ ok: true, deletes: ["old.ts"] });
    const drifted = tree({ ...start, "run.sh": "echo changed\n", "src/lemma/b.ts": "exists\n" });
    const before = snapshot(drifted);
    expect(checkApply(bundle, drifted)).toEqual({ ok: false, drifted: ["run.sh", "src/lemma/b.ts"] });
    expect(snapshot(drifted)).toEqual(before);
  });

  it("treats a link anywhere on a path as drift", () => {
    const root = tree(start);
    const outside = temp("lemma-outside-");
    symlinkSync(outside, join(root, "src", "lemma"));
    expect(checkApply(bundle, root)).toEqual({ ok: false, drifted: ["src/lemma/a.ts", "src/lemma/b.ts"] });
  });
});

/** The bundle plus a deleted file in its own directory, which an install can take away so that the undo cannot put it back. */
const withLegacy: PatchBundle = {
  ...bundle,
  files: [...bundle.files, { path: "legacy/old.ts", op: "delete" as const, baseDigest: fileDigest("legacy\n"), content: null }].sort((a, b) => (a.path < b.path ? -1 : 1)),
};

/** A second resolution for the same repository: it adds one file. */
const OTHER = `0x${"cd".repeat(32)}` as Hex32;
const other: PatchBundle = { schemaVersion: "1", files: [{ path: "src/other.ts", op: "add", baseDigest: null, content: "export {};\n" }], dependencies: { zod: "4.6.5" }, devDependencies: {} };

type Options = Parameters<typeof applyPlan>[0];

/** A journal root for applies to `root` (the scope), with helpers to apply, stall an apply mid-install, fake a crash, and recover. */
function journalFor(root: string) {
  const journalRoot = temp("lemma-journal-");
  const recoveredRoot = temp("lemma-recovered-");
  const dir = journalDirFor(journalRoot, root);
  const apply = (over: Partial<Options> = {}) => applyPlan({ journalRoot, recoveredRoot, scope: root, resolutionId: ID, packageDir: root, bundle, manifests: [], install: async () => undefined, ...over });
  /** Starts an apply whose install never ends (after `during` runs in it), and waits until it is installing. */
  const stall = async (over: Partial<Options> & { during?: (onGroup: (pgid: number) => void) => void } = {}) => {
    let reached!: () => void;
    const installing = new Promise<void>((r) => (reached = r));
    const { during, ...options } = over;
    void apply({
      ...options,
      install: (onGroup) => {
        during?.(onGroup);
        reached();
        return new Promise<void>(() => undefined);
      },
    });
    await installing;
  };
  /** Makes the journal look like one a crashed bridge left: its owner is a process that no longer exists. */
  const crash = () => {
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...owner, pid: 2 ** 22 + 7, start: null }));
  };
  /** This process as the journal records it, with another pid and start time. */
  const identity = (pid: number, start: string | null) => {
    const { id: _, ...owner } = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as Record<string, unknown>;
    return { ...owner, pid, start };
  };
  const recover = () => recoverJournals(journalRoot, recoveredRoot);
  return { journalRoot, recoveredRoot, dir, apply, stall, crash, identity, recover };
}

describe("applyPlan", () => {
  it("writes everything, keeps a modified file's mode, and leaves no journal", async () => {
    const root = tree(start);
    chmodSync(join(root, "run.sh"), 0o755);
    const j = journalFor(root);
    let installed = 0;
    expect(await j.apply({ manifests: [join(root, "package.json")], install: async () => void installed++ })).toEqual({ ok: true });
    expect(installed).toBe(1);
    expect(snapshot(root)).toEqual({ "package.json": "{}\n", "run.sh": "echo 2\n", "src/": "dir", "src/keep.ts": "keep\n", "src/lemma/": "dir", "src/lemma/a.ts": "export const a = 1;\n", "src/lemma/b.ts": "export const b = 2;\n" });
    expect(statSync(join(root, "run.sh")).mode & 0o777).toBe(0o755);
    expect(readdirSync(j.journalRoot)).toEqual([]);
  });

  it("rolls everything back when the install fails, manifests included", async () => {
    const root = tree(start);
    const before = snapshot(root);
    const j = journalFor(root);
    const outcome = await j.apply({
      manifests: [join(root, "package.json"), join(root, "package-lock.json")],
      install: async () => {
        writeFileSync(join(root, "package.json"), '{"dependencies":{}}\n');
        writeFileSync(join(root, "package-lock.json"), "{}\n");
        throw new Error("network");
      },
    });
    // Both manifests the install changed are put back, and the answer says so.
    expect(outcome).toEqual({ ok: false, step: "install", error: "Error", undone: { restored: 4, left: 0, putBack: 2 } });
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(j.journalRoot)).toEqual([]);
  });

  it("rolls back when a write fails midway", async () => {
    const root = tree(start);
    const before = snapshot(root);
    const j = journalFor(root);
    const taken = takeJournal({ journalRoot: j.journalRoot, recoveredRoot: j.recoveredRoot, scope: root });
    if (taken.status !== "taken") throw new Error("expected the journal");
    const plan = checkApply(bundle, root);
    if (!plan.ok) throw new Error("expected a clean plan");
    // Appears after the plan: run.sh and a.ts are already in place when b.ts cannot be placed over a directory.
    mkdirSync(join(root, "src/lemma/b.ts"), { recursive: true });
    const outcome = await taken.apply({ resolutionId: ID, packageDir: root, plan, manifests: [], install: async () => undefined });
    expect(outcome).toEqual({ ok: false, step: "write", error: "EEXIST", undone: { restored: 2, left: 1, putBack: 0 } });
    rmSync(join(root, "src/lemma"), { recursive: true });
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(j.journalRoot)).toEqual([]);
  });

  it("checks the plan while holding the journal, and writes nothing to a package that no longer matches", async () => {
    const root = tree({ ...start, "run.sh": "echo changed\n" });
    const before = snapshot(root);
    const j = journalFor(root);
    expect(await j.apply()).toEqual({ ok: false, step: "drift", drifted: ["run.sh"] });
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(j.journalRoot)).toEqual([]);
  });

  it("stops before overwriting a file changed after the plan was checked, and never replaces a file that appeared", async () => {
    for (const change of ["modify", "add"] as const) {
      const root = tree(start);
      const j = journalFor(root);
      const taken = takeJournal({ journalRoot: j.journalRoot, recoveredRoot: j.recoveredRoot, scope: root });
      if (taken.status !== "taken") throw new Error("expected the journal");
      const plan = checkApply(bundle, root);
      if (!plan.ok) throw new Error("expected a clean plan");
      // An editor saves between the plan and the write.
      if (change === "modify") writeFileSync(join(root, "run.sh"), "echo mine\n");
      else {
        mkdirSync(join(root, "src/lemma"));
        writeFileSync(join(root, "src/lemma/a.ts"), "mine\n");
      }
      const outcome = await taken.apply({ resolutionId: ID, packageDir: root, plan, manifests: [], install: async () => undefined });
      expect(outcome).toMatchObject({ ok: false, step: "write", error: change === "modify" ? "CHANGED" : "EEXIST" });
      expect(readFileSync(join(root, change === "modify" ? "run.sh" : "src/lemma/a.ts"), "utf8")).toBe(change === "modify" ? "echo mine\n" : "mine\n");
      expect(readFileSync(join(root, "old.ts"), "utf8")).toBe("old\n");
    }
  });

  it("undoes an apply interrupted by a crash when the bridge starts again", async () => {
    const root = tree(start);
    const before = snapshot(root);
    const j = journalFor(root);
    await j.stall({ manifests: [join(root, "package.json")] });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
    // While the apply that holds it is alive, recovery leaves it alone.
    expect(j.recover()).toMatchObject({ recovered: 0, live: 1 });
    j.crash();
    expect(j.recover()).toEqual({ recovered: 1, kept: 0, live: 0, left: 0, putBack: 0 });
    expect(snapshot(root)).toEqual(before);
  });

  it("never removes an added file that something else has since changed", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    writeFileSync(join(root, "src/lemma/a.ts"), "edited by the user\n");
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 1, left: 1 });
    expect(readFileSync(join(root, "src/lemma/a.ts"), "utf8")).toBe("edited by the user\n");
    expect(existsSync(join(root, "src/lemma/b.ts"))).toBe(false);
  });

  it("never overwrites a modified or deleted file edited after the apply, and keeps the original", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    writeFileSync(join(root, "run.sh"), "echo mine\n");
    writeFileSync(join(root, "old.ts"), "recreated\n");
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 1, left: 2, putBack: 0 });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo mine\n");
    expect(readFileSync(join(root, "old.ts"), "utf8")).toBe("recreated\n");
    const [kept] = readdirSync(j.recoveredRoot);
    expect(readFileSync(join(j.recoveredRoot, kept as string, "files", "run.sh"), "utf8")).toBe("echo 1\n");
    expect(readFileSync(join(j.recoveredRoot, kept as string, "files", "old.ts"), "utf8")).toBe("old\n");
  });

  it("puts manifests back after an interrupted install, keeping and reporting what they held", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall({ manifests: [join(root, "package.json"), join(root, "package-lock.json")] });
    writeFileSync(join(root, "package.json"), '{"scripts":{"dev":"x"}}\n');
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 1, left: 0, putBack: 2 });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(root, "package-lock.json"))).toBe(false);
    const [kept] = readdirSync(j.recoveredRoot);
    expect(readFileSync(join(j.recoveredRoot, kept as string, "manifests", "0-package.json"), "utf8")).toBe('{"scripts":{"dev":"x"}}\n');
  });

  it("reports put-backs a rollback did before it crashed", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall({ manifests: [join(root, "package.json")] });
    j.crash();
    // A recovery put package.json back and saved that, then died.
    const journal = JSON.parse(readFileSync(join(j.dir, "journal.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(j.dir, "journal.json"), JSON.stringify({ ...journal, manifests: [], putBack: [join(root, "package.json")] }));
    expect(j.recover()).toMatchObject({ recovered: 1, putBack: 1 });
  });

  it("never leaves a restore's temporary file behind after a crash", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    j.crash();
    // A recovery died between writing run.sh's restore copy and renaming it into place.
    const leftover = join(root, `run.sh.lemma-restore-${ID.slice(2, 10)}-0.tmp`);
    writeFileSync(leftover, "echo 1\n");
    expect(j.recover()).toMatchObject({ recovered: 1 });
    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 1\n");
  });

  it("reports an undo it could not finish, and retries it first at the next apply in the repository", async () => {
    const root = tree({ ...start, "legacy/old.ts": "legacy\n" });
    const j = journalFor(root);
    const failed = await j.apply({
      bundle: withLegacy,
      install: async () => {
        // The deleted file's directory goes away, so the undo cannot put it back.
        rmSync(join(root, "legacy"), { recursive: true });
        throw new Error("network");
      },
    });
    expect(failed).toMatchObject({ ok: false, step: "rollback", undone: { restored: 4, left: 0, putBack: 0 } });
    // Another resolution in another repository is not held up by it.
    const elsewhere = tree({ "package.json": "{}\n" });
    expect(await applyPlan({ journalRoot: j.journalRoot, recoveredRoot: j.recoveredRoot, scope: elsewhere, resolutionId: OTHER, packageDir: elsewhere, bundle: other, manifests: [], install: async () => undefined })).toEqual({ ok: true });
    mkdirSync(join(root, "legacy"));
    // In this repository, any apply retries the undo first, says what it did, and writes nothing new.
    expect(await j.apply({ resolutionId: OTHER, bundle: other })).toEqual({ ok: false, step: "earlier", kept: false, undone: { restored: 1, left: 0, putBack: 0 } });
    expect(readFileSync(join(root, "legacy/old.ts"), "utf8")).toBe("legacy\n");
    expect(existsSync(join(root, "src/other.ts"))).toBe(false);
    expect(await j.apply({ bundle: withLegacy })).toEqual({ ok: true });
  });

  it("never repeats an undo step that was done: a retried undo leaves a manifest edited since as it is", async () => {
    const root = tree({ ...start, "legacy/old.ts": "legacy\n" });
    const j = journalFor(root);
    const failed = await j.apply({
      bundle: withLegacy,
      manifests: [join(root, "package.json")],
      install: async () => {
        writeFileSync(join(root, "package.json"), '{"dependencies":{"x":"1.0.0"}}\n');
        rmSync(join(root, "legacy"), { recursive: true });
        throw new Error("network");
      },
    });
    expect(failed).toMatchObject({ ok: false, step: "rollback", undone: { putBack: 1 } });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe("{}\n");
    // The user edits package.json and brings the directory back; the next apply retries only the step that failed.
    writeFileSync(join(root, "package.json"), '{"scripts":{"dev":"vite"}}\n');
    mkdirSync(join(root, "legacy"));
    expect(await j.apply({ bundle: withLegacy, manifests: [join(root, "package.json")] })).toMatchObject({ ok: false, step: "earlier", undone: { restored: 1, putBack: 0 } });
    expect(await j.apply({ bundle: withLegacy, manifests: [join(root, "package.json")] })).toEqual({ ok: true });
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe('{"scripts":{"dev":"vite"}}\n');
  });

  it("stops and reports it when undoing an earlier apply puts a manifest back over content written since", async () => {
    const root = tree(start);
    const j = journalFor(root);
    const failed = await j.apply({
      manifests: [join(root, "package.json")],
      install: async () => {
        // Left as a directory, which the undo cannot put a file over.
        rmSync(join(root, "package.json"));
        mkdirSync(join(root, "package.json"));
        writeFileSync(join(root, "package.json", "x"), "");
        throw new Error("network");
      },
    });
    expect(failed).toMatchObject({ ok: false, step: "rollback" });
    rmSync(join(root, "package.json"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"mine"}\n');
    expect(await j.apply({ manifests: [join(root, "package.json")] })).toEqual({ ok: false, step: "earlier", kept: false, undone: { restored: 0, left: 0, putBack: 1 } });
    // Nothing new was written; what the manifest held is kept.
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 1\n");
    const kept = readdirSync(j.recoveredRoot)
      .map((d) => join(j.recoveredRoot, d, "manifests", "0-package.json"))
      .filter((f) => existsSync(f));
    expect(kept.map((f) => readFileSync(f, "utf8"))).toEqual(['{"name":"mine"}\n']);
    expect(await j.apply({ manifests: [join(root, "package.json")] })).toEqual({ ok: true });
  });

  it("counts what a kept undo left or put back in the startup report", async () => {
    const root = tree({ ...start, "legacy/old.ts": "legacy\n" });
    const j = journalFor(root);
    await j.stall({
      bundle: withLegacy,
      manifests: [join(root, "package.json")],
      during: () => {
        writeFileSync(join(root, "package.json"), '{"dependencies":{"x":"1.0.0"}}\n');
        rmSync(join(root, "legacy"), { recursive: true });
      },
    });
    j.crash();
    expect(j.recover()).toEqual({ recovered: 0, kept: 1, live: 0, left: 0, putBack: 1 });
    // Kept for the next apply in its repository, not undone again at every start.
    expect(j.recover()).toEqual({ recovered: 0, kept: 1, live: 0, left: 0, putBack: 0 });
  });

  it("never signals an install it cannot identify, and keeps the journal instead of undoing under it", async () => {
    const root = tree(start);
    const j = journalFor(root);
    const { spawn } = await import("node:child_process");
    const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    stranger.unref();
    try {
      await j.stall({ during: (onGroup) => onGroup(stranger.pid as number) });
      // As on a system where the start time could not be read: the pid alone proves nothing.
      const journal = JSON.parse(readFileSync(join(j.dir, "journal.json"), "utf8")) as { install: Record<string, unknown> };
      writeFileSync(join(j.dir, "journal.json"), JSON.stringify({ ...journal, install: { ...journal.install, start: null } }));
      j.crash();
      expect(j.recover()).toMatchObject({ kept: 1, recovered: 0 });
      expect(() => process.kill(stranger.pid as number, 0)).not.toThrow();
      expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
    } finally {
      stranger.kill("SIGKILL");
    }
  });

  it("never kills a leaderless process group it cannot identify, and keeps the journal instead", async () => {
    const root = tree(start);
    const j = journalFor(root);
    const { spawn } = await import("node:child_process");
    // A group whose leader exits at once and leaves a member running, as an unrelated program's could after the install's group ended.
    const group = spawn("sh", ["-c", "sleep 30 & exit 0"], { detached: true, stdio: "ignore" });
    await new Promise((r) => group.on("exit", r));
    const pgid = group.pid as number;
    try {
      await j.stall({ during: (onGroup) => onGroup(pgid) });
      j.crash();
      expect(j.recover()).toMatchObject({ kept: 1, recovered: 0 });
      expect(() => process.kill(-pgid, 0)).not.toThrow();
      expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("kills a recorded install that outlived its bridge before undoing it", async () => {
    const root = tree(start);
    const j = journalFor(root);
    const { spawn } = await import("node:child_process");
    const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    orphan.unref();
    await j.stall({ during: (onGroup) => onGroup(orphan.pid as number) });
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 1 });
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(orphan.pid as number, 0)).toThrow();
  });

  it("finishes a recovery other bridges started and died in", async () => {
    const root = tree(start);
    const before = snapshot(root);
    const j = journalFor(root);
    await j.stall();
    for (const n of [1, 2]) {
      mkdirSync(join(j.dir, `claim.${n}`));
      writeFileSync(join(j.dir, `claim.${n}`, "holder.json"), JSON.stringify(j.identity(2 ** 22 + 8 + n, null)));
    }
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 1 });
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(j.journalRoot)).toEqual([]);
  });

  it("leaves a journal alone while another bridge's recovery holds it", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    // A live process (this one, as another bridge would be) holds a claim on it.
    mkdirSync(join(j.dir, "claim.1"));
    writeFileSync(join(j.dir, "claim.1", "holder.json"), JSON.stringify(j.identity(process.pid, processStart(process.pid))));
    j.crash();
    expect(j.recover()).toMatchObject({ recovered: 0, live: 1 });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
  });

  it("refuses a second apply in the repository while one is running, of any resolution", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    expect(await j.apply({ resolutionId: OTHER, bundle: other })).toEqual({ ok: false, step: "busy", error: "BUSY" });
    expect(existsSync(join(root, "src/other.ts"))).toBe(false);
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
  });

  it("keeps a journal it cannot read, and one bad journal never stops recovery of the others", () => {
    const journalRoot = temp("lemma-journal-");
    const bad = join(journalRoot, ID);
    mkdirSync(bad);
    writeFileSync(join(bad, "journal.json"), "{ not json");
    // A journal directory without a journal file had changed nothing yet.
    const empty = join(journalRoot, OTHER);
    mkdirSync(join(empty, "backup"), { recursive: true });
    expect(recoverJournals(journalRoot, temp("lemma-recovered-"))).toMatchObject({ kept: 1 });
    expect(existsSync(join(bad, "journal.json"))).toBe(true);
    expect(existsSync(empty)).toBe(false);
  });

  it("compares start times only when read the same way, and reads them the same in every time zone", async () => {
    expect(processStart(process.pid)).toMatch(/^(proc|ps):/);
    // ps is asked in UTC and the C locale, so bridges in different time zones read the same start time.
    const tz = process.env["TZ"];
    try {
      process.env["TZ"] = "Asia/Tokyo";
      const tokyo = psStart(process.pid);
      process.env["TZ"] = "America/New_York";
      expect(psStart(process.pid)).toBe(tokyo);
      expect(tokyo).toMatch(/^ps:/);
    } finally {
      if (tz === undefined) delete process.env["TZ"];
      else process.env["TZ"] = tz;
    }
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    // The owner is alive but was recorded by a reader of another kind: the start times cannot be compared, so the journal is left alone.
    const owner = JSON.parse(readFileSync(join(j.dir, "owner.json"), "utf8")) as { start: string };
    const proc = owner.start.startsWith("proc:");
    writeFileSync(join(j.dir, "owner.json"), JSON.stringify({ ...owner, start: proc ? "ps:Fri Sep 25 19:32:09 2026" : "proc:1" }));
    expect(j.recover()).toMatchObject({ live: 1, recovered: 0 });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 2\n");
    // Read the same way and different: another process was given the pid.
    writeFileSync(join(j.dir, "owner.json"), JSON.stringify({ ...owner, start: proc ? "proc:1" : "ps:Thu Jan 1 00:00:00 1970" }));
    expect(j.recover()).toMatchObject({ live: 0, recovered: 1 });
    expect(readFileSync(join(root, "run.sh"), "utf8")).toBe("echo 1\n");
  });

  it("judges an owner in other namespaces by its heartbeat, and one from another boot as gone", async () => {
    const root = tree(start);
    const j = journalFor(root);
    await j.stall();
    const owner = JSON.parse(readFileSync(join(j.dir, "owner.json"), "utf8")) as Record<string, unknown>;
    // Recorded in another pid namespace: its pid means nothing here, so its refreshed owner file is what counts.
    writeFileSync(join(j.dir, "owner.json"), JSON.stringify({ ...owner, pid: 1, ns: "pid:[1] time:[1]" }));
    expect(j.recover()).toMatchObject({ live: 1, recovered: 0 });
    const aMinuteAgo = new Date(Date.now() - 61_000);
    utimesSync(join(j.dir, "owner.json"), aMinuteAgo, aMinuteAgo);
    expect(j.recover()).toMatchObject({ live: 0, recovered: 1 });
    // From another boot, even this very pid is not the owner.
    await j.stall();
    const again = JSON.parse(readFileSync(join(j.dir, "owner.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(j.dir, "owner.json"), JSON.stringify({ ...again, boot: "another-boot" }));
    expect(j.recover()).toMatchObject({ live: 0, recovered: 1 });
  });

  it("never disturbs a live apply while other bridges recover at the same time", async () => {
    const dir = temp("lemma-race-");
    const journalRoot = join(dir, "journal");
    const src = join(process.cwd(), "apps/bridge/src/index.ts");
    const common = `import { applyPlan, recoverJournals } from ${JSON.stringify(src)};\nimport { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\n`;
    // Every apply uses the same scope, so all of them and the recoveries meet on one journal name.
    writeFileSync(
      join(dir, "applier.mts"),
      `${common}const bundle = ${JSON.stringify(bundle)};\nconst out = {};\nfor (let i = 0; i < 150; i++) {\n  const root = mkdtempSync(join(${JSON.stringify(dir)}, "ws-"));\n  for (const [p, c] of Object.entries(${JSON.stringify(start)})) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); }\n  const o = await applyPlan({ journalRoot: ${JSON.stringify(journalRoot)}, recoveredRoot: ${JSON.stringify(join(dir, "recovered"))}, scope: ${JSON.stringify(dir)}, resolutionId: ${JSON.stringify(ID)}, packageDir: root, bundle, manifests: [], install: async () => undefined });\n  const key = o.ok ? "ok" : o.step + ":" + (o.error ?? "");\n  out[key] = (out[key] ?? 0) + 1;\n}\nconsole.log(JSON.stringify(out));\n`,
    );
    writeFileSync(
      join(dir, "recoverer.mts"),
      `${common}const total = { recovered: 0, kept: 0, live: 0, left: 0, putBack: 0 };\nwhile (!existsSync(${JSON.stringify(join(dir, "stop"))})) {\n  const r = recoverJournals(${JSON.stringify(journalRoot)}, ${JSON.stringify(join(dir, "recovered"))});\n  for (const k of Object.keys(total)) total[k] += r[k];\n}\nconsole.log(JSON.stringify(total));\n`,
    );
    const { spawn } = await import("node:child_process");
    const run = (script: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", join(dir, script)], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.on("error", reject);
        child.on("close", () => resolve(out.trim()));
      });
    mkdirSync(journalRoot, { recursive: true });
    const recoverers = [run("recoverer.mts"), run("recoverer.mts")];
    const applied = JSON.parse(await run("applier.mts")) as Record<string, number>;
    writeFileSync(join(dir, "stop"), "");
    const recovered = (await Promise.all(recoverers)).map((r) => JSON.parse(r) as { recovered: number; kept: number });
    expect(applied).toEqual({ ok: 150 });
    expect(recovered.every((r) => r.recovered === 0 && r.kept === 0)).toBe(true);
  }, 60_000);
});
