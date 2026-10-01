# Arbitrum Sepolia deployment (testnet)

This page records Lemma's live run on Arbitrum Sepolia on 2026-10-01: the [runbook](../deployment.md#arbitrum-sepolia-runbook-warranty-engine-and-reputation) followed on the real chain, through one purchase that passed and one that was refunded. Every amount here is **testnet ETH or testnet USDC** on Arbitrum Sepolia (chain id 421614). Hashes link to [Arbiscan](https://sepolia.arbiscan.io).

What it shows, and what it does not:

- **The mechanics, on the real chain.** The warranty registry and the Stylus compatibility engine are deployed and wired. A buyer's agent bought through the shipped `lemma-mcp` and `lemma-signer`, paying with x402, and the provider activated the warranty. The outcome was signed, finalized into the registry and recorded by the engine. The failed purchase's credit was refunded.
- **A demo release with made-up evidence.** The release sold is `payment-gating-demo@1.0.0+demo-1`, written by `e2e/live/catalog.ts`. Its benchmark evidence is labelled `demo-1`, and no measurement stands behind its price (0.25 testnet USDC) or its prior (4 passed, 1 failed). Real evidence needs the stage-4 probe and the frozen benchmark ([Economic gates](../economic-gates.md)).
- **One machine, not a hosted service.** The server ran from `e2e/live/serve.ts` with a local Postgres 16, against the live chain. The agent was the shipped `lemma-mcp`, driven over stdio by `e2e/live/agent.ts` ([e2e/README.md](../../e2e/README.md#live-run-on-arbitrum-sepolia)).
- **No ERC-8004.** Registering the provider's agent and posting feedback write the server's public URL on chain for good, and no public URL exists yet. Both are pending until the server is hosted.
- **Activation batches off.** On `main`, a server sends activations in hourly batches, so that an activation's time says little about which purchase it is. With one buyer there is nothing to hide among, so this run set `WARRANTY_ACTIVATION_BATCH_SECONDS=0` and `WARRANTY_ACTIVATION_JITTER_SECONDS=0`.

Check it yourself, read-only, with `ARBITRUM_SEPOLIA_RPC_URL=<rpc> npm run sepolia:check`. It needs the `ops/sepolia-conformance` change ([Checking a deployment](../deployment.md#checking-a-deployment)). After the run it passed every check, against the chain, a second endpoint (publicnode), and the live server.

## Contracts

| Contract | Address | Block | Transaction |
| --- | --- | --- | --- |
| Warranty registry (`ResolutionWarrantyRegistry`) | [`0x0B0FdF70AD27B3404Bd4C7f317f56c2388305F14`](https://sepolia.arbiscan.io/address/0x0B0FdF70AD27B3404Bd4C7f317f56c2388305F14) | 314,699,714 | [`0xe3eaa916…18eddf`](https://sepolia.arbiscan.io/tx/0xe3eaa9166b61e1e570e659359e7c3dbcac6dc7b44e83e6cdc3536bf1cc18eddf) |
| Compatibility engine (Stylus) | [`0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6`](https://sepolia.arbiscan.io/address/0x0ede0baf8b11b256fb1c3bfd678a2087188d44b6) | 314,700,229 | [`0x1a184d07…bcf975`](https://sepolia.arbiscan.io/tx/0x1a184d072e29b839fa25d2f038ce01d9610fc415131b6d945411615ee0bcf975) |
| USDC (Circle) | [`0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`](https://sepolia.arbiscan.io/address/0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d) | — | — |

The records [`ResolutionWarrantyRegistry.json`](../../contracts/deployments/arbitrum-sepolia/ResolutionWarrantyRegistry.json) and [`ConfidenceEngine.json`](../../contracts/deployments/arbitrum-sepolia/ConfidenceEngine.json) hold the public facts.

**Registry**
- **Built with:** solc 0.8.30, the optimizer at 200 runs, EVM `cancun`, no metadata hash.
- **Runtime code hash:** `0x7131a3af590c2ae3618e8744c206d7459bad01cc4c0078c6987d1e74689bc5c7`.
- **EIP-712 domain:** "Lemma Warranty Registry", version 1.
- **Owner:** the deployer. A production owner would be a multisig.
- **Arbiscan:** not verified, since verification needs an Etherscan API key.

**Engine**
- **One transaction:** deployed, activated and constructed through cargo stylus's deployer contract (`0xcEcba2F1…A990`).
- **Program:** 19,441 bytes compressed, built with Rust 1.94.1, stylus-sdk 0.10.9 and cargo-stylus 0.10.9.
- **Runtime code hash:** `0x6bdfb8b5b906495168e4a0274ab8b156b802541ffbe5bf78d473d59bba3416a2`.
- **Read back:** `owner()` is the deployer, `registry()` is the registry above, `pendingOwner()` is zero.
- **Not a reproducible build:** it was deployed with `--no-verify`.
- **Expiry:** ArbOS reported 364 days left before the program must be activated again.

**Source**
- Both records name commit `de5223a`, this branch's head before it was rebased onto `main`.
- The trees it deployed are byte-identical to `main`'s at `fa7a0aa`:
  - `contracts/src` is tree `c47110fa58c2d61c7ee176bb2a149cc6e800c373`;
  - `contracts/stylus` is tree `c087dfacacecb46f0f44415eecd82c353a7514a7`.
- Check with `git rev-parse fa7a0aa:contracts/src` and `git rev-parse fa7a0aa:contracts/stylus`.

## Roles

Each role has its own key, made by `npm run sepolia:roles` in a private directory outside the repository. No key appears in this repository.

| Role | Address | What it did |
| --- | --- | --- |
| deployer | [`0xa12fd2fb…31658`](https://sepolia.arbiscan.io/address/0xa12fd2fb08acd9993b5f209cd7bf4d47cdd31658) | Deployed and owns both contracts; set the engine, the release and its prior |
| provider | [`0x7d4d19d0…51d61`](https://sepolia.arbiscan.io/address/0x7d4d19d08c4b6e016ceef37d341d9a1294951d61) | Received both payments (x402 `payTo`); deposited the bond; signed vouchers and sent activations |
| facilitator | [`0x0e5c3bc2…87c9e`](https://sepolia.arbiscan.io/address/0x0e5c3bc27dfa45e74d162e236ab873f345f87c9e) | Paid the gas of both settlements |
| evaluator | [`0x6db56f20…be231`](https://sepolia.arbiscan.io/address/0x6db56f203b9a809cff55515829c3c6e5b29be231) | Signed and sent both outcomes; relayed the refund |
| buyer | [`0x56d1ad83…5bd62`](https://sepolia.arbiscan.io/address/0x56d1ad8355a2cb511d1cf82e76bb6eeb7b05bd62) | Paid in USDC through `lemma-signer`; held no ETH |
| attester | [`0xfba3a785…73f31`](https://sepolia.arbiscan.io/address/0xfba3a785db58b76055e646d7d0f27d9b7f073f31) | Unused: ERC-8004 left out |
| agent-owner | [`0xbe66f987…8e4e4`](https://sepolia.arbiscan.io/address/0xbe66f987ff420c26922cd05c909ac09488b8e4e4) | Unused: ERC-8004 left out |

## Setup

| Step | Transaction | Gas used | Cost (testnet ETH) |
| --- | --- | ---: | ---: |
| Registry deployment | [`0xe3eaa916…18eddf`](https://sepolia.arbiscan.io/tx/0xe3eaa9166b61e1e570e659359e7c3dbcac6dc7b44e83e6cdc3536bf1cc18eddf) | 3,267,434 | 0.000116 |
| Engine deployment, activation and constructor | [`0x1a184d07…bcf975`](https://sepolia.arbiscan.io/tx/0x1a184d072e29b839fa25d2f038ce01d9610fc415131b6d945411615ee0bcf975) | 8,843,507 | 0.000437, of which 0.000122 is the activation data fee |
| `setEngine` | [`0xad619bc5…3490ba`](https://sepolia.arbiscan.io/tx/0xad619bc5a3a7b8b9142b932b13f23a90ee26e066cceac0bcba9d6317eb3490ba) | 50,498 | 0.0000018 |
| `registerRelease`, 72-hour claim window | [`0x91fed3bc…f47436`](https://sepolia.arbiscan.io/tx/0x91fed3bcc5cc3d35caa085bd415abb6cc7a3c32fef56331c6e74a290eaf47436) | 72,237 | 0.0000026 |
| `setPrior`: profile 0, 4 passed and 1 failed (made-up evidence `0xc08eaaa7…c0e956`) | [`0x3a99e404…eda85a`](https://sepolia.arbiscan.io/tx/0x3a99e404e3b2dee3e55f46d38b7115cf12652948e28cfa286fe820d675eda85a) | 89,368 | 0.0000032 |
| USDC approval for the bond | [`0xf1afdc48…182316`](https://sepolia.arbiscan.io/tx/0xf1afdc481b240396d9ea4048df413bb4471511ade687b4c1fc2c938b6d182316) | 57,925 | 0.0000021 |
| `depositBond`: 1 USDC | [`0x58730dec…435b9a`](https://sepolia.arbiscan.io/tx/0x58730dec80f13a1211740b8d6e1b00cfcc76b4ce53daf45064305f416f435b9a) | 125,715 | 0.0000046 |

The release's digest is `0x5d412aefed3e25c8913a262bd30b03df25a80cd1e4d25718cbe8ddf5d2b877ad`.

**Funding**
- **Gas for each role:** from the funder, 0.005 testnet ETH to the deployer and 0.002 to each other role that sends transactions: [deployer](https://sepolia.arbiscan.io/tx/0xd7ec0f5596d160ffe26a701277dbbee4d7a72a16cdb5f6dbb42fb546a6066e32), [provider](https://sepolia.arbiscan.io/tx/0xc467301a15060c11d940555c153190fb1618a0612d015cf4426e009608ea04ae), [facilitator](https://sepolia.arbiscan.io/tx/0x3eebb3495b655ae939fc1a7636d59e304319668adf5a7c1ae78447b3adde36e5), [evaluator](https://sepolia.arbiscan.io/tx/0x307967f593e8e0d845f6f81abc1cee8af0f7d562a081b9211a4928fb63634f3a), [attester](https://sepolia.arbiscan.io/tx/0x5a9b2996a8a0e12114ac1a9b17efeaafff8fbda67b95d6a958e004dc16d3c2b0), [agent-owner](https://sepolia.arbiscan.io/tx/0xca2fa8b5668db853e1d0f6e3c3d2476bdcffa92e3d367b81e97fac73d1054eeb), and a later [deployer top-up](https://sepolia.arbiscan.io/tx/0x027ce0e601e6dbd97fb688dffbf988834bfbc7b1a3f099e9d4a8f5bfb31eee88).
- **USDC to the funder:** Circle's faucet sent the funder's USDC to Arc testnet, not to Arbitrum Sepolia. 10 of it came over with Circle's CCTP: a burn on Arc testnet ([`0x900df850…415aac`](https://testnet.arcscan.app/tx/0x900df85089ae7a8364352367900ed746c0285fff9cce18518fece5a8c3415aac)), Circle's attestation, then a mint on Arbitrum Sepolia ([`0x62961490…559f25`](https://sepolia.arbiscan.io/tx/0x629614903baec2ee998f7b5c4f2f7d4e5a4f39ed6e8d88538a7f77a757559f25), 178,105 gas).
- **USDC to the roles:** 3 USDC to the provider ([`0xd761ce65…dd3ce9`](https://sepolia.arbiscan.io/tx/0xd761ce6575c1e63d0efe05f53260c11192cb9a90e4dd386398994b9ef5dd3ce9)) and 1 to the buyer ([`0x3eaf5cfd…ecaf3b`](https://sepolia.arbiscan.io/tx/0x3eaf5cfda45956d4783049cb2f7ca97a991c1eb46c978b2c1ff8ca37f6ecaf3b)).

## The engine's `record` gas

The registry calls the engine's `record` with a fixed budget of 300,000 gas (`ENGINE_GAS_LIMIT`). The figures come from `eth_estimateGas` sent from the registry's address, less the 21,000 intrinsic gas and the calldata:

- **Program not cached, key never recorded (the worst case):** about 90,100 gas.
- **Program not cached, key already holding outcomes:** about 63,000 gas, for a pass and for a failure alike.

Both are well inside the budget, so the program was not cached through ArbOS's CacheManager, and no `EngineRecordFailed` was emitted.

## Purchase 1: passed

The agent previewed, bought (0.25 USDC), applied the release and ran its acceptance test, which passed. The signed receipt was verified, and the evaluator finalized PASSED with full weight; the registry recorded it into the engine.

- Resolution `0x5cf4090b3c1bd3b2ce0b028f743192c3f4ebba1e8450a9c8bdcc988ae97cab79`.
- Server code: `apps/server` exactly as at PR #55's head `1d98041` (tree `7b6abbc…`), before `main`'s later fixes.

| Step | Sent by | Transaction | Gas used | Cost (testnet ETH) |
| --- | --- | --- | ---: | ---: |
| Settlement (x402, EIP-3009) | facilitator | [`0x58792e54…e07693`](https://sepolia.arbiscan.io/tx/0x58792e541b6bb4024d93dc750c8cf2b84ee88a2c43f066b6e3e2f3a340e07693) | 91,275 | 0.0000033 |
| Warranty activation | provider | [`0x881b5bcf…5cf201`](https://sepolia.arbiscan.io/tx/0x881b5bcf18ca707e61f3e67419c33bc8d4e172b31627f002e0497d2b5b5cf201) | 216,065 | 0.0000080 |
| Outcome PASSED, recorded into the engine | evaluator | [`0x08e34b4d…5a060a`](https://sepolia.arbiscan.io/tx/0x08e34b4db84c9e908accfce915d9bf1c5a1814ff0ffafb16031d364fb45a060a) | 146,896 | 0.0000053 |

## Purchase 2: failed, then refunded

This agent's repository failed the acceptance test after the release was applied. Its receipt waited for the evaluator's review (`EVALUATOR_FAILURES=review`), and the evaluator decided FAILED with `npm run evaluator -w @lemma/server -- decide`. The registry turned the reserved bond into the buyer's credit. The agent's `lemma_claim_refund` sent the claim to the server, and the evaluator relayed the withdrawal to the refund address, which then held 0.25 testnet USDC.

- Resolution `0xfe96a8cbcd859ab00c09bc0762e6346e63fd7941940354e0922f2ffc1db9b43e`.
- Server code: `main` at `fa7a0aa` plus the `warranty/block-times` fix (`d13b756`).

| Step | Sent by | Transaction | Gas used | Cost (testnet ETH) |
| --- | --- | --- | ---: | ---: |
| Settlement (x402, EIP-3009) | facilitator | [`0xb6a9dd4d…d75b14`](https://sepolia.arbiscan.io/tx/0xb6a9dd4daa4e78c879194cd1c9b7a3ee73d36d04a36be3217e5007a6c4d75b14) | 92,582 | 0.0000034 |
| Warranty activation | provider | [`0xd4f2eb49…a665ce`](https://sepolia.arbiscan.io/tx/0xd4f2eb492ce8ac5e7bd88d6cffcb9ab0a8bd33816b031c1264a9c0d120a665ce) | 217,797 | 0.0000078 |
| Outcome FAILED, recorded into the engine | evaluator | [`0xe2e4b36a…71efd0`](https://sepolia.arbiscan.io/tx/0xe2e4b36a88e71a7f7faf77a12aa3673f34141faa2502fc65b8d5ceed8971efd0) | 143,877 | 0.0000052 |
| Credit withdrawal to the refund address | evaluator (relay) | [`0x4d501efa…adf950`](https://sepolia.arbiscan.io/tx/0x4d501efa6df5390e81980ad5508d322eec602ddfbb06b97eaa1d00f69cadf950) | 84,009 | 0.0000030 |

**After both purchases**
- **Engine:** pass 0.998997… and fail 1.0 (WAD, decayed to the second outcome's block), over the prior of 4 passed and 1 failed. That gives **4086 bps at an effective n of 6.998**.
- **Server:** the catalog shows the same 4086 bps and 6.998, and so does `npm run sepolia:check`'s local fold at header times.
- **Registry:** holds 0.75 testnet USDC, exactly its remaining bond.
- **Cost:** each purchase cost under 0.00002 testnet ETH in gas across all its transactions. The buyer paid no gas.

## Incident: registry events dated 1970

**What happened**
- The official endpoint, `https://sepolia-rollup.arbitrum.io/rpc`, answers `eth_getLogs` with `"blockTimestamp": "0x0"` in every log.
- The server's indexer used that field, so the three events it had indexed after the first purchase were stored as 1970-01-01.
- The catalog's confidence folded the passing outcome at 1970 and decayed it to nothing. It showed 4352 bps at an effective n of 5.000, while the engine held 4975 bps at 5.999.

**The fix:** `warranty/block-times` dates events by their block headers only, and refuses a stored time before 2015-07-30.

**The repair**, once, before the second purchase, as [Repairing registry event block times](../deployment.md#repairing-registry-event-block-times) describes:
- The database was dumped first.
- The header times were read from both the official endpoint and publicnode, which agreed.
- The three rows were updated in one transaction.

Afterwards the server and the engine agreed (4975 bps at 5.999, then 4086 at 6.998). No ERC-8004 feedback had been posted, so no on-chain evidence carries a 1970 time.

## Not done in this run

- **ERC-8004.** No agent was registered and no feedback was posted (runbook step 8, and the feedback in step 10). Both need a hosted server at a public https URL.
- **A hosted deployment.** The server, the dashboard and Postgres ran on one machine. Nothing is served publicly.
- **Arbiscan source verification.** The registry needs an Etherscan API key. The engine was deployed without a reproducible build.
- **Lost-response recovery on the live chain.** It is shown on the local chain (`npm run e2e`) only.
- **Measured evidence.** The release has made-up evidence (`demo-1`). Nothing on this page is a claim about savings or prices.
