/**
 * Removes credentials from values before they reach logs, run records,
 * receipts, or error messages. This is a denylist and therefore best effort:
 * records meant for publication should also be built from an allowlist of fields.
 *
 * Digests and transaction hashes look like private keys, so bare 32-byte hex is
 * kept. It is removed when a label names it as a key (`BUYER_PRIVATE_KEY=0x..`,
 * `--private-key 0x..`, `privateKey: 0x..`) or when it sits under a sensitive
 * field name. Every pattern is bounded, and input longer than
 * `MAX_REDACT_CHARS` is truncated, so scanning stays linear in the input.
 */
export const REDACTED = "[REDACTED]";
export const CIRCULAR = "[Circular]";
export const TRUNCATED = "[Truncated]";
export const MAX_REDACT_CHARS = 256 * 1024;

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;

const SENSITIVE_KEY_SUFFIXES = [
  "privatekey",
  "privatekeys",
  "secretkey",
  "signingkey",
  "apikey",
  "accesskey",
  "clientsecret",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "mnemonic",
  "seedphrase",
  "recoveryphrase",
  "authorization",
  "cookie",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "idtoken",
  "credential",
  "credentials",
  "databaseurl",
  "rpcurl",
  // x402: HTTP headers PAYMENT-SIGNATURE and X-PAYMENT, and the MCP _meta key "x402/payment".
  "paymentsignature",
  "xpayment",
];

const SENSITIVE_KEYS_EXACT = new Set(["token"]);

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, "");
  return SENSITIVE_KEYS_EXACT.has(k) || SENSITIVE_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

// A labeled value: quoted, or a bare run up to whitespace, a quote or a delimiter.
// Values already replaced by an earlier rule are skipped, so redaction is idempotent.
const FRESH = String.raw`(?!\[REDACTED\])`;
const VALUE = FRESH + String.raw`("[^"\r\n]{0,4096}"|'[^'\r\n]{0,4096}'|[^\s"'\x60,;&}\]\\]{1,4096})`;
const SEP = String.raw`\\?["']?[ \t]{0,8}[=:][ \t]{0,8}\\?`;

type Replacer = string | ((substring: string, ...groups: string[]) => string);

const keepLabel: Replacer = (_m, label = "", value = "") => {
  const q = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
  return `${label}${q}${REDACTED}${q}`;
};
const labelOnly: Replacer = (_m, label = "") => `${label}${REDACTED}`;

const RULES: ReadonlyArray<readonly [RegExp, Replacer]> = [
  // PEM private keys; an unterminated block is redacted to the end of the string.
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----|[\s\S]*$)/g, REDACTED],
  // Environment lines whose name contains a credential word as one of its segments:
  // BUYER_PRIVATE_KEY=.., export NPM_TOKEN=.., POSTGRES_PASSWORD=.., CURSOR_API_KEY=.. (MAX_TOKENS=.. is kept).
  [
    /^([ \t]{0,16}(?:export[ \t]{1,8})?(?:[A-Za-z0-9]{1,32}_){0,8}(?:PRIVATE_KEYS?|SECRET_KEY|SECRET|API_KEY|ACCESS_KEY|SIGNING_KEY|AUTH_TOKEN|ACCESS_TOKEN|TOKEN|PASSWORD|PASSPHRASE|MNEMONIC|CREDENTIALS?|DATABASE_URL|RPC_URL|PAT)(?:_[A-Za-z0-9]{1,32}){0,8}[ \t]{0,8}=[ \t]{0,8})\S.{0,8191}$/gim,
    labelOnly,
  ],
  // Credential headers: x402 payment payloads, Authorization (optional scheme), cookies.
  [
    /(?<![A-Za-z0-9-])((?:payment-signature|x-payment|proxy-authorization|authorization)["']?[ \t]{0,8}:[ \t]{0,8}["']?)(?!\[REDACTED\])(?:[A-Za-z][A-Za-z0-9-]{0,20}[ \t]{1,8})?[^\s"'\\]{1,8192}/gi,
    labelOnly,
  ],
  [/(?<![A-Za-z0-9-])((?:set-cookie|cookie)["']?[ \t]{0,8}:[ \t]{0,8})(?![ \t]|\[REDACTED\])[^\r\n"'\\]{1,8192}/gi, labelOnly],
  // Mnemonic phrases (12 to 24 lowercase words) after a label.
  [
    /((?:mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase)[A-Za-z0-9_]{0,32}\\?["']?[ \t]{0,8}[=:][ \t]{0,8}\\?["']?)[a-z]{1,16}(?:[ \t]{1,4}[a-z]{1,16}){11,23}/gi,
    labelOnly,
  ],
  // CLI flags: --private-key 0x.., --password=.., --mnemonic "..".
  [
    new RegExp(String.raw`(--?[A-Za-z0-9-]{0,32}(?:private-keys?|mnemonic|password|passphrase|api-key|secret|token)(?:[ \t]{0,8}=[ \t]{0,8}|[ \t]{1,8}))` + VALUE, "gi"),
    keepLabel,
  ],
  // Strong labels anywhere in an identifier (BUYER_PRIVATE_KEY, buyerPrivateKey, "privateKey"), optionally
  // followed by more identifier characters (SECRET_KEY_BASE, privateKeyHex).
  [
    new RegExp(
      String.raw`((?:private[_-]?keys?|privkey|secret[_-]?key|signing[_-]?key|api[_-]?key|access[_-]?key|client[_-]?secret|mnemonic|password|passwd|passphrase)[A-Za-z0-9_]{0,32}` + SEP + ")" + VALUE,
      "gi",
    ),
    keepLabel,
  ],
  // Weak labels only when they end the name, which keeps `inputTokens: 1200` and `tokenLimit=5`.
  [new RegExp(String.raw`((?:secret|token|credentials?|database[_-]?url|rpc[_-]?url)` + SEP + ")" + VALUE, "gi"), keepLabel],
  // Query-string credentials.
  [/([?&](?:api[_-]?key|apikey|key|dkey|token|access[_-]?token|auth|sig|signature|secret|password)=)(?!\[REDACTED\])[^&#\s"']{1,4096}/gi, labelOnly],
  // Provider token shapes.
  [/\bsk-ant-[A-Za-z0-9_-]{8,512}/g, REDACTED],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,512}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,255}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,64}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,255}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g, REDACTED],
  [/\bBearer[ \t]{1,8}[A-Za-z0-9._~+/=-]{8,4096}/gi, REDACTED],
  [/\b(?:alchemy\.com\/v2\/|alch_)[A-Za-z0-9_-]{16,128}/g, REDACTED],
  [/\b(?:infura\.io|quiknode\.pro|chainstack\.com|blastapi\.io|ankr\.com|getblock\.io)\/(?:ws\/)?(?:v[0-9]\/)?[A-Za-z0-9_-]{16,128}/g, REDACTED],
  // URL userinfo (empty user allowed). Only the first character of a scheme-like run may start a match,
  // which keeps the scan linear.
  [/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{0,256}:[^\s/@]{1,256}@/gi, REDACTED],
];

export function redactString(value: string): string {
  let out = value.length > MAX_REDACT_CHARS ? `${value.slice(0, MAX_REDACT_CHARS)}${TRUNCATED}` : value;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  return out;
}

function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, so a "__proto__" key stays data instead of replacing the prototype.
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * Returns a redacted, JSON-friendly deep copy. Sensitive fields and the `value`
 * of sensitive name/value pairs are replaced whole, other strings are scanned,
 * Dates become ISO strings, Errors keep name, message, stack and cause, binary
 * data is summarized, and cycles and oversized inputs are cut off.
 */
export function redact(value: unknown): unknown {
  const ancestors = new WeakSet<object>();
  let budget = MAX_NODES;

  const walk = (v: unknown, depth: number): unknown => {
    if (--budget < 0) return TRUNCATED;
    if (typeof v === "string") return redactString(v);
    if (typeof v === "bigint") return v.toString();
    if (typeof v !== "object" || v === null) return v;
    if (depth > MAX_DEPTH) return TRUNCATED;
    if (ancestors.has(v)) return CIRCULAR;
    ancestors.add(v);
    try {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
      if (ArrayBuffer.isView(v)) return `[Binary ${v.byteLength} bytes]`;
      if (v instanceof ArrayBuffer) return `[Binary ${v.byteLength} bytes]`;
      if (v instanceof Map) {
        return [...v.entries()].map(([k, item]) => [walk(k, depth + 1), isSensitiveKey(String(k)) && item != null ? REDACTED : walk(item, depth + 1)]);
      }
      if (v instanceof Set) return [...v].map((item) => walk(item, depth + 1));
      if (Array.isArray(v)) return v.map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      if (v instanceof Error) {
        setOwn(out, "name", v.name);
        setOwn(out, "message", redactString(v.message));
        if (v.stack) setOwn(out, "stack", redactString(v.stack));
        if (v.cause !== undefined) setOwn(out, "cause", walk(v.cause, depth + 1));
      }
      const entries = Object.entries(v);
      // { name: "BUYER_PRIVATE_KEY", value: "0x.." } and { key: "apiKey", value: ".." } pairs.
      const pairName = entries.find(([k, item]) => (k === "name" || k === "key") && typeof item === "string")?.[1];
      const sensitivePair = typeof pairName === "string" && isSensitiveKey(pairName);
      for (const [key, item] of entries) {
        const hide = item !== null && item !== undefined && (isSensitiveKey(key) || (sensitivePair && key === "value"));
        setOwn(out, key, hide ? REDACTED : walk(item, depth + 1));
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };

  return walk(value, 0);
}
