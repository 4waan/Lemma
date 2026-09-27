import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import type { Readable } from "node:stream";

import { commandDir } from "./acceptance.js";

/** The tools a confined acceptance run uses, each by absolute path, found on the bridge's PATH and where systems keep them. */
export interface ConfineTools {
  readonly unshare: string;
  readonly sh: string;
  readonly mount: string;
  /** Only for offline runs (loopback up); often in /usr/sbin or /sbin. */
  readonly ip: string | undefined;
}

/** The confinement tools on this system, or undefined when one it always needs is missing. */
export function confineTools(searchPath: string = process.env["PATH"] ?? ""): ConfineTools | undefined {
  const find = (name: string) => {
    const dir = commandDir(name, [searchPath, "/usr/sbin", "/sbin", "/usr/bin", "/bin"].join(delimiter));
    return dir === undefined ? undefined : join(dir, name);
  };
  const [unshare, sh, mount] = [find("unshare"), find("sh"), find("mount")];
  return unshare === undefined || sh === undefined || mount === undefined ? undefined : { unshare, sh, mount, ip: find("ip") };
}

/**
 * The shell step a confined run runs as PID 1 of its new user, mount and PID
 * namespaces (with a fresh /proc, so no process outside is visible):
 *
 * 1. an empty tmpfs over each hidden directory;
 * 2. a trial of the nested user and mount namespace the command will run in;
 * 3. "m" on fd 3; offline, loopback up and "n";
 * 4. the command looked up, "x", fd 3 closed, and the command run inside a
 *    nested user and mount namespace. Mounts inherited into a namespace owned
 *    by a less privileged user namespace are locked, so the tests (root there,
 *    with no power over the outer namespace) cannot unmount a tmpfs to see
 *    what it hides.
 *
 * A run that never reported "x" never started: its exit code is the
 * wrapper's (125 for the namespace or a mount, 127 for the command), never a
 * test result. Every path and the argv are arguments (`$0`, `"$@"`), never
 * shell text.
 */
const CONFINED_SCRIPT = [
  'm="$0"; u="$1"; ip="$2"; n="$3"; shift 3',
  'while [ "$n" -gt 0 ]; do "$m" -t tmpfs -o size=4k,mode=0 lemma-hidden "$1" || exit 125; shift; n=$((n-1)); done',
  '"$u" --map-root-user --mount true || exit 125',
  "printf m >&3",
  'if [ -n "$ip" ]; then "$ip" link set lo up || exit 125; printf n >&3; fi',
  'command -v "$1" >/dev/null || exit 127',
  "printf x >&3; exec 3>&-",
  'exec "$u" --map-root-user --mount -- "$@"',
].join("\n");

/**
 * The argv a confined run starts: new user, mount and PID namespaces (and a
 * network namespace when `offline`), with `hide` covered, then `argv`. The
 * PID namespace ends with its first process, so nothing the tests start
 * outlives them. `offline` needs `tools.ip`.
 */
export function confinedArgv(argv: readonly string[], tools: ConfineTools, options: { readonly hide: readonly string[]; readonly offline: boolean }): string[] {
  if (options.offline && tools.ip === undefined) throw new Error("offline confinement needs the ip tool");
  return [
    tools.unshare,
    "--map-root-user",
    "--mount",
    "--pid",
    "--fork",
    "--kill-child",
    "--mount-proc",
    ...(options.offline ? ["--net"] : []),
    tools.sh,
    "-c",
    CONFINED_SCRIPT,
    tools.mount,
    tools.unshare,
    options.offline ? (tools.ip as string) : "",
    String(options.hide.length),
    ...options.hide,
    ...argv,
  ];
}

/** Why a confined wrapper that never reported "x" did not start the command. */
export function confinedNotStarted(marks: string, offline: boolean): "confinement-failed" | "offline-unavailable" | "command-not-found" {
  if (!marks.includes("m")) return "confinement-failed";
  if (offline && !marks.includes("n")) return "offline-unavailable";
  return "command-not-found";
}

/**
 * The directories an acceptance run in `cwd` should not see, as absolute
 * paths to mount over: each of `dirs` that is an existing directory, except
 * any that holds `cwd` (covering it would take the package away from its own
 * tests) and any inside another one (already covered, and gone once it is).
 */
export function hiddenDirs(dirs: readonly string[], cwd: string): string[] {
  const inside = (dir: string, parent: string) => {
    const rel = relative(parent, dir);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const candidates = [...new Set(dirs.map((d) => resolve(d)))].filter((dir) => isDirectory(dir) && !inside(resolve(cwd), dir));
  return candidates.filter((dir) => !candidates.some((other) => other !== dir && inside(dir, other)));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const probes = new Map<string, Promise<boolean>>();

/**
 * Whether confined runs work here: Linux, the tools, and a trial run that
 * hides a directory and finds it empty. Asynchronous, so the trial never
 * holds up the bridge, and checked once per set of tools.
 */
export function confinementAvailable(tools: ConfineTools | undefined = confineTools()): Promise<boolean> {
  if (process.platform !== "linux" || tools === undefined) return Promise.resolve(false);
  const key = `${tools.unshare}\0${tools.sh}\0${tools.mount}`;
  let probe = probes.get(key);
  if (probe === undefined) {
    probe = confinementProbe(tools);
    probes.set(key, probe);
  }
  return probe;
}

async function confinementProbe(tools: ConfineTools): Promise<boolean> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "lemma-confine-"));
    await writeFile(join(dir, "visible"), "");
    const check = `process.exit(require("fs").existsSync(${JSON.stringify(join(dir, "visible"))})?1:0)`;
    const [file, ...args] = confinedArgv([process.execPath, "-e", check], tools, { hide: [dir], offline: false });
    return await new Promise<boolean>((resolve) => {
      const child = spawn(file as string, args, { stdio: ["ignore", "ignore", "ignore", "pipe"], timeout: 10_000, killSignal: "SIGKILL" });
      let marks = "";
      (child.stdio[3] as Readable | null | undefined)?.on("data", (chunk: Buffer) => (marks += chunk.toString()));
      child.once("error", () => resolve(false));
      child.once("close", (code) => resolve(code === 0 && marks === "mx"));
    });
  } catch {
    return false;
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
