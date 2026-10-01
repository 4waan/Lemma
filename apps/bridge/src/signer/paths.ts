import { isAbsolute, join } from "node:path";

import { defaultStateDir } from "../inbox.js";

/** `<state>/signer/`: where `lemma-signer` keeps its key, socket and ledger, for a state directory. */
export function signerDirIn(stateDir: string): string {
  return join(stateDir, "signer");
}

/**
 * The socket `lemma-signer serve` listens on unless LEMMA_SIGNER_SOCKET names
 * another: `<state>/signer/signer.sock`. The bridge looks there too, so a
 * bridge and a signer sharing a state directory find each other unset.
 */
export function defaultSignerSocket(stateDir: string): string {
  return join(signerDirIn(stateDir), "signer.sock");
}

/**
 * Where `lemma-signer` keeps its key, socket and ledger: `<state>/signer/`,
 * where `<state>` is LEMMA_STATE_DIR (absolute) or `$XDG_STATE_HOME/lemma`.
 * LEMMA_SIGNER_KEY_FILE and LEMMA_SIGNER_SOCKET override the key file and the
 * socket, and must be absolute.
 */
export function signerPaths(env: NodeJS.ProcessEnv = process.env): { dir: string; keyFile: string; socket: string } {
  const state = env["LEMMA_STATE_DIR"];
  const stateDir = state !== undefined && state !== "" && isAbsolute(state) ? state : defaultStateDir(env);
  const dir = signerDirIn(stateDir);
  const pick = (name: string, fallback: string) => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    return value;
  };
  return { dir, keyFile: pick("LEMMA_SIGNER_KEY_FILE", join(dir, "key")), socket: pick("LEMMA_SIGNER_SOCKET", defaultSignerSocket(stateDir)) };
}

/**
 * The socket's mode from LEMMA_SIGNER_SOCKET_MODE: 0600 when it is unset or
 * empty (every Lemma variable treats an empty value as unset, so the empty
 * line in .env.example works), 0660 for a signer run as another user sharing
 * a group with the bridge, and undefined for anything else.
 */
export function signerSocketMode(env: NodeJS.ProcessEnv = process.env): 0o600 | 0o660 | undefined {
  const value = env["LEMMA_SIGNER_SOCKET_MODE"]?.trim();
  if (value === undefined || value === "" || value === "600") return 0o600;
  return value === "660" ? 0o660 : undefined;
}
