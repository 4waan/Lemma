/**
 * Outbound links the dashboard may render. Only a GitHub repository at a full
 * commit hash, rebuilt from validated parts, never a URL taken as is.
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

/** The block explorer for Arbitrum Sepolia, the only network the MVP settles on. */
const EXPLORER = "https://sepolia.arbiscan.io";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** An explorer page for a contract or account, rebuilt from a validated address, never a URL taken as is. */
export function explorerAddressUrl(address: string): string | null {
  return ADDRESS.test(address) ? `${EXPLORER}/address/${address.toLowerCase()}` : null;
}
