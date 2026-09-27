import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ARBITRUM_SEPOLIA,
  ARBITRUM_SEPOLIA_USDC,
  type AdoptionReceipt,
  type Hex32,
  type SpendingPolicy,
  USDC_EIP712_DOMAIN,
  adoptionReceiptTypedData,
  toAddress,
} from "@lemma/core";
import { authorizationTypes } from "@x402/evm";
import { getAddress, recoverTypedDataAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";

import {
  KeyFileError,
  LedgerError,
  LocalSigner,
  SignerRefusal,
  SignerUnavailable,
  SocketSigner,
  SpendLedger,
  initKeyFile,
  readKeyFile,
  defaultSignerSocket,
  serveSigner,
  signerPaths,
  signerSocketMode,
  spendingPolicyFromEnv,
} from "../src/index.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const PAYEE = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000b2";

const temps: string[] = [];
const temp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const policy: SpendingPolicy = {
  schemaVersion: "1",
  network: ARBITRUM_SEPOLIA,
  asset: ARBITRUM_SEPOLIA_USDC,
  allowedPayTo: [PAYEE],
  maxPerResolutionUsdc: "300000",
  dailyCapUsdc: "500000",
  maxAuthorizationSeconds: 600,
};

const nonce = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
const auth = (over: Partial<{ to: string; value: string; validBefore: string; nonce: Hex32 }> = {}) => ({
  to: PAYEE,
  value: "250000",
  validAfter: "0" as const,
  validBefore: String(NOW_S + 300),
  nonce: nonce(1),
  ...over,
});

function localSigner(p: SpendingPolicy = policy, clock = () => NOW) {
  const account = privateKeyToAccount(generatePrivateKey());
  const ledger = new SpendLedger(temp("lemma-signer-ledger-"));
  return { account, ledger, signer: new LocalSigner(account, p, ledger, clock) };
}

const refusal = async (p: Promise<unknown>) =>
  p.then(
    () => "signed",
    (e: unknown) => (e instanceof SignerRefusal ? e.code : String(e)),
  );

describe("LocalSigner", () => {
  it("signs USDC TransferWithAuthorization on Arbitrum Sepolia, under its own domain constants", async () => {
    const { account, signer } = localSigner();
    const signature = await signer.signTransferAuthorization(auth());
    const recovered = await recoverTypedDataAddress({
      domain: { name: USDC_EIP712_DOMAIN.name, version: USDC_EIP712_DOMAIN.version, chainId: 421614, verifyingContract: getAddress(ARBITRUM_SEPOLIA_USDC) },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from: account.address, to: getAddress(PAYEE), value: 250_000n, validAfter: 0n, validBefore: BigInt(NOW_S + 300), nonce: nonce(1) as `0x${string}` },
      signature,
    });
    expect(recovered).toBe(account.address);
  });

  it("refuses a payee off the allowlist, an amount over the per-purchase cap, and a bad window", async () => {
    const { signer, ledger } = localSigner();
    expect(await refusal(signer.signTransferAuthorization(auth({ to: OTHER })))).toBe("WRONG_RECIPIENT");
    expect(await refusal(signer.signTransferAuthorization(auth({ value: "300001" })))).toBe("EXCEEDS_PER_RESOLUTION");
    expect(await refusal(signer.signTransferAuthorization(auth({ value: "0" })))).toBe("ZERO_AMOUNT");
    expect(await refusal(signer.signTransferAuthorization(auth({ validBefore: String(NOW_S + 601) })))).toBe("AUTHORIZATION_TOO_LONG");
    expect(await refusal(signer.signTransferAuthorization(auth({ validBefore: String(NOW_S + 5) })))).toBe("AUTHORIZATION_EXPIRED");
    expect(await refusal(signer.signTransferAuthorization({ ...auth(), validAfter: "5" } as never))).toBe("BAD_REQUEST");
    expect(ledger.entries()).toEqual([]);
  });

  it("keeps a rolling daily cap over its own ledger, counting a nonce signed again once", async () => {
    let now = NOW;
    const { signer, ledger } = localSigner(policy, () => now);
    expect(await refusal(signer.signTransferAuthorization(auth({ nonce: nonce(1) })))).toBe("signed");
    // The same nonce again (a retry) is one possible payment: it does not count twice.
    expect(await refusal(signer.signTransferAuthorization(auth({ nonce: nonce(1) })))).toBe("signed");
    expect(await refusal(signer.signTransferAuthorization(auth({ nonce: nonce(2) })))).toBe("signed");
    expect(await refusal(signer.signTransferAuthorization(auth({ nonce: nonce(3), value: "1" })))).toBe("EXCEEDS_DAILY_CAP");
    expect(ledger.committed(now)).toBe(500_000n);
    now = new Date(NOW.getTime() + 24 * 3600_000 + 1000);
    expect(await refusal(signer.signTransferAuthorization(auth({ nonce: nonce(3), validBefore: String(Math.floor(now.getTime() / 1000) + 300) })))).toBe("signed");
  });

  it("signs Adoption Receipts as core's typed data", async () => {
    const { account, signer } = localSigner();
    const receipt: AdoptionReceipt = { schemaVersion: "1", resolutionId: nonce(9), outcome: "passed", acceptance: { exitCode: 0, durationMs: 10, outputDigest: null }, recordedAt: NOW.toISOString(), signature: null };
    const signature = await signer.signAdoptionReceipt(receipt);
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverTypedDataAddress({ ...adoptionReceiptTypedData(receipt, 421614), signature: signature as `0x${string}` })).toBe(account.address);
  });
});

describe("the signer's Unix socket", () => {
  it("serves address, transfer and receipt signatures on a 0600 socket, and passes refusals through", async () => {
    const { account, signer } = localSigner(policy, () => new Date());
    const socketPath = join(temp("lemma-sock-"), "signer.sock");
    const server = await serveSigner(signer, { socketPath });
    try {
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const client = new SocketSigner(socketPath);
      expect(await client.address()).toBe(toAddress(account.address));
      const now = Math.floor(Date.now() / 1000);
      expect(await client.signTransferAuthorization(auth({ validBefore: String(now + 300) }))).toMatch(/^0x[0-9a-f]{130}$/);
      expect(await refusal(client.signTransferAuthorization(auth({ to: OTHER, validBefore: String(now + 300) })))).toBe("WRONG_RECIPIENT");
      expect(await refusal(client.signTransferAuthorization({ ...auth(), extra: 1 } as never))).toBe("BAD_REQUEST");
      // A second signer cannot take over a live socket.
      await expect(serveSigner(signer, { socketPath })).rejects.toThrow(/already listening/);
    } finally {
      await server.close();
    }
    // A stale socket file is replaced.
    const again = await serveSigner(signer, { socketPath });
    await again.close();
  });

  it("refuses a socket directory its group or others can write to, or a linked one", async () => {
    // Anyone who can write there could listen at the path first, or swap it for a link before the mode is set.
    for (const mode of [0o777, 0o770, 0o1777]) {
      const dir = temp("lemma-sock-");
      chmodSync(dir, mode);
      await expect(serveSigner(localSigner().signer, { socketPath: join(dir, "signer.sock") })).rejects.toThrow(/written by its group or by others/);
    }
    const link = join(temp("lemma-sock-"), "link");
    symlinkSync(temp("lemma-sock-"), link);
    await expect(serveSigner(localSigner().signer, { socketPath: join(link, "signer.sock") })).rejects.toThrow(/symbolic link/);
    // A directory others may enter but not write to is fine (0755, or 0750 for a signer shared with a group).
    for (const mode of [0o755, 0o750]) {
      const dir = temp("lemma-sock-");
      chmodSync(dir, mode);
      const server = await serveSigner(localSigner().signer, { socketPath: join(dir, "signer.sock") });
      await server.close();
    }
  });

  it("refuses a socket path too long for a Unix socket, with a way out", async () => {
    await expect(serveSigner(localSigner().signer, { socketPath: `/${"x".repeat(120)}.sock` })).rejects.toThrow(/LEMMA_SIGNER_SOCKET/);
  });

  it("reports an unreachable signer as unavailable, never as a refusal", async () => {
    const client = new SocketSigner(join(temp("lemma-sock-"), "missing.sock"), 500);
    await expect(client.address()).rejects.toBeInstanceOf(SignerUnavailable);
  });

  it("refuses to replace something that is not a socket", async () => {
    const path = join(temp("lemma-sock-"), "signer.sock");
    writeFileSync(path, "not a socket");
    await expect(serveSigner(localSigner().signer, { socketPath: path })).rejects.toThrow(/other than a socket/);
    // And a plain TCP-style server on the path is not a signer either.
    const other = join(temp("lemma-sock-"), "other.sock");
    const plain = createServer((s) => s.end("HTTP/1.1 500 Nope\r\ncontent-length: 2\r\n\r\n{}"));
    await new Promise<void>((resolve) => plain.listen(other, resolve));
    await expect(new SocketSigner(other, 500).address()).rejects.toBeInstanceOf(SignerUnavailable);
    plain.close();
  });
});

describe("the key file", () => {
  it("is created once with mode 0600 and read back, never quoted in an error", () => {
    const path = join(temp("lemma-key-"), "signer", "key");
    const address = initKeyFile(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(toAddress(privateKeyToAccount(readKeyFile(path)).address)).toBe(address);
    expect(() => initKeyFile(path)).toThrow(/never overwritten/);
    const key = readFileSync(path, "utf8").trim();
    chmodSync(path, 0o644);
    expect(() => readKeyFile(path)).toThrow(KeyFileError);
    try {
      readKeyFile(path);
    } catch (error) {
      expect((error as Error).message).not.toContain(key.slice(2, 20));
    }
  });

  it("refuses a symbolic link, a missing file and malformed content", () => {
    const dir = temp("lemma-key-");
    const real = join(dir, "real");
    writeFileSync(real, `0x${"ab".repeat(32)}\n`, { mode: 0o600 });
    symlinkSync(real, join(dir, "link"));
    expect(() => readKeyFile(join(dir, "link"))).toThrow(/symbolic link/);
    expect(() => readKeyFile(join(dir, "missing"))).toThrow(/does not exist/);
    const bad = join(dir, "bad");
    writeFileSync(bad, "not a key", { mode: 0o600 });
    expect(() => readKeyFile(bad)).toThrow(/64 hex digits/);
  });

  it("takes the socket mode 600 when LEMMA_SIGNER_SOCKET_MODE is unset or empty, as in .env.example", () => {
    expect(signerSocketMode({})).toBe(0o600);
    expect(signerSocketMode({ LEMMA_SIGNER_SOCKET_MODE: "" })).toBe(0o600);
    expect(signerSocketMode({ LEMMA_SIGNER_SOCKET_MODE: "600" })).toBe(0o600);
    expect(signerSocketMode({ LEMMA_SIGNER_SOCKET_MODE: "660" })).toBe(0o660);
    for (const bad of ["644", "666", "0600", "rw"]) expect(signerSocketMode({ LEMMA_SIGNER_SOCKET_MODE: bad })).toBeUndefined();
  });

  it("lives under the state directory unless named, and must be named absolutely", () => {
    expect(signerPaths({ LEMMA_STATE_DIR: "/state" })).toEqual({ dir: "/state/signer", keyFile: "/state/signer/key", socket: "/state/signer/signer.sock" });
    // The bridge's default is the same socket, for the same state directory.
    expect(defaultSignerSocket("/state")).toBe(signerPaths({ LEMMA_STATE_DIR: "/state" }).socket);
    expect(signerPaths({ LEMMA_STATE_DIR: "/state", LEMMA_SIGNER_SOCKET: "/run/s.sock" }).socket).toBe("/run/s.sock");
    expect(() => signerPaths({ LEMMA_SIGNER_KEY_FILE: "key" })).toThrow(/absolute/);
  });
});

describe("SpendLedger", () => {
  it("reserves under its lock, settles, releases only what was never settled, and forgets after the window", () => {
    const ledger = new SpendLedger(temp("lemma-ledger-"));
    const ok = () => ({ ok: true });
    ledger.reserve({ nonce: nonce(1), amount: 100n, payTo: PAYEE }, NOW, ok);
    ledger.reserve({ nonce: nonce(2), amount: 200n, payTo: PAYEE }, NOW, ok);
    // The same nonce again keeps the larger amount and counts once.
    ledger.reserve({ nonce: nonce(1), amount: 50n, payTo: PAYEE }, NOW, ok);
    expect(ledger.committed(NOW)).toBe(300n);
    expect(ledger.committed(NOW, nonce(1))).toBe(200n);
    ledger.settle(nonce(2), NOW);
    ledger.release(nonce(2), NOW);
    ledger.release(nonce(1), NOW);
    expect(ledger.committed(NOW)).toBe(200n);
    expect(ledger.reserve({ nonce: nonce(3), amount: 1n, payTo: PAYEE }, NOW, () => ({ ok: false }))).toEqual({ ok: false });
    expect(ledger.committed(new Date(NOW.getTime() + 24 * 3600_000 + 1))).toBe(0n);
    expect(statSync(join(ledger.dir, "spend.json")).mode & 0o777).toBe(0o600);
  });

  it("fails closed on a damaged file, and waits out only a live lock", () => {
    const dir = temp("lemma-ledger-");
    const ledger = new SpendLedger(dir);
    writeFileSync(join(dir, "spend.json"), "{ nope");
    expect(() => ledger.committed(NOW)).toThrow(LedgerError);
    rmSync(join(dir, "spend.json"));
    // A lock left by a process that is gone is taken over.
    writeFileSync(join(dir, "spend.lock"), "999999999");
    expect(ledger.committed(NOW)).toBe(0n);
    // A lock held by a live process (this one) blocks until the wait runs out.
    writeFileSync(join(dir, "spend.lock"), String(process.pid));
    expect(() => ledger.committed(NOW)).toThrow(/locked/);
  });
});

describe("spending policy and wiring from the environment", () => {
  const env = { LEMMA_MAX_USDC_PER_RESOLUTION: "250000", LEMMA_DAILY_USDC_CAP: "1000000", LEMMA_ALLOWED_PAY_TO: `${PAYEE}, ${getAddress(OTHER)}` };

  it("parses atomic amounts and a recipient list, refusing decimals and bad addresses", () => {
    const parsed = spendingPolicyFromEnv(env);
    expect(parsed.ok && parsed.policy).toMatchObject({ allowedPayTo: [PAYEE, OTHER], maxPerResolutionUsdc: "250000", dailyCapUsdc: "1000000", maxAuthorizationSeconds: 600 });
    const bad = spendingPolicyFromEnv({ LEMMA_MAX_USDC_PER_RESOLUTION: "0.25", LEMMA_ALLOWED_PAY_TO: "0xnope" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems.join(" ")).toMatch(/LEMMA_MAX_USDC_PER_RESOLUTION.*LEMMA_DAILY_USDC_CAP.*LEMMA_ALLOWED_PAY_TO/);
  });
});
