/**
 * The parts of the official ERC-8004 registries Lemma calls, copied from
 * https://github.com/erc-8004/erc-8004-contracts at commit
 * b9e466c250744a7e06b13dff9d3c2844ed64f825 (`abis/IdentityRegistry.json` and
 * `abis/ReputationRegistry.json`; the deployed contracts report
 * `getVersion() = "2.0.0"`). Only the functions, events and errors used here
 * are vendored. `register` is overloaded upstream; only `register(string)` is
 * kept, so viem never has to choose between overloads. Two items are not in
 * those JSON files and are marked where they appear: `isAuthorizedOrOwner`,
 * from `contracts/IdentityRegistryUpgradeable.sol`, and the identity registry's
 * `ERC721NonexistentToken` error in the reputation registry's ABI.
 */

/** ERC-8004 registries on Arbitrum Sepolia (the upstream README's "Arbitrum Testnet" section). */
export const ERC8004_ARBITRUM_SEPOLIA = {
  identityRegistry: "0x8004a818bfb912233c491871b3d84c89a494bd9e",
  reputationRegistry: "0x8004b663056a597dffe9eccc1965a193b7388713",
} as const;

export const ERC8004_CONTRACTS_COMMIT = "b9e466c250744a7e06b13dff9d3c2844ed64f825";

export const identityRegistryAbi = [
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ internalType: "string", name: "agentURI", type: "string" }],
    outputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "string", name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    outputs: [{ internalType: "address", name: "", type: "address" }],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "agentId", type: "uint256" }],
    outputs: [{ internalType: "address", name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    outputs: [{ internalType: "string", name: "", type: "string" }],
  },
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
  },
  // Not in abis/IdentityRegistry.json at b9e466c; copied from contracts/IdentityRegistryUpgradeable.sol. The reputation
  // registry refuses feedback when it is true ("Self-feedback not allowed"): ERC-721 `_isAuthorized`, so the agent's
  // owner, its approved address, or an operator of its owner. It reverts for an agent that does not exist.
  {
    type: "function",
    name: "isAuthorizedOrOwner",
    stateMutability: "view",
    inputs: [
      { internalType: "address", name: "spender", type: "address" },
      { internalType: "uint256", name: "agentId", type: "uint256" },
    ],
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Registered",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: false, internalType: "string", name: "agentURI", type: "string" },
      { indexed: true, internalType: "address", name: "owner", type: "address" },
    ],
  },
  {
    type: "event",
    name: "URIUpdated",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: false, internalType: "string", name: "newURI", type: "string" },
      { indexed: true, internalType: "address", name: "updatedBy", type: "address" },
    ],
  },
] as const;

export const reputationRegistryAbi = [
  {
    type: "function",
    name: "giveFeedback",
    stateMutability: "nonpayable",
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "int128", name: "value", type: "int128" },
      { internalType: "uint8", name: "valueDecimals", type: "uint8" },
      { internalType: "string", name: "tag1", type: "string" },
      { internalType: "string", name: "tag2", type: "string" },
      { internalType: "string", name: "endpoint", type: "string" },
      { internalType: "string", name: "feedbackURI", type: "string" },
      { internalType: "bytes32", name: "feedbackHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getSummary",
    stateMutability: "view",
    inputs: [
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "address[]", name: "clientAddresses", type: "address[]" },
      { internalType: "string", name: "tag1", type: "string" },
      { internalType: "string", name: "tag2", type: "string" },
    ],
    outputs: [
      { internalType: "uint64", name: "count", type: "uint64" },
      { internalType: "int128", name: "summaryValue", type: "int128" },
      { internalType: "uint8", name: "summaryValueDecimals", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "getIdentityRegistry",
    stateMutability: "view",
    inputs: [],
    outputs: [{ internalType: "address", name: "", type: "address" }],
  },
  // Not in abis/ReputationRegistry.json: the identity registry's error, which giveFeedback passes on for an agent that
  // does not exist (from isAuthorizedOrOwner), vendored so that revert decodes by name.
  {
    type: "error",
    name: "ERC721NonexistentToken",
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
  },
  {
    type: "event",
    name: "NewFeedback",
    anonymous: false,
    inputs: [
      { indexed: true, internalType: "uint256", name: "agentId", type: "uint256" },
      { indexed: true, internalType: "address", name: "clientAddress", type: "address" },
      { indexed: false, internalType: "uint64", name: "feedbackIndex", type: "uint64" },
      { indexed: false, internalType: "int128", name: "value", type: "int128" },
      { indexed: false, internalType: "uint8", name: "valueDecimals", type: "uint8" },
      { indexed: true, internalType: "string", name: "indexedTag1", type: "string" },
      { indexed: false, internalType: "string", name: "tag1", type: "string" },
      { indexed: false, internalType: "string", name: "tag2", type: "string" },
      { indexed: false, internalType: "string", name: "endpoint", type: "string" },
      { indexed: false, internalType: "string", name: "feedbackURI", type: "string" },
      { indexed: false, internalType: "bytes32", name: "feedbackHash", type: "bytes32" },
    ],
  },
] as const;
