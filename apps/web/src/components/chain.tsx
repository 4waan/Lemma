import { explorerAddressUrl, explorerName, explorerTxUrl } from "../links.js";
import { Hash } from "./copy.js";
import { Icon } from "./Icon.js";

/**
 * A link to one explorer page, named after the explorer, or nothing when
 * there is no page: the server turned links off (`StatusView.chain.explorer`
 * is null), its status is not loaded yet, or the value is malformed.
 */
export function ExplorerLink({ href, explorer, label }: { href: string | null; explorer: string | null; label: string }) {
  const name = explorerName(explorer);
  if (href === null || name === null) return null;
  return (
    <a href={href} rel="noopener noreferrer nofollow" target="_blank" className="small" aria-label={`${label} on ${name} (opens in a new tab)`}>
      {name} <Icon name="external" size={12} />
    </a>
  );
}

/** An address, shortened and copyable, with its explorer page. */
export function AddressLink({ value, explorer, what = "address" }: { value: string; explorer: string | null; what?: string }) {
  return (
    <>
      <Hash value={value} what={what} /> <ExplorerLink href={explorerAddressUrl(explorer, value)} explorer={explorer} label={`View the ${what}`} />
    </>
  );
}

/** A transaction hash, shortened and copyable, with its explorer page. */
export function TxLink({ value, explorer, what = "transaction" }: { value: string; explorer: string | null; what?: string }) {
  return (
    <>
      <Hash value={value} what={`${what} hash`} /> <ExplorerLink href={explorerTxUrl(explorer, value)} explorer={explorer} label={`View the ${what}`} />
    </>
  );
}
