import { describe, expect, it } from "vitest";

import { CIRCULAR, MAX_REDACT_CHARS, REDACTED, TRUNCATED, redact, redactString } from "../src/index.js";

// Fake credentials are assembled from pieces so secret scanners do not flag this file.
const HEX = "4f".repeat(32);
const KEY = `0x${HEX}`;
const ANTHROPIC = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz"].join("-");
const GITHUB = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
const NPM = ["npm", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");
const JWT = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJlLXZhbHVlLWhlcmU"].join(".");
const RPC = ["https://arb-sepolia.g.alchemy.com/v2/", "abcdefghijklmnop1234"].join("");
const PG = ["postgres://lemma:", "s3cret", "@db.internal:5432/lemma"].join("");
const PEM = ["-----BEGIN EC PRIVATE", " KEY-----\nMHQCAQEE\n-----END EC PRIVATE", " KEY-----"].join("");
const WORDS = "test test test test test test test test test test test junk";

// Each env name from .env.example that holds a credential.
const ENV_NAMES = ["PROVIDER", "FACILITATOR", "EVALUATOR", "DEPLOYER", "BUYER"].map((r) => `${r}_PRIVATE_KEY`);

describe("redactString leaks nothing in the forms agents and tools print", () => {
  const leaks: Array<[string, string]> = [
    ...ENV_NAMES.flatMap((name): Array<[string, string]> => [
      [`env line ${name}`, `${name}=${KEY}`],
      [`env line without 0x ${name}`, `${name}=${HEX}`],
      [`export ${name}`, `export ${name}=${KEY}`],
      [`JSON ${name}`, JSON.stringify({ [name]: KEY })],
    ]),
    ["camelCase field", `buyerPrivateKey: ${KEY}`],
    ["quoted field", `"privateKey": "${KEY}"`],
    ["cast flag", `cast send --private-key ${KEY} 0xabc`],
    ["forge flag", `forge script Deploy --private-key=${KEY} --broadcast`],
    ["mnemonic env", `MNEMONIC="${WORDS}"`],
    ["mnemonic words", `mnemonic: ${WORDS}`],
    ["postgres password env", "POSTGRES_PASSWORD=hunter2hunter2"],
    ["api key env", ["CURSOR_API_KEY", "=", "key_abcdefghijklmnop"].join("")],
    ["npm token env", `NPM_TOKEN=${NPM}`],
    ["npmrc auth", `//registry.npmjs.org/:_authToken=${NPM}`],
    ["aws secret", ["AWS_SECRET_ACCESS_KEY", "=", "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"].join("")],
    ["x402 v2 header", `PAYMENT-SIGNATURE: ${JWT}`],
    ["x402 v1 header", `X-PAYMENT: ${JWT}`],
    ["basic auth", "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["bearer", "Authorization: Bearer abc.def.ghijklmnop"],
    ["cookie", "Cookie: session=abcdef123456; theme=dark"],
    ["anthropic key", ANTHROPIC],
    ["github token", GITHUB],
    ["jwt", JWT],
    ["alchemy url", RPC],
    ["infura ws", ["wss://mainnet.infura.io/ws/v3/", "abcdef0123456789abcdef"].join("")],
    ["query apikey", "https://api.example.com/v1/x?apikey=abcdef123456&x=1"],
    ["postgres url", PG],
    ["redis url without user", ["redis://:", "p4ssw0rdp4ss", "@cache.internal:6379"].join("")],
    ["pem", PEM],
    ["unterminated pem", PEM.split("\n")[0] + "\nMHQCAQEE"],
  ];

  it("is idempotent", () => {
    for (const [name, input] of leaks) {
      const once = redactString(input);
      expect(redactString(once), name).toBe(once);
      expect(once, name).not.toContain(`${REDACTED}]`);
    }
  });

  for (const [name, input] of leaks) {
    it(name, () => {
      const out = redactString(`before ${input} after`);
      expect(out).toContain(REDACTED);
      for (const secret of [HEX, "hunter2", "key_abcdefghijklmnop", NPM, "wJalrXUtnFEMIK7M", JWT, "dXNlcjpw", "abcdef123456", ANTHROPIC, GITHUB, "abcdefghijklmnop1234", "abcdef0123456789abcdef", "s3cret", "p4ssw0rdp4ss", "MHQCAQEE", "junk", "ghijklmnop"]) {
        expect(out, `${name} leaked ${secret}`).not.toContain(secret);
      }
    });
  }
});

describe("redactString keeps evidence", () => {
  it("keeps bare digests, hashes, token counters and ordinary text", () => {
    const text = [
      `payloadDigest=${KEY}`,
      `txHash: ${KEY}`,
      "inputTokens: 1200",
      "tokenLimit=5",
      "MAX_TOKENS=4096",
      "PUBLIC_BASE_URL=http://localhost:3000",
      "X-PAYMENT-RESPONSE: settled",
      "see https://sepolia.arbiscan.io/tx/abc",
      "npm test -- --run",
    ].join("\n");
    expect(redactString(text)).toBe(text);
  });

  it("keeps the label so the record stays readable", () => {
    expect(redactString(`BUYER_PRIVATE_KEY=${KEY}`)).toBe(`BUYER_PRIVATE_KEY=${REDACTED}`);
    expect(redactString(`"privateKey": "${KEY}"`)).toBe(`"privateKey": "${REDACTED}"`);
  });
});

describe("redactString performance", () => {
  const adversarial = ["a.", "a-", "a://a:", "a:", "Authorization: ", "privateKey=", "-----BEGIN RSA PRIVATE KEY-----", "x://", "eyJaaaaaaaa."];

  for (const unit of adversarial) {
    it(`stays linear on repeated ${JSON.stringify(unit)}`, () => {
      const input = unit.repeat(Math.ceil(MAX_REDACT_CHARS / unit.length));
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started).toBeLessThan(1500);
    });
  }

  it("truncates oversized input", () => {
    const out = redactString("x".repeat(MAX_REDACT_CHARS + 10));
    expect(out.endsWith(TRUNCATED)).toBe(true);
    expect(out.length).toBe(MAX_REDACT_CHARS + TRUNCATED.length);
  });
});

describe("redact (structured)", () => {
  it("replaces sensitive fields whole, at any depth", () => {
    const out = redact({
      BUYER_PRIVATE_KEY: KEY,
      nested: { apiKey: "abc", deeper: [{ password: "hunter2", DATABASE_URL: PG }] },
      token: "t",
      headers: { "PAYMENT-SIGNATURE": JWT, "X-PAYMENT": JWT },
      _meta: { "x402/payment": { payload: { signature: KEY } } },
    });
    expect(out).toEqual({
      BUYER_PRIVATE_KEY: REDACTED,
      nested: { apiKey: REDACTED, deeper: [{ password: REDACTED, DATABASE_URL: REDACTED }] },
      token: REDACTED,
      headers: { "PAYMENT-SIGNATURE": REDACTED, "X-PAYMENT": REDACTED },
      _meta: { "x402/payment": REDACTED },
    });
  });

  it("redacts the value of sensitive name/value pairs", () => {
    expect(redact([{ name: "BUYER_PRIVATE_KEY", value: KEY }, { name: "PORT", value: "3000" }])).toEqual([
      { name: "BUYER_PRIVATE_KEY", value: REDACTED },
      { name: "PORT", value: "3000" },
    ]);
  });

  it("scans free-text fields such as tool output", () => {
    expect(redact({ stdout: `BUYER_PRIVATE_KEY=${KEY}` })).toEqual({ stdout: `BUYER_PRIVATE_KEY=${REDACTED}` });
  });

  it("keeps digests, token counters and benign fields", () => {
    const record = { payloadDigest: KEY, txHash: KEY, inputTokens: 1200, tokenLimit: 5, seed: 42, key: "hono" };
    expect(redact(record)).toEqual(record);
  });

  it("handles cycles, shared references and huge graphs without blowing up", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ a: 1, self: CIRCULAR });

    const shared = { v: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });

    let dag: unknown = { leaf: true };
    for (let i = 0; i < 40; i++) dag = { l: dag, r: dag };
    const started = performance.now();
    expect(JSON.stringify(redact(dag))).toContain(TRUNCATED);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("keeps Errors, Dates, Maps and binary data readable", () => {
    const err = new Error(`failed with ${ANTHROPIC}`, { cause: { token: "t" } });
    const out = redact({ err, when: new Date(0), m: new Map([["apiKey", "x"]]), buf: new Uint8Array(8) }) as Record<string, any>;
    expect(out.err.name).toBe("Error");
    expect(out.err.message).toBe(`failed with ${REDACTED}`);
    expect(out.err.cause).toEqual({ token: REDACTED });
    expect(out.when).toBe("1970-01-01T00:00:00.000Z");
    expect(out.m).toEqual([["apiKey", REDACTED]]);
    expect(out.buf).toBe("[Binary 8 bytes]");
  });

  it("keeps a __proto__ field as data and does not mutate its input", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "secret": "x", "list": ["a"]}');
    const out = redact(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(input.secret).toBe("x");
  });
});
