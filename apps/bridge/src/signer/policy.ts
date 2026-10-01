import { ARBITRUM_SEPOLIA, ARBITRUM_SEPOLIA_USDC, type Address, MAX_AUTHORIZATION_SECONDS, SpendingPolicy, UsdcAtomic, toAddress } from "@lemma/core";

/**
 * The buyer's spending policy from the environment. Both the bridge and the
 * signer read it, and each enforces it on its own:
 *
 * - `LEMMA_MAX_USDC_PER_RESOLUTION`: atomic USDC, for example `250000` for 0.25 USDC;
 * - `LEMMA_DAILY_USDC_CAP`: atomic USDC over a rolling 24 hours;
 * - `LEMMA_ALLOWED_PAY_TO`: comma-separated recipient addresses.
 *
 * The network and asset are fixed to Arbitrum Sepolia USDC, and an
 * authorization may be valid for at most 600 seconds. Problems are described
 * by variable name only.
 */
export function spendingPolicyFromEnv(env: NodeJS.ProcessEnv): { ok: true; policy: SpendingPolicy } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const amount = (name: string): string | undefined => {
    const value = env[name];
    if (value === undefined || value === "") {
      problems.push(`${name} is not set (atomic USDC, for example 250000 for 0.25 USDC)`);
      return undefined;
    }
    if (!UsdcAtomic.safeParse(value).success || BigInt(value) === 0n) {
      problems.push(`${name} must be a positive integer amount of atomic USDC (250000 is 0.25 USDC)`);
      return undefined;
    }
    return value;
  };
  const perResolution = amount("LEMMA_MAX_USDC_PER_RESOLUTION");
  const daily = amount("LEMMA_DAILY_USDC_CAP");
  const payTo: Address[] = [];
  const list = env["LEMMA_ALLOWED_PAY_TO"];
  if (list === undefined || list.trim() === "") problems.push("LEMMA_ALLOWED_PAY_TO is not set (comma-separated recipient addresses)");
  else {
    for (const item of list.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
      try {
        payTo.push(toAddress(item));
      } catch {
        problems.push("LEMMA_ALLOWED_PAY_TO holds something that is not an address with a valid checksum");
      }
    }
  }
  if (problems.length > 0 || perResolution === undefined || daily === undefined) return { ok: false, problems };
  const parsed = SpendingPolicy.safeParse({
    schemaVersion: "1",
    network: ARBITRUM_SEPOLIA,
    asset: ARBITRUM_SEPOLIA_USDC,
    allowedPayTo: [...new Set(payTo)].sort(),
    maxPerResolutionUsdc: perResolution,
    dailyCapUsdc: daily,
    maxAuthorizationSeconds: MAX_AUTHORIZATION_SECONDS,
  });
  if (!parsed.success) return { ok: false, problems: ["LEMMA_ALLOWED_PAY_TO must list between 1 and 16 addresses"] };
  return { ok: true, policy: parsed.data };
}
