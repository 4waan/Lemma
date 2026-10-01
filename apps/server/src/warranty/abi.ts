/**
 * The parts of the warranty registry's ABI the outcome pipeline uses, copied
 * entry for entry from `contracts/abi/ResolutionWarrantyRegistry.json` (the
 * `forge build` output of `contracts/src/ResolutionWarrantyRegistry.sol`,
 * exported by `npm run contracts:abi`): the calls the jobs send, the views
 * they read, the events the indexer stores, and every custom error those
 * calls can revert with, so viem decodes a revert into its name. A test
 * checks that each entry equals the committed JSON's, so a contract change
 * that touches one fails there.
 */
export const warrantyRegistryAbi = [
  {
    type: "function",
    name: "activateResolution",
    inputs: [
      {
        name: "v",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Voucher",
        components: [
          { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
          { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
          { name: "profileIndex", type: "uint8", internalType: "uint8" },
          { name: "amount", type: "uint256", internalType: "uint256" },
          { name: "paymentRef", type: "bytes32", internalType: "bytes32" },
          { name: "claimHash", type: "bytes32", internalType: "bytes32" },
          { name: "activateBy", type: "uint64", internalType: "uint64" },
        ],
      },
      { name: "providerSignature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "finalizeOutcome",
    inputs: [
      {
        name: "o",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Outcome",
        components: [
          { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
          { name: "verdict", type: "uint8", internalType: "uint8" },
          { name: "weightBps", type: "uint16", internalType: "uint16" },
          { name: "evidenceHash", type: "bytes32", internalType: "bytes32" },
          { name: "validUntil", type: "uint64", internalType: "uint64" },
        ],
      },
      { name: "evaluatorSignature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "expireResolution",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawCredit",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
      { name: "claimSecret", type: "bytes32", internalType: "bytes32" },
      { name: "to", type: "address", internalType: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "release",
    inputs: [
      { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Release",
        components: [
          { name: "provider", type: "address", internalType: "address" },
          { name: "claimWindowSeconds", type: "uint32", internalType: "uint32" },
          { name: "active", type: "bool", internalType: "bool" },
          { name: "evaluator", type: "address", internalType: "address" },
          { name: "available", type: "uint256", internalType: "uint256" },
          { name: "reserved", type: "uint256", internalType: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "resolution",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Resolution",
        components: [
          { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
          { name: "claimHash", type: "bytes32", internalType: "bytes32" },
          { name: "amount", type: "uint256", internalType: "uint256" },
          { name: "claimDeadline", type: "uint64", internalType: "uint64" },
          { name: "profileIndex", type: "uint8", internalType: "uint8" },
          { name: "status", type: "uint8", internalType: "enum ResolutionWarrantyRegistry.Status" },
          { name: "pausedSecondsAtActivation", type: "uint64", internalType: "uint64" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimDeadlineOf",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
    outputs: [
      { name: "", type: "uint64", internalType: "uint64" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "paused",
    inputs: [],
    outputs: [
      { name: "", type: "bool", internalType: "bool" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "usdc",
    inputs: [],
    outputs: [
      { name: "", type: "address", internalType: "contract IERC20" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hashVoucher",
    inputs: [
      {
        name: "v",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Voucher",
        components: [
          { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
          { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
          { name: "profileIndex", type: "uint8", internalType: "uint8" },
          { name: "amount", type: "uint256", internalType: "uint256" },
          { name: "paymentRef", type: "bytes32", internalType: "bytes32" },
          { name: "claimHash", type: "bytes32", internalType: "bytes32" },
          { name: "activateBy", type: "uint64", internalType: "uint64" },
        ],
      },
    ],
    outputs: [
      { name: "", type: "bytes32", internalType: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "hashOutcome",
    inputs: [
      {
        name: "o",
        type: "tuple",
        internalType: "struct ResolutionWarrantyRegistry.Outcome",
        components: [
          { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
          { name: "verdict", type: "uint8", internalType: "uint8" },
          { name: "weightBps", type: "uint16", internalType: "uint16" },
          { name: "evidenceHash", type: "bytes32", internalType: "bytes32" },
          { name: "validUntil", type: "uint64", internalType: "uint64" },
        ],
      },
    ],
    outputs: [
      { name: "", type: "bytes32", internalType: "bytes32" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ResolutionActivated",
    inputs: [
      { name: "resolutionId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "releaseDigest", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "profileIndex", type: "uint8", indexed: false, internalType: "uint8" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "paymentRef", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "claimDeadline", type: "uint64", indexed: false, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OutcomeFinalized",
    inputs: [
      { name: "resolutionId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "releaseDigest", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "verdict", type: "uint8", indexed: false, internalType: "uint8" },
      { name: "weightBps", type: "uint16", indexed: false, internalType: "uint16" },
      { name: "evidenceHash", type: "bytes32", indexed: false, internalType: "bytes32" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EngineRecordFailed",
    inputs: [
      { name: "resolutionId", type: "bytes32", indexed: true, internalType: "bytes32" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ResolutionExpired",
    inputs: [
      { name: "resolutionId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "releaseDigest", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "CreditWithdrawn",
    inputs: [
      { name: "resolutionId", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EngineSet",
    inputs: [
      { name: "previousEngine", type: "address", indexed: true, internalType: "address" },
      { name: "newEngine", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Paused",
    inputs: [
      { name: "account", type: "address", indexed: false, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Unpaused",
    inputs: [
      { name: "account", type: "address", indexed: false, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "ClaimWindowClosed",
    inputs: [
      { name: "claimDeadline", type: "uint64", internalType: "uint64" },
    ],
  },
  {
    type: "error",
    name: "ClaimWindowOpen",
    inputs: [
      { name: "claimDeadline", type: "uint64", internalType: "uint64" },
    ],
  },
  {
    type: "error",
    name: "EnforcedPause",
    inputs: [],
  },
  {
    type: "error",
    name: "InsufficientAvailableBond",
    inputs: [
      { name: "available", type: "uint256", internalType: "uint256" },
      { name: "requested", type: "uint256", internalType: "uint256" },
    ],
  },
  {
    type: "error",
    name: "InsufficientGasForEngine",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidClaim",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidEvaluatorSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidProviderSignature",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidRecipient",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidVerdict",
    inputs: [
      { name: "verdict", type: "uint8", internalType: "uint8" },
    ],
  },
  {
    type: "error",
    name: "InvalidVoucher",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidWeight",
    inputs: [
      { name: "weightBps", type: "uint16", internalType: "uint16" },
    ],
  },
  {
    type: "error",
    name: "NoCredit",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "OutcomeExpired",
    inputs: [
      { name: "validUntil", type: "uint64", internalType: "uint64" },
    ],
  },
  {
    type: "error",
    name: "PaymentRefAlreadyUsed",
    inputs: [
      { name: "paymentRef", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
  {
    type: "error",
    name: "ReleaseNotActive",
    inputs: [
      { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ResolutionAlreadyExists",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "ResolutionNotActive",
    inputs: [
      { name: "resolutionId", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      { name: "token", type: "address", internalType: "address" },
    ],
  },
  {
    type: "error",
    name: "UnknownRelease",
    inputs: [
      { name: "releaseDigest", type: "bytes32", internalType: "bytes32" },
    ],
  },
  {
    type: "error",
    name: "VoucherExpired",
    inputs: [
      { name: "activateBy", type: "uint64", internalType: "uint64" },
    ],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
] as const;
