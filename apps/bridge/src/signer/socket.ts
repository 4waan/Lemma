import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer, request } from "node:http";
import { dirname } from "node:path";

import { Address, AdoptionReceipt, Hex32 } from "@lemma/core";
import type { Hex } from "viem";
import { z } from "zod";

import { type Signer, SignerRefusal, type SignerRefusalCode, TransferAuthorization } from "./signer.js";

/** The largest request or response body either side accepts. */
export const MAX_SIGNER_BODY = 32 * 1024;

/** The longest Unix socket path every supported platform takes (macOS: 104 bytes with the terminating NUL). */
export const MAX_SOCKET_PATH = 103;

const TransferBody = z.strictObject({ authorization: TransferAuthorization });
const ReceiptBody = z.strictObject({ receipt: AdoptionReceipt, previewId: Hex32 });
const SignatureAnswer = z.strictObject({ signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){65,4096}$/) });
const AddressAnswer = z.strictObject({ address: Address });
const ErrorAnswer = z.object({ error: z.string().regex(/^[A-Z_]{2,40}$/) });

const REFUSALS: ReadonlySet<string> = new Set<SignerRefusalCode>([
  "INVALID_AMOUNT",
  "ZERO_AMOUNT",
  "WRONG_SCHEME",
  "WRONG_NETWORK",
  "WRONG_ASSET",
  "WRONG_RECIPIENT",
  "AUTHORIZATION_TOO_LONG",
  "EXCEEDS_PER_RESOLUTION",
  "EXCEEDS_DAILY_CAP",
  "BAD_REQUEST",
  "AUTHORIZATION_EXPIRED",
  "LEDGER_UNAVAILABLE",
  "SIGNING_FAILED",
  "NOT_PAID",
  "RECEIPT_ALREADY_SIGNED",
]);

/** The signer could not be reached or answered something unusable. Nothing was signed as far as the caller knows. */
export class SignerUnavailable extends Error {
  override name = "SignerUnavailable";
}

export interface SignerServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Why the directory holding a signer socket cannot be trusted, or undefined.
 * It must be a real directory (not a symbolic link) that neither its group nor
 * others can write to: otherwise another local user could put a socket of
 * their own at the path first (an impostor signer learns every purchase and
 * answers the buyer address), or swap the path for a link between listen and
 * chmod. With `ownedByMe` (the signer), it must also belong to this user; the
 * bridge leaves that out, because a signer run as another user (mode 0660)
 * owns its directory.
 */
export function socketDirectoryProblem(socketPath: string, options: { readonly ownedByMe: boolean }): string | undefined {
  let st;
  try {
    st = lstatSync(dirname(socketPath));
  } catch {
    return "the signer socket's directory does not exist";
  }
  if (!st.isDirectory()) return "the signer socket's directory is a symbolic link or not a directory";
  if (options.ownedByMe && typeof process.getuid === "function" && st.uid !== process.getuid()) return "the signer socket's directory belongs to another user";
  if ((st.mode & 0o022) !== 0) return "the signer socket's directory can be written by its group or by others";
  return undefined;
}

/**
 * Serves a signer as JSON over HTTP on a Unix socket:
 *
 * - `GET /address` → `{ address }`
 * - `POST /sign/transfer-authorization` `{ authorization }` → `{ signature }`
 * - `POST /sign/adoption-receipt` `{ receipt, previewId }` → `{ signature }`
 *
 * A refusal answers 403 `{ error: <code> }`. The socket is created under a
 * 0177 umask in a directory this user owns and nobody else can write to
 * (`socketDirectoryProblem`; a missing one is created 0700), and then set to
 * `mode` (0600 by default; 0660 lets one shared group reach a signer that runs
 * as another user). A stale socket is replaced; a live one (another signer)
 * is not.
 */
export async function serveSigner(signer: Signer, options: { socketPath: string; mode?: 0o600 | 0o660; log?: (event: Record<string, unknown>) => void }): Promise<SignerServer> {
  const { socketPath } = options;
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) throw new Error(`the socket path is longer than ${MAX_SOCKET_PATH} bytes, the most a Unix socket takes; set LEMMA_SIGNER_SOCKET to a shorter path`);
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  const unsafe = socketDirectoryProblem(socketPath, { ownedByMe: true });
  if (unsafe !== undefined) throw new Error(`${unsafe}; put LEMMA_SIGNER_SOCKET in a directory only this user can write to, such as the default <state>/signer/`);
  await clearStaleSocket(socketPath);
  const server = createServer((req, res) => void handle(signer, req, res, options.log));
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  const previous = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  // The directory is this user's alone, so the path is still the socket just created; checked anyway, since chmod follows links.
  if (!lstatSync(socketPath).isSocket()) {
    server.close();
    throw new Error("the signer socket was replaced before its mode was set");
  }
  chmodSync(socketPath, options.mode ?? 0o600);
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

async function clearStaleSocket(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Error("something other than a socket is at the signer socket path");
  const live = await new SocketSigner(path, 1000).address().then(
    () => true,
    () => false,
  );
  if (live) throw new Error("another signer is already listening on this socket");
  rmSync(path, { force: true });
}

async function handle(signer: Signer, req: IncomingMessage, res: ServerResponse, log?: (event: Record<string, unknown>) => void): Promise<void> {
  try {
    if (req.method === "GET" && req.url === "/address") return answer(res, 200, { address: await signer.address() });
    if (req.method !== "POST") return answer(res, 405, { error: "METHOD_NOT_ALLOWED" });
    const body = await readJson(req);
    if (req.url === "/sign/transfer-authorization") {
      const parsed = TransferBody.safeParse(body);
      if (!parsed.success) throw new SignerRefusal("BAD_REQUEST");
      const signature = await signer.signTransferAuthorization(parsed.data.authorization);
      log?.({ event: "signed.transfer", to: parsed.data.authorization.to, value: parsed.data.authorization.value });
      return answer(res, 200, { signature });
    }
    if (req.url === "/sign/adoption-receipt") {
      const parsed = ReceiptBody.safeParse(body);
      if (!parsed.success) throw new SignerRefusal("BAD_REQUEST");
      const signature = await signer.signAdoptionReceipt(parsed.data.receipt, parsed.data.previewId);
      log?.({ event: "signed.receipt", resolutionId: parsed.data.receipt.resolutionId, outcome: parsed.data.receipt.outcome });
      return answer(res, 200, { signature });
    }
    return answer(res, 404, { error: "NOT_FOUND" });
  } catch (error) {
    if (error instanceof SignerRefusal) {
      log?.({ event: "refused", path: req.url === "/sign/adoption-receipt" ? "adoption-receipt" : "transfer-authorization", code: error.code });
      return answer(res, 403, { error: error.code });
    }
    if (error instanceof BodyTooLarge) return answer(res, 413, { error: "BODY_TOO_LARGE" });
    log?.({ event: "error", name: error instanceof Error ? error.name : "error" });
    return answer(res, 500, { error: "INTERNAL" });
  }
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_SIGNER_BODY) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SignerRefusal("BAD_REQUEST");
  }
}

function answer(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

/**
 * The bridge's side of `lemma-signer`: the `Signer` interface over the Unix
 * socket. Refusals come back as `SignerRefusal` with the signer's code; a
 * signer that cannot be reached, or answers anything else, is
 * `SignerUnavailable`. It holds no key and no secret.
 */
export class SocketSigner implements Signer {
  constructor(
    readonly socketPath: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async address() {
    return AddressAnswer.parse(await this.call("GET", "/address")).address;
  }

  async signTransferAuthorization(authorization: TransferAuthorization): Promise<Hex> {
    return SignatureAnswer.parse(await this.call("POST", "/sign/transfer-authorization", { authorization })).signature.toLowerCase() as Hex;
  }

  async signAdoptionReceipt(receipt: AdoptionReceipt, previewId: Hex32): Promise<string> {
    return SignatureAnswer.parse(await this.call("POST", "/sign/adoption-receipt", { receipt, previewId })).signature.toLowerCase();
  }

  private call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request(
        { socketPath: this.socketPath, path, method, timeout: this.timeoutMs, headers: text === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) } },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_SIGNER_BODY) req.destroy(new SignerUnavailable("the signer's answer is too large"));
            else chunks.push(chunk);
          });
          res.on("end", () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return reject(new SignerUnavailable("the signer answered something that is not JSON"));
            }
            if (res.statusCode === 200) return resolve(parsed);
            const refused = ErrorAnswer.safeParse(parsed);
            if (res.statusCode === 403 && refused.success && REFUSALS.has(refused.data.error)) return reject(new SignerRefusal(refused.data.error as SignerRefusalCode));
            reject(new SignerUnavailable(`the signer answered ${res.statusCode ?? "nothing"}`));
          });
          res.on("error", () => reject(new SignerUnavailable("the signer's answer broke off")));
        },
      );
      req.on("timeout", () => req.destroy(new SignerUnavailable("the signer did not answer in time")));
      req.on("error", (error) => reject(error instanceof SignerUnavailable ? error : new SignerUnavailable("the signer could not be reached")));
      req.end(text);
    });
  }
}
