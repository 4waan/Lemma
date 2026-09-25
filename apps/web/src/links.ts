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
