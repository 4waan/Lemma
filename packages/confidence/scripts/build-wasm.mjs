// Rebuilds packages/confidence/wasm/lemma_confidence.wasm from
// contracts/stylus/confidence-wasm, reproducibly:
//
// - the toolchain pinned in contracts/stylus/rust-toolchain.toml (checked, and
//   RUSTUP_TOOLCHAIN is dropped so nothing overrides it);
// - `cargo build --locked --release`, whose profile sets panic = "abort", LTO,
//   one codegen unit and strip;
// - every absolute path remapped (the workspace and cargo's home), so the bytes do
//   not depend on where the repository or the crates live;
// - no inherited RUSTFLAGS, wrappers or profile overrides.
//
// `--check` builds into a fresh temporary target directory and fails when the
// result differs from the committed file by a single byte. CI runs it.
//
// The module must import nothing (no WASI, no host functions) and export the
// functions src/engine.ts calls.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const workspace = join(root, "contracts", "stylus");
const committed = join(root, "packages", "confidence", "wasm", "lemma_confidence.wasm");
const cargoHome = resolve(process.env["CARGO_HOME"] ?? join(homedir(), ".cargo"));
const check = process.argv.includes("--check");
// wasm-ld also exports the __data_end and __heap_base globals of every cdylib.
const EXPORTS = ["__data_end", "__heap_base", "lc_abi_version", "lc_confidence", "lc_decay", "lc_out", "lc_record", "memory"];

// Anything that could change what rustc emits is dropped from the inherited environment.
const UNSAFE_ENV = /^(RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTC_.*|RUSTUP_TOOLCHAIN|CARGO_(BUILD|PROFILE|TARGET|ENCODED|INCREMENTAL|UNSTABLE|CACHE)_?.*)$/;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !UNSAFE_ENV.test(key)));

const pinned = /^channel\s*=\s*"([^"]+)"/m.exec(readFileSync(join(workspace, "rust-toolchain.toml"), "utf8"))?.[1];
const rustc = execFileSync("rustc", ["--version"], { cwd: workspace, env, encoding: "utf8" }).trim();
if (pinned === undefined || !rustc.startsWith(`rustc ${pinned} `)) {
  console.error(`expected rustc ${pinned ?? "(no pinned channel)"} from contracts/stylus/rust-toolchain.toml, found: ${rustc}`);
  process.exit(1);
}

const targetDir = check ? mkdtempSync(join(tmpdir(), "lemma-confidence-wasm-")) : join(workspace, "target", "node-wasm");
try {
  execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "confidence-wasm", "--lib"], {
    cwd: workspace,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...env,
      CARGO_TARGET_DIR: targetDir,
      // CARGO_ENCODED_RUSTFLAGS separates flags with 0x1f, so paths with spaces stay whole.
      CARGO_ENCODED_RUSTFLAGS: [`--remap-path-prefix=${workspace}=/lemma/contracts/stylus`, `--remap-path-prefix=${cargoHome}=/cargo`].join("\x1f"),
    },
  });
  const built = readFileSync(join(targetDir, "wasm32-unknown-unknown", "release", "confidence_wasm.wasm"));
  const module = new WebAssembly.Module(built);
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module).map((e) => e.name).sort();
  if (imports.length > 0) throw new Error(`the module must import nothing, found ${imports.map((i) => `${i.module}.${i.name}`).join(", ")}`);
  if (JSON.stringify(exports) !== JSON.stringify(EXPORTS)) throw new Error(`unexpected exports: ${exports.join(", ")}`);
  if (built.includes(Buffer.from(root)) || built.includes(Buffer.from(cargoHome))) throw new Error("an absolute build path leaked into the module");

  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (check) {
    const current = existsSync(committed) ? readFileSync(committed) : Buffer.alloc(0);
    if (!current.equals(built)) {
      console.error(`packages/confidence/wasm/lemma_confidence.wasm differs from a clean rebuild:\n  committed ${sha(current)} (${current.length} bytes)\n  rebuilt   ${sha(built)} (${built.length} bytes)\nRun npm run confidence:wasm with ${rustc} and commit the result.`);
      process.exit(1);
    }
    console.log(`lemma_confidence.wasm rebuilds byte for byte: sha256 ${sha(built)}, ${built.length} bytes, ${rustc}`);
  } else {
    copyFileSync(join(targetDir, "wasm32-unknown-unknown", "release", "confidence_wasm.wasm"), committed);
    console.log(`wrote packages/confidence/wasm/lemma_confidence.wasm: sha256 ${sha(built)}, ${built.length} bytes, ${rustc}`);
  }
} finally {
  if (check) rmSync(targetDir, { recursive: true, force: true });
}
