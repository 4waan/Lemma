import { isIP } from "node:net";

/**
 * The rate-limit key for a request. Behind `hops` trusted proxies, each
 * appends the address it received from, so the right-most `hops` entries of
 * X-Forwarded-For are trustworthy and the client is the entry the outermost
 * trusted proxy appended. Anything to its left was supplied by the client and
 * is ignored. With no trusted proxy the socket address is used.
 *
 * The chosen entry must be an IP address (otherwise the socket address is
 * used), and it is normalized: an IPv4-mapped IPv6 address to IPv4, and any
 * other IPv6 address to its /64, because one client usually controls a whole
 * /64 and could otherwise rotate addresses to get fresh buckets.
 */
export function clientAddress(forwardedFor: string | undefined, socketAddress: string | undefined, hops: number): string {
  const socket = normalizeIp(socketAddress);
  if (hops === 0) return socket;
  const entries = (forwardedFor ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const chosen = entries[entries.length - hops];
  return chosen !== undefined && isIP(chosen) !== 0 ? normalizeIp(chosen) : socket;
}

/** IPv4 as is; IPv4-mapped IPv6 as IPv4; other IPv6 as its /64 prefix; anything else as "unknown". */
export function normalizeIp(address: string | undefined): string {
  if (address === undefined) return "unknown";
  const kind = isIP(address);
  if (kind === 4) return address;
  if (kind !== 6) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped?.[1] !== undefined) return mapped[1];
  return `${expandIpv6(address).slice(0, 4).join(":")}::/64`;
}

function expandIpv6(address: string): string[] {
  const [head = "", tail] = address.toLowerCase().split("::");
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  const fill = tail === undefined ? [] : Array<string>(8 - left.length - right.length).fill("0");
  return [...left, ...fill, ...right].map((g) => g.replace(/^0+(?=.)/, ""));
}
