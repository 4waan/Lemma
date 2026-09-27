import { ARBITRUM_SEPOLIA } from "@lemma/core";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ReputationConfig } from "./config.js";

/** The `type` of an ERC-8004 agent registration file (ERC-8004, "Agent URI and Agent Registration File"). */
export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

/** Where the registration file is served; its full URL is the agentURI the register script records on chain. */
export const REGISTRATION_PATH = "/api/v1/agent/registration.json";

/** ERC-8004's optional endpoint-domain verification path, served with the same file. */
export const WELL_KNOWN_REGISTRATION_PATH = "/.well-known/agent-registration.json";

/**
 * The registration file's shape as ERC-8004 requires it, for the fields Lemma
 * sets. `supportedTrust` names the two trust models Lemma backs: reputation
 * (feedback from its attester) and crypto-economic (the provider bond behind
 * each warranty). `image`, which ERC-721 apps show, is there when the server
 * serves the dashboard and its icon.
 */
export const RegistrationFile = z.strictObject({
  type: z.literal(REGISTRATION_TYPE),
  name: z.string().min(1),
  description: z.string().min(1),
  image: z.string().regex(/^https?:\/\/\S+$/).optional(),
  services: z.array(z.strictObject({ name: z.string().min(1), endpoint: z.string().min(1), version: z.string().min(1).optional() })).min(1),
  x402Support: z.boolean(),
  active: z.boolean(),
  registrations: z.array(z.strictObject({ agentId: z.union([z.int().min(0), z.string().regex(/^[0-9]+$/)]), agentRegistry: z.string().regex(/^eip155:[0-9]+:0x[0-9a-f]{40}$/) })),
  supportedTrust: z.array(z.enum(["reputation", "crypto-economic", "tee-attestation"])),
});

export type RegistrationFile = z.infer<typeof RegistrationFile>;

const DESCRIPTION =
  "Lemma is a compatibility and reuse layer for coding agents. A free lemma_preview matches a typed task and a privacy-safe repository profile against a curated catalog of Capability Releases. " +
  "A buyer can pay through x402 (USDC on Arbitrum Sepolia, testnet) for a signed Compatibility Resolution, backed by a provider bond. " +
  "Each finalized adoption outcome is posted as ERC-8004 feedback by Lemma's attester, with a public evidence file.";

/**
 * Lemma's ERC-8004 registration file, or undefined when `PUBLIC_BASE_URL` is
 * not set. It lists the MCP endpoint and, once `LEMMA_AGENT_ID` is set, the
 * provider agent's registration on Arbitrum Sepolia. `x402Support` is true only
 * while this server actually registers its paid tools. `imagePath` is the
 * served dashboard icon's path, if any.
 */
export function registrationFile(config: ReputationConfig, options: { readonly paidTools: boolean; readonly imagePath?: string | undefined }): RegistrationFile | undefined {
  const base = config.publicBaseUrl;
  if (base === undefined) return undefined;
  const chainId = ARBITRUM_SEPOLIA.split(":")[1] as string;
  const agentId = config.agentId;
  return RegistrationFile.parse({
    type: REGISTRATION_TYPE,
    name: "Lemma",
    description: DESCRIPTION,
    ...(options.imagePath === undefined ? {} : { image: `${base}${options.imagePath}` }),
    services: [
      { name: "MCP", endpoint: `${base}/mcp`, version: LATEST_PROTOCOL_VERSION },
      { name: "web", endpoint: `${base}/` },
    ],
    x402Support: options.paidTools,
    active: true,
    registrations:
      agentId === undefined
        ? []
        : [{ agentId: BigInt(agentId) <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(agentId) : agentId, agentRegistry: `eip155:${chainId}:${config.identityRegistry}` }],
    supportedTrust: ["reputation", "crypto-economic"],
  });
}
