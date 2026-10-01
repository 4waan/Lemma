/**
 * Outbound links the dashboard may render: a GitHub repository at a full
 * commit hash, and block explorer pages for an address or a transaction. Each
 * is rebuilt from validated parts, never a URL taken as is.
 */
const REPOSITORY = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function sourceUrl(provenance: { repository: string; commit: string }): string | null {
  const repo = REPOSITORY.exec(provenance.repository);
  if (repo === null || !COMMIT.test(provenance.commit)) return null;
  const [, owner, name] = repo as unknown as [string, string, string];
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;
  return `https://github.com/${owner}/${name}/tree/${provenance.commit}`;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * The block explorer the server names (`StatusView.chain.explorer`) as a base
 * to append a path to: an http(s) URL without credentials, query or fragment,
 * rebuilt from its origin and path, trailing slashes dropped. Null, which
 * turns every explorer link off, for null or anything else.
 */
export function explorerBase(explorer: string | null): string | null {
  if (explorer === null) return null;
  let url: URL;
  try {
    url = new URL(explorer);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** What link text calls the explorer: Arbiscan for arbiscan.io, else its host. Null when links are off. */
export function explorerName(explorer: string | null): string | null {
  const base = explorerBase(explorer);
  if (base === null) return null;
  const host = new URL(base).host;
  return host === "arbiscan.io" || host.endsWith(".arbiscan.io") ? "Arbiscan" : host;
}

/** An explorer page for a contract or account; null when links are off or the address is malformed. */
export function explorerAddressUrl(explorer: string | null, address: string): string | null {
  const base = explorerBase(explorer);
  return base !== null && ADDRESS.test(address) ? `${base}/address/${address.toLowerCase()}` : null;
}

/** An explorer page for a transaction; null when links are off or the hash is malformed. */
export function explorerTxUrl(explorer: string | null, hash: string): string | null {
  const base = explorerBase(explorer);
  return base !== null && TX_HASH.test(hash) ? `${base}/tx/${hash.toLowerCase()}` : null;
}
