// Offline stand-in for the size part of `cargo stylus check`, which needs an
// Arbitrum RPC endpoint. It reads the contract wasm built with the Stylus release
// profile:
//
//   cargo build --locked --release --target wasm32-unknown-unknown -p confidence-contract --lib
//
// strips custom sections as cargo stylus does, compresses with brotli at quality 11
// (cargo stylus's level), and checks what can be checked without a chain: every
// import comes from the Stylus host (`vm_hooks`), the `user_entrypoint` export
// exists, the compressed code fits, and no instruction or value type is floating
// point or SIMD (the engine is integer-only). Over 24 KiB, cargo stylus splits a
// program into fragments (ArbOS 61); over 96 KiB it cannot be deployed at all. The
// real activation check (`cargo stylus check --endpoint ...`) still runs before deploy.
//
// Usage: node contracts/stylus/scripts/contract-size.mjs [path/to/contract.wasm]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

const FRAGMENT_LIMIT = 24 * 1024;
const PROGRAM_LIMIT = 96 * 1024;
const UNCOMPRESSED_LIMIT = 256 * 1024;

/** The module without custom sections (id 0): names, producers and target features. */
function stripCustomSections(bytes) {
  const kept = [bytes.subarray(0, 8)];
  let at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    let size = 0;
    let shift = 0;
    let cursor = at + 1;
    let byte;
    do {
      byte = bytes[cursor++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    const end = cursor + size;
    if (id !== 0) kept.push(bytes.subarray(at, end));
    at = end;
  }
  return Buffer.concat(kept);
}

// ---- Floating point and SIMD ------------------------------------------------------
//
// Every instruction of every function body and global initializer is decoded far
// enough to see floating-point or SIMD use: the MVP, sign extension, saturating
// truncation, bulk memory, multi-value blocks and reference types. Anything else
// (SIMD, atomics, exceptions, tail calls, an unknown encoding) and any body that does
// not decode to exactly its declared end is reported, never skipped.

const VALUE_TYPES = new Map([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
  [0x7b, "v128"],
  [0x70, "funcref"],
  [0x6f, "externref"],
]);
const NOT_INTEGER = new Set(["f32", "f64", "v128"]);
const FLOAT_MEMORY = new Map([
  [0x2a, "f32.load"],
  [0x2b, "f64.load"],
  [0x38, "f32.store"],
  [0x39, "f64.store"],
]);
// f32/f64 comparisons, arithmetic, conversions to and from floats, and reinterpretations.
const isFloatNumeric = (op) => (op >= 0x5b && op <= 0x66) || (op >= 0x8b && op <= 0xa6) || (op >= 0xa8 && op <= 0xab) || (op >= 0xae && op <= 0xbf);
const hex = (n) => `0x${n.toString(16).padStart(2, "0")}`;

class Reader {
  constructor(bytes, at, end) {
    this.bytes = bytes;
    this.at = at;
    this.end = end;
  }
  byte() {
    if (this.at >= this.end) throw new Error(`unexpected end at ${hex(this.at)}`);
    return this.bytes[this.at++];
  }
  u32() {
    let value = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return value;
  }
  skipLeb() {
    while (this.byte() & 0x80);
  }
  skip(count) {
    if (this.at + count > this.end) throw new Error(`unexpected end at ${hex(this.at)}`);
    this.at += count;
  }
}

/** Scans one module; returns the problems found and how many instructions were decoded. */
function floatUse(bytes) {
  const problems = [];
  let instructions = 0;
  const valueType = (code, where) => {
    const name = VALUE_TYPES.get(code);
    if (name === undefined) throw new Error(`${where}: unknown value type ${hex(code)}`);
    if (NOT_INTEGER.has(name)) problems.push(`${where}: ${name} value type`);
  };

  // An expression up to its closing `end`; `where` names the function or global.
  const expression = (r, where) => {
    let depth = 0;
    for (;;) {
      const at = r.at;
      const op = r.byte();
      instructions++;
      const found = (what) => problems.push(`${where} at ${hex(at)}: ${what}`);
      if (op === 0x0b) {
        if (depth === 0) return;
        depth--;
      } else if (op === 0x02 || op === 0x03 || op === 0x04) {
        depth++;
        const first = r.bytes[r.at];
        // 0x40 is an empty block type, 0x41..0x7f a single value type; anything else a type index (s33, non-negative).
        if (first !== undefined && first >= 0x40 && first < 0x80) {
          r.byte();
          if (first !== 0x40) valueType(first, `${where} at ${hex(at)}`);
        } else r.skipLeb();
      } else if ([0x00, 0x01, 0x05, 0x0f, 0x1a, 0x1b, 0xd1].includes(op) || (op >= 0x45 && op <= 0xc4)) {
        if (isFloatNumeric(op)) found(`floating-point instruction ${hex(op)}`);
      } else if ([0x0c, 0x0d, 0x10, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x3f, 0x40, 0xd2].includes(op)) {
        r.u32();
      } else if (op === 0x0e) {
        for (let n = r.u32(); n > 0; n--) r.u32();
        r.u32();
      } else if (op === 0x11) {
        r.u32();
        r.u32();
      } else if (op === 0x1c) {
        for (let n = r.u32(); n > 0; n--) valueType(r.byte(), `${where} at ${hex(at)}`);
      } else if (op >= 0x28 && op <= 0x3e) {
        if (FLOAT_MEMORY.has(op)) found(FLOAT_MEMORY.get(op));
        // memarg: alignment (bit 6 announces a memory index), then the offset.
        if (r.u32() & 0x40) r.u32();
        r.skipLeb();
      } else if (op === 0x41 || op === 0x42) {
        r.skipLeb();
      } else if (op === 0x43 || op === 0x44) {
        found(op === 0x43 ? "f32.const" : "f64.const");
        r.skip(op === 0x43 ? 4 : 8);
      } else if (op === 0xd0) {
        valueType(r.byte(), `${where} at ${hex(at)}`);
      } else if (op === 0xfc) {
        const sub = r.u32();
        if (sub <= 7) found(`saturating float-to-int truncation 0xfc ${sub}`);
        else if ([8, 10, 12, 14].includes(sub)) {
          r.u32();
          r.u32();
        } else if ([9, 11, 13, 15, 16, 17].includes(sub)) r.u32();
        else throw new Error(`${where} at ${hex(at)}: unknown instruction 0xfc ${sub}`);
      } else if (op === 0xfd) {
        // Every SIMD instruction is out, and its immediates are not decoded: stop at the first.
        throw new Error(`${where} at ${hex(at)}: SIMD instruction`);
      } else {
        throw new Error(`${where} at ${hex(at)}: unknown instruction ${hex(op)}`);
      }
    }
  };

  let importedFunctions = 0;
  let at = 8;
  while (at < bytes.length) {
    const header = new Reader(bytes, at + 1, bytes.length);
    const id = bytes[at];
    const size = header.u32();
    const r = new Reader(bytes, header.at, header.at + size);
    try {
      if (id === 1) {
        for (let n = r.u32(), t = 0; t < n; t++) {
          const form = r.byte();
          if (form !== 0x60) throw new Error(`type ${t}: unknown form ${hex(form)}`);
          for (const part of ["param", "result"]) {
            for (let k = r.u32(); k > 0; k--) valueType(r.byte(), `type ${t} ${part}`);
          }
        }
      } else if (id === 2) {
        for (let n = r.u32(), i = 0; i < n; i++) {
          r.skip(r.u32());
          r.skip(r.u32());
          const kind = r.byte();
          if (kind === 0) {
            r.u32();
            importedFunctions++;
          } else if (kind === 1 || kind === 2) {
            if (kind === 1) valueType(r.byte(), `import ${i} table`);
            const flags = r.byte();
            r.skipLeb();
            if (flags & 1) r.skipLeb();
          } else if (kind === 3) {
            valueType(r.byte(), `import ${i} global`);
            r.byte();
          } else throw new Error(`import ${i}: unknown kind ${hex(kind)}`);
        }
      } else if (id === 6) {
        for (let n = r.u32(), g = 0; g < n; g++) {
          valueType(r.byte(), `global ${g}`);
          r.byte();
          expression(r, `global ${g}`);
        }
      } else if (id === 10) {
        for (let n = r.u32(), f = 0; f < n; f++) {
          const where = `function ${importedFunctions + f}`;
          const bodySize = r.u32();
          const body = new Reader(bytes, r.at, r.at + bodySize);
          for (let groups = body.u32(); groups > 0; groups--) {
            body.u32();
            valueType(body.byte(), `${where} local`);
          }
          expression(body, where);
          if (body.at !== body.end) throw new Error(`${where}: decoding stopped at ${hex(body.at)}, before the body's end ${hex(body.end)}`);
          r.skip(bodySize);
        }
      }
    } catch (error) {
      problems.push(`section ${id}: ${error.message}`);
    }
    at = header.at + size;
  }
  return { problems, instructions };
}

// The scan must find every float in a module that has them: two functions, one taking
// an f64 and truncating it, one pushing an f32 constant and truncating it saturating.
const CANARY = Uint8Array.from([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x0a, 0x02, 0x60, 0x01, 0x7c, 0x01, 0x7e, 0x60, 0x00, 0x01, 0x7f, 0x03, 0x03, 0x02, 0x00, 0x01, 0x0a,
  0x11, 0x02, 0x05, 0x00, 0x20, 0x00, 0xb0, 0x0b, 0x09, 0x00, 0x43, 0x00, 0x00, 0xc0, 0x3f, 0xfc, 0x00, 0x0b,
]);
new WebAssembly.Module(CANARY);
const canary = floatUse(CANARY);
const expected = ["type 0 param: f64 value type", "function 0 at 0x20: floating-point instruction 0xb0", "function 1 at 0x24: f32.const", "function 1 at 0x29: saturating float-to-int truncation 0xfc 0"];
if (JSON.stringify(canary.problems) !== JSON.stringify(expected) || canary.instructions !== 6) {
  console.error(`the float scan misses floats in its canary module: ${JSON.stringify(canary)}`);
  process.exit(1);
}

// ---- The contract -----------------------------------------------------------------

const path = process.argv[2] ?? fileURLToPath(new URL("../target/wasm32-unknown-unknown/release/confidence_contract.wasm", import.meta.url));
const raw = readFileSync(path);
const stripped = stripCustomSections(raw);
const compressed = brotliCompressSync(stripped, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22 } });
const module = new WebAssembly.Module(stripped);
const foreign = WebAssembly.Module.imports(module).filter((i) => i.module !== "vm_hooks");
const entry = WebAssembly.Module.exports(module).some((e) => e.name === "user_entrypoint" && e.kind === "function");
const floats = floatUse(stripped);

const report = { wasmBytes: stripped.length, brotli11Bytes: compressed.length, fragments: Math.ceil(compressed.length / FRAGMENT_LIMIT), instructions: floats.instructions };
console.log(JSON.stringify(report));
const problems = [];
if (foreign.length > 0) problems.push(`imports outside vm_hooks: ${foreign.map((i) => `${i.module}.${i.name}`).join(", ")}`);
if (!entry) problems.push("no user_entrypoint export");
if (stripped.length > UNCOMPRESSED_LIMIT) problems.push(`the wasm is ${stripped.length} bytes, over the ${UNCOMPRESSED_LIMIT}-byte limit`);
if (compressed.length > PROGRAM_LIMIT) problems.push(`compressed to ${compressed.length} bytes, over the ${PROGRAM_LIMIT}-byte program limit`);
if (floats.problems.length > 0) problems.push(`floating point or SIMD (or code the scan cannot decode):\n  ${floats.problems.slice(0, 20).join("\n  ")}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
if (compressed.length > FRAGMENT_LIMIT) console.warn(`compressed code is over ${FRAGMENT_LIMIT} bytes: cargo stylus will deploy it in ${report.fragments} fragments`);
