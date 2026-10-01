# Arbitrum Roadmap: Bounded Spending and Private Compatibility Proofs

Section 6 of [arbitrum.md](arbitrum.md) analyzes four ways Lemma could use Arbitrum beyond payments. Two are built and merged (ERC-8004 reputation and a Stylus confidence engine). This document covers the other two in depth, because both are **roadmap items: documented, not built**:

1. **Bounded spending** with ERC-7715 and ERC-7710: the chain, not only the bridge, limits what an agent can spend.
2. **Zero-knowledge compatibility proofs**: a buyer proves its repository fits a release without revealing the repository's profile.

Everything here is on testnet. Amounts are test USDC and Sepolia ETH, unless a line says Arbitrum One. Facts were read on September 27, 2026 from the sources listed at the end. Numbers marked **estimate** are our own arithmetic from code paths or published figures, not Lemma measurements. Nothing was read on chain on September 27, because this build environment could not reach Arbitrum's RPCs then. The addresses in section 1.3 were read on chain on October 1, 2026.

**How gaps are marked.** Lemma's hard rule is that the MCP experience stays fast and nearly hands-free (the UX rules are in [arbitrum.md, section 6.4](arbitrum.md#64-ux-rules-every-integration-follows)). Every part below that would add a manual blockchain step, a wait inside an agent's tool call, or a heavy install is marked **UX gap: holds implementation**, followed by what would lift it. Section 3 collects them in one table.

## 1. Bounded spending (ERC-7715 and ERC-7710)

### 1.1 What it would replace

Today's design, which the paid path ships:

- **The policy is code.** Core `checkPurchase` checks network, token, recipient, amount and the daily cap before anything is signed. The bridge keeps a spending ledger.
- **The buyer key lives in a separate signer process.** Acceptance tests run as the user and can read the user's files and the bridge's start environment (`/proc`), so the key cannot sit in the bridge. The paid path ships `lemma-signer`, a separate process on a private Unix socket that holds the key and enforces the policy again itself, because every process of the user can reach the socket. It only signs USDC transfers on Arbitrum Sepolia to an allowed payee, within the per-purchase cap, its own rolling daily cap and a short authorization window.
- **The weak point.** The policy is only as strong as the code that holds the key. The bridge README asks for a signer "that runs as another user, or on a hardware or remote signer". That is the heaviest setup step in the product.

A delegation moves the daily cap, the token, the payee and an expiry onto the chain. Then a compromised bridge, a leaked session key, or an acceptance test that reads the key can spend at most the daily cap, only in USDC, only to Lemma's provider, and only until the expiry. Money can only reach the payee, so a thief cannot take funds; the worst case is unwanted purchases within the cap. That bounded worst case is what would let the bridge keep its own session key and retire the separate signer.

| | Paid path (EIP-3009, built) | With a delegation (roadmap) |
| --- | --- | --- |
| Where the buyer's main key lives | In `lemma-signer`, used for every purchase; ideally another user or a hardware or remote signer | Used twice at setup, then can go offline (a hardware wallet or cold storage) |
| What signs each purchase | The main key, through the signer | A session key the bridge holds |
| Daily cap, token, payee, expiry | Enforced by the bridge and the signer | Enforced by the chain |
| Per-purchase cap | Enforced by the bridge and the signer | Still enforced by the bridge (section 1.7) |
| Worst case if the bridge or a test is compromised | Bounded only if the signer is out of the attacker's reach | At most the daily cap, paid only to Lemma's provider, until expiry |
| x402 payment method | EIP-3009 `transferWithAuthorization` | ERC-7710 `redeemDelegations` (x402 `exact`, `assetTransferMethod: "erc7710"`) |
| No second payment per resolution | A nonce derived from the resolution and the preview id; USDC refuses a reused nonce | Needs its own design (section 1.5) |
| Gas per purchase | 91,275 and 92,582 for the two settlements on Arbitrum Sepolia on October 1, 2026 (measured; the estimate was about 80,000) | About 200,000 to 280,000 (estimate) |

What stays the same: `checkPurchase`, the ledger, recovery after a lost answer, and the `Signer` interface. The paid path keeps its signer behind that one interface, so a delegation signer can replace the EIP-3009 key later without touching the tools.

**Why not keep EIP-3009 and just use a smart account?** A smart account can accept EIP-3009 signatures through ERC-1271, but ERC-1271's `isValidSignature` is a `view` function. It cannot record what was spent, so it cannot enforce a daily cap. The cap has to be enforced when money moves, which is what ERC-7710's caveat enforcers do.

### 1.2 The standards and their status

- **ERC-7715, "Request Permissions from Wallets"** [1]. Status Draft, created May 24, 2024; it requires ERC-4337 and ERC-7710.
  - An app asks the wallet for an execution permission with `wallet_requestExecutionPermissions`. Related methods revoke a permission and list the supported and granted ones. An older name, `wallet_grantPermissions`, survives in viem's experimental action [19], so tutorials disagree.
  - A request names the chain, the account (`from`), the session account that will use the permission (`to`), a permission type with its data, and rules such as an `expiry`. `isAdjustmentAllowed` lets the wallet grant more or less than asked; Lemma would set it to `false` and read the granted values back.
  - The answer carries a `context` (the permission context), `dependencies` (contracts to deploy first) and the `delegationManager` address.
  - MetaMask's spending types include `erc20-token-periodic` (an amount per period), `erc20-token-stream` and `erc20-token-allowance`, and its rules include `expiry`, `redeemer` (who may use the permission) and `payee` (the only recipient) [4].
- **ERC-7710, "Smart Contract Delegation"** [2]. Status Draft, created May 20, 2024; it requires ERC-1271 and ERC-7579.
  - The session account spends a permission by calling `redeemDelegations(permissionContexts, modes, executionCallData)` on the delegation manager.
  - A delegation names a delegate, a delegator, an authority (for chains of delegations), caveats (each an enforcer contract with its terms), a salt and a signature.
  - The spec says to check a delegation by simulating the call.
- **How MetaMask's `DelegationManager` executes a transfer** (from its source [3]): the leaf delegation, which comes first in the permission context (ordered leaf to root), must name the caller as its delegate, or the open delegate `ANY_DELEGATE` (`0xa11`); each signature is checked (ECDSA for a plain account, ERC-1271 for a contract); disabled delegations are refused; every caveat's hooks run before and after the call; the root delegator executes the transfer; and a `RedeemedDelegation` event logs the full delegation.
- **EIP-7702 on Arbitrum.** ArbOS 40 added EIP-7702 on Arbitrum Sepolia on May 6, 2025 and on Arbitrum One on June 17, 2025 [13][14]. An existing externally owned account signs an authorization that points it at delegation code, and a type-4 transaction carries that authorization; the address does not change [12]. Any account may send that transaction and pay its gas [12], so Lemma's facilitator can do it and the user needs no ETH. After the upgrade to MetaMask's `EIP7702StatelessDeleGatorImpl`, the account still accepts signatures by its own key through ERC-1271 [3], so the plain EIP-3009 path keeps working.

### 1.3 MetaMask Delegation Framework on Arbitrum

MetaMask's Delegation Framework v1.3.0 is deployed at the same addresses on Arbitrum One and Arbitrum Sepolia (deterministic deployment with the salt "GATOR") [3]. Its deployment receipts show the first deployments on Arbitrum One on March 28, 2025 and on Arbitrum Sepolia on May 14, 2025 [3]. The v1.3.0 tag ships audit reports by Consensys Diligence (2024 and 2025) and Cyfrin (2025) in its `audits/` folder [3]. The table names, for each contract, the reports whose scope includes it (read October 1, 2026). None names the v1.3.0 tag itself; each reviewed the development commit it names.

| Contract | Address (Arbitrum One and Arbitrum Sepolia) | Role for Lemma | Audit reports (`audits/` at v1.3.0) |
| --- | --- | --- | --- |
| `DelegationManager` | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` | Redeems delegations; the facilitator calls it | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24`, `diligence-9-24` |
| `EIP7702StatelessDeleGatorImpl` | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` | The code the buyer's account points at after EIP-7702 | `cyfrin-3-25`, `diligence-2-25` |
| `HybridDeleGatorImpl` | `0x48dBe696A4D990079e039489bA2053B36E8FFEC4` | A deployed smart account instead of an upgraded one | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24`, `diligence-9-24` |
| `ERC20PeriodTransferEnforcer` | `0x474e3Ae7E169e940607cC624Da8A15Eb120139aB` | The daily cap: an amount per period, only through `transfer` | `cyfrin-4-25` |
| `ERC20TransferAmountEnforcer` | `0xf100b0819427117EcF76Ed94B358B1A5b5C6D2Fc` | A total cap; used per payment to cap it at the price | `cyfrin-3-25`, `diligence-8-24` |
| `AllowedCalldataEnforcer` | `0xc2b0d624c1c4319760C96503BA27C347F3260f55` | Pins the transfer's recipient to Lemma's payee | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24` |
| `TimestampEnforcer` | `0x1046bb45C8d673d4ea75321280DB34899413c069` | The expiry | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24` |
| `RedeemerEnforcer` | `0xE144b0b2618071B4E56f746313528a669c7E65c5` | Only the named facilitator may redeem | `cyfrin-3-25`, `diligence-8-24` |
| `ValueLteEnforcer` | `0x92Bf12322527cAA612fd31a0e810472BBB106A8F` | No ETH moves (value 0) | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24` |
| `LimitedCallsEnforcer` | `0x04658B29F6b82ed55274221a06Fc97D318E25416` | At most one redemption per delegation (section 1.5) | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24` |
| `NonceEnforcer` | `0xDE4f2FAC4B3D87A1d9953Ca5FC09FCa7F366254f` | Revokes all earlier delegations at once | `cyfrin-3-25`, `diligence-6-24`, `diligence-8-24` |

The reports: Cyfrin, March 18, 2025 (`cyfrin-3-25`) and April 1, 2025 (`cyfrin-4-25`); Consensys Diligence, June 2024 (`diligence-6-24`), August 2024 (`diligence-8-24`), October 2024 (`diligence-9-24`) and February 2025 (`diligence-2-25`). The other reports in the folder (`diligence-4-25`, `cyfrin-5-25-part1` and `-part2`) review none of these contracts.

**Read on chain on October 1, 2026.**
- Every address holds code on both chains.
- The eight enforcers are byte-identical on Arbitrum Sepolia and Arbitrum One.
- `DelegationManager` and the two DeleGator implementations differ between the chains only in the chain id and the EIP-712 domain separator they store, and all three return `VERSION()` "1.3.0".
- Both DeleGator implementations point at this `DelegationManager` and at the ERC-4337 EntryPoint v0.7 (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`). `HybridDeleGatorImpl` also links the `SCL_RIP7212` library at `0xCCD3B747F3DBd349fa3af4eBC7d0C31aE6f21dd1`, which has code on both chains.
- Each contract's compiler metadata hash commits to source files identical to the v1.3.0 tag (solc 0.8.23, 200 optimizer runs). A fresh build of the tag compared byte for byte is still to do (section 1.9).

There is no stock enforcer that caps a single ERC-20 transfer. The per-purchase cap therefore comes from the per-payment delegation the bridge signs (section 1.4), or would need a custom enforcer.

### 1.4 x402 and the facilitator gap

**x402 already supports this.** The `exact` scheme on EVM lists three ways to move the asset: EIP-3009 (the default), Permit2, and ERC-7710, which the spec calls the "Smart Account Option", usable once or many times [9].

- The payment requirements carry `extra.assetTransferMethod: "erc7710"`, and the payload carries `delegationManager`, `permissionContext` and `delegator`.
- How the payer obtains the delegation "is outside the scope of x402"; ERC-7715 is one way.
- The facilitator encodes `transfer(payTo, amount)`, simulates `redeemDelegations`, and then sends the same call. "The simulation serves as the sole verification mechanism—no trusted list of Delegation Manager implementations is required" [9].
- The spec names two risks for the facilitator [9]: the payer can invalidate the delegation between the simulation and the transaction, which makes the facilitator pay gas for a failed transaction; and a malicious delegation manager can burn gas, so the facilitator must set an explicit gas limit.

**The gap.** The facilitator side is missing on Arbitrum.

- The reference facilitator in `@x402/evm` implements EIP-3009 and Permit2 only [10]. The version Lemma installs, 2.27.0, contains no `erc7710` or `redeemDelegations` code (checked in `node_modules` on September 27, 2026).
- MetaMask's `@metamask/x402` 1.0.0 provides the client and server sides (`x402Erc7710Client`, `x402Erc7710Server`, `x402ExactEvmErc7710ServerScheme`) but no facilitator [5]. Its delegation provider signs a new delegation for each payment, limited to the price (`ERC20TransferAmountEnforcer`), the payee and the facilitator as redeemer, with an optional expiry. Passing the granted permission's context as the parent makes each payment spend from the user's standing budget [5].
- MetaMask's hosted facilitators cover only Base, Base Sepolia and Monad [4][5]. A seller must advertise `assetTransferMethod: "erc7710"` itself [8].
- Fireblocks publishes an open-source facilitator that supports `erc7710`, but it settles through Fireblocks [11].

So **Lemma's own facilitator would add ERC-7710 settlement**: simulate `redeemDelegations`, then submit it with an explicit gas limit. Lemma stays standard x402, and the paid tool advertises both methods.

### 1.5 Two setup paths

#### Path A: self-managed delegation, headless (recommended)

MetaMask's own x402 guide describes a local root key as "Best for AI agents and backend services" [5].

One-time setup, run by one command (a future `lemma-mcp setup`):

1. The bridge creates a session key in its private state directory.
2. The user's key (the buyer wallet that the paid path's signer holds) signs an EIP-7702 authorization that points the account at `EIP7702StatelessDeleGatorImpl`. Lemma's facilitator sends the type-4 transaction, so the user needs no ETH. It costs about 21,000 gas plus 25,000 per authorization, part of which is refunded for an account that already exists [12].
3. The same key signs one root delegation to the session key, with these caveats: `ERC20PeriodTransferEnforcer` (USDC, the daily cap, a period of 86,400 seconds), `AllowedCalldataEnforcer` (the payee), `TimestampEnforcer` (the expiry) and `ValueLteEnforcer` (0). The root delegation is an off-chain signature and costs nothing until it is used.
4. The user's key is then not needed for purchases, and can go offline.

Each purchase afterwards:

- The bridge's session key signs a per-payment delegation to the facilitator, chained to the root delegation, limited to the price, the payee and a short expiry. This is local, takes milliseconds, and makes no chain call.
- **No second payment per resolution.** In the paid path, USDC refuses a reused EIP-3009 nonce, and the nonce is derived from the resolution and the preview id. ERC-7710 has no such nonce, so the design must carry the property over. A proposal to prove in a fork test first: derive every field of the per-payment delegation from the resolution (the salt from the same derived nonce, the amount and payee from the terms, the expiry from the quote), and add `LimitedCallsEnforcer` with a limit of 1. That enforcer counts redemptions per delegation hash [3], and the hash does not cover the signature, so a retry signs the same delegation and the chain refuses to redeem it twice. The server's own one-payment-per-resolution guard stays.
- **Budget checks.** `ERC20PeriodTransferEnforcer` has a view, `getAvailableAmount`, that shows the remaining daily budget [3]. The bridge must not call it inside a tool call (UX rule 1), so it keeps its own ledger as the first check, and the facilitator's simulation is the last one. A budget that is used up fails the simulation, and the paid call answers with a code and charges nothing.

Renewal and revocation:

- **Renewal.** At the expiry, purchases stop until the user's key signs a new root delegation. **UX gap: holds implementation** while the expiry is short. It lifts with a long default expiry (the daily cap bounds the risk), a short code in preview answers well before the expiry, and renewal by rerunning the one setup command.
- **Revocation.** `disableDelegation` can be called only by the delegator account, as an on-chain transaction [3], so it needs ETH in the account or a sponsored ERC-4337 operation. Pimlico's free plan sponsors testnet operations on Arbitrum Sepolia and lists EIP-7702 support [15]. **UX gap: holds implementation** for an emergency revoke until a sponsored `lemma-mcp revoke` exists. Until then, the user can move the USDC out with the main key.

This path fits UX rule 5: one automated setup step, then no clicks.

#### Path B: MetaMask Advanced Permissions (ERC-7715 in the browser)

Funds stay in the user's MetaMask. The steps [4][6][7]:

1. MetaMask's browser extension, version 13.23.0 or later. That release (March 19, 2026) "Enables token permissions via EIP-7715"; 13.32.1 (May 28) added allowance types, and 13.38.0 (July 3) enabled ERC-7715 requests "over the Multichain API and MetaMask Connect". MetaMask Mobile's changelog has no entry adding the method. MetaMask lists Arbitrum One and Arbitrum Sepolia as supported.
2. The account must be upgraded to a MetaMask smart account (EIP-7702). MetaMask prompts for the upgrade during the request (search summary only, not verified [32]); whether that needs Sepolia ETH could not be verified either.
3. The bridge opens a local page (for example `http://127.0.0.1:<port>/grant`) that requests `erc20-token-periodic` for USDC with the daily cap, a period of 86,400 seconds, an expiry, a `payee` rule and `isAdjustmentAllowed: false`. The user clicks Approve, which is a signature, not a transaction. The bridge stores the context and the delegation manager's address.
4. At each expiry, step 3 repeats. Revoking costs gas.

MetaMask cannot be asked headlessly. Every documented request goes through the extension's `window.ethereum`, and MetaMask's docs add that "Regular delegations cannot be signed through the MetaMask extension" [4].

**UX gap: holds implementation** for this path, for four reasons: it needs the desktop extension (no mobile, no headless use), a smart-account upgrade that may need ETH, a browser approval page per grant, and a renewal at each expiry. It lifts when all of these hold: a one-click local grant page works end to end with MetaMask 13.23 or later on Arbitrum Sepolia; the upgrade is shown to need no ETH, or is sponsored; the expiry is long and a revoke button exists; and MetaMask Connect is shown to serve users without the extension.

#### Alternatives considered

- **Coinbase Spend Permissions:** on Arbitrum One but not Arbitrum Sepolia, and `spend()` pays the spender, which only the spender can call. That is a seller-side pull, not an x402 payment [16].
- **Safe Allowance Module:** deployed on Arbitrum One with no Arbitrum Sepolia entry; no recipient restriction; three or more owner transactions to set up [17].
- **ERC-4337 session-key accounts** (ZeroDev, Rhinestone, Biconomy, Alchemy): a new account or module, a bundler and a paymaster, which add latency and gas. None fits x402 `exact`.
- **A custom agent account**, as VeriPay built for this buildathon: per-payment, payee, expiry and total-budget limits in its own contract, but a lifetime budget rather than a daily one, several owner transactions, and not standard x402 [18].

### 1.6 Gas and latency

All gas figures in this table are **estimates** from MetaMask's code paths (an x402 payment redeemed through two delegations with about nine caveats), made on September 27, 2026. No measured figure was reachable. Measure one real Arbitrum Sepolia transaction before quoting them.

| Part of an ERC-7710 purchase transaction | Gas (estimate) |
| --- | --- |
| Base cost and about 3 to 4 KB of calldata | about 55,000 |
| Two signature checks and revocation lookups | about 20,000 |
| About 40 caveat hook calls | about 50,000 to 70,000 |
| Enforcer storage writes | about 40,000 |
| The USDC `transfer` | about 30,000 |
| Two `RedeemedDelegation` logs | about 25,000 |
| **Total per purchase** | **about 200,000 to 280,000** |

- That is about 2.5 to 3.5 times a plain EIP-3009 transfer (about 80,000 gas, also an estimate; [arbitrum.md](arbitrum.md) section 1).
- The first purchase under a new permission costs about 90,000 more (estimate), because the period enforcer fills empty storage slots.
- **In ETH.** Arbitrum One's minimum L2 base fee was set to 0.02 gwei on January 8, 2026, and since ArbOS 61 it can change without a governance vote [14], so re-check it before quoting. At 0.02 gwei, 200,000 to 280,000 gas is 0.000004 to 0.0000056 ETH, against 0.0000016 ETH for a plain transfer, plus an L1 data fee that grows with the larger calldata.
- **Against the price bound.** At an assumed 3,000 USD per ETH, the difference is about one US cent per purchase, before the L1 data fee. In the worked example of [economic-gates.md](economic-gates.md) (assumptions, not data: C = 2.50, S = 1.30), the 30% rule caps the price at 0.39 USDC for any chain cost `g` up to 0.285 USDC, so an extra cent leaves the price unchanged. The facilitator pays the gas, so it comes out of the provider's margin: about 0.34 USDC per resolution before evidence cost in that example (q = 0.10, g = 0.01; assumptions, not data).
- **Latency.** Per purchase, the bridge signs locally and the facilitator runs one simulation and one transaction: the same shape as today's EIP-3009 settlement. Setup adds one type-4 transaction, sent by Lemma's facilitator.

### 1.7 Trust points

- **MetaMask's `DelegationManager` can be paused.** It is `Ownable2Step` and `Pausable`, and its owner can pause all redemptions [3]. On October 1, 2026 the owner on both chains was an externally owned account (`0xB0403B32f54d0Bd752113f4009e8B534C6669f44`) and the manager was not paused. On Arbitrum One a transfer of ownership to `0xA428CCb39C71CdD0b19888eAca103D92B7384104` had been started but not accepted. A pause stops purchases (liveness), but cannot move funds. The fallback is the main key, which can still sign EIP-3009 transfers through the account.
- **The account's code.** After EIP-7702, the buyer's account runs `EIP7702StatelessDeleGatorImpl`. A flaw there would affect the account. Cyfrin (March 2025) and Consensys Diligence (February 2025) reviewed it at the commits their reports name (section 1.3).
- **The per-purchase cap stays in the bridge.** The session key signs each per-payment delegation, so a stolen session key can sign one for up to the remaining daily budget. The daily cap, the token, the payee and the expiry are the chain's guarantees; the per-purchase cap is not.
- **The period enforcer does not check value.** At v1.3.0, `ERC20PeriodTransferEnforcer` checks the token, the `transfer` selector and the amount, but not that no ETH moves. In its answer to Consensys Diligence's April 2025 finding 4.12, MetaMask says to combine the period enforcers with other caveats for the calldata or the value. So `ValueLteEnforcer` with 0 stays part of every delegation.
- **The facilitator carries a griefing risk.** A payer can invalidate a delegation between the simulation and the transaction, making the facilitator pay for a failed transaction [9]. The answers are an explicit gas limit, a rate limit per delegator, and an allowlist of the one `DelegationManager` address Lemma accepts (stricter than the spec requires).
- **What becomes public.** `RedeemedDelegation` logs the full delegation [3], so the buyer's account, its session key, the daily cap and the payee become public. The payer-to-payee link already exists with EIP-3009. The budget is new public information.
- **Draft standards.** Both ERCs are Drafts. ERC-7715 already renamed its method once.

### 1.8 What would change in Lemma

- **Core:** `paymentRequirementsFor` would produce a second `accepts` entry with `assetTransferMethod: "erc7710"`, and `checkPurchase` would learn to check it. `PaymentTerms` mirrors x402 v2's requirements and has no field for the method today, so recording the method with a resolution is a schema change: a new version, digest vectors updated deliberately (`LEMMA_WRITE_VECTORS=1`), and a note in the PR.
- **Server:** an ERC-7710 verify and settle path beside `ExactEvmScheme`, with the gas limit, the rate limit and the manager allowlist above.
- **Bridge:** a session-key signer behind the paid path's `Signer` interface, built on `@metamask/smart-accounts-kit` and `@metamask/x402` rather than hand-built delegation encoding; the setup command; an emergency revoke.
- **Docs:** [security-model.md](security-model.md) (the session key, the main key's new role, the trust points above), [apps/bridge/README.md](../apps/bridge/README.md) and [deployment.md](deployment.md).

Contracts, x402 facilitator code, signing and typed-data layouts belong to the protocol owner (`CLAUDE.md`), so this work needs that owner's review.

### 1.9 Checklist for starting

- [x] The plain x402 paid path (EIP-3009) is merged and has settled a real purchase on Arbitrum Sepolia: two on October 1, 2026 ([deployments/arbitrum-sepolia.md](deployments/arbitrum-sepolia.md)).
- [x] Read the bytecode at each address in section 1.3 on both chains, tie it to the v1.3.0 sources through its metadata, and record which audit report covers each contract (October 1, 2026).
- [ ] Build the v1.3.0 tag (solc 0.8.23) and compare each contract's runtime code byte for byte, apart from the chain id and domain separator the DeleGators and the manager store.
- [ ] Measure the gas of one real ERC-7710 x402 payment on Arbitrum Sepolia. Replace the estimates in section 1.6, and the chain cost `g` in `packages/catalog/economics.json` if it changes.
- [ ] Prove, in a fork test, that a retried payment for the same resolution is refused on chain (derived delegation fields plus `LimitedCallsEnforcer`).
- [ ] Check whether `@metamask/x402`'s delegation provider accepts a caller-chosen salt and extra caveats. If not, contribute that upstream rather than forking it.
- [ ] Teach core's `paymentRequirementsFor` and `checkPurchase` the second method. If the method is recorded with a resolution, make that schema change with deliberate vector updates and a PR note.
- [ ] Add ERC-7710 settlement to Lemma's facilitator. Prefer reusing an existing open-source implementation (upstream x402, or Fireblocks' facilitator if its license allows) over new code, with the gas limit, rate limit and manager allowlist.
- [ ] Build `lemma-mcp setup` as one automated step: the session key, the EIP-7702 authorization and the root delegation, with the type-4 transaction sent by Lemma's facilitator.
- [ ] Build a sponsored `lemma-mcp revoke`.
- [ ] Update the security model, the bridge README and the deployment guide, and get the protocol owner's review.

## 2. Zero-knowledge compatibility proofs

### 2.1 The idea

Today the bridge sends the server an allowlisted repository profile: language, Node major, package manager, module system, frameworks, and the exact versions of the dependencies in the catalog's published interest set. The server matches it against the catalog. A zero-knowledge proof would let a buyer show that its repository fits a release's supported profile without revealing the profile: privacy-preserving procurement for agents. It is also the private form of idea H in [arbitrum.md](arbitrum.md) section 3, an on-chain fit check that would otherwise need the buyer's profile on chain.

### 2.2 What a proof can say, and what it cannot

**What it can say.** A small circuit can prove: "I know a profile P and a salt s such that Poseidon(P, s) = C, and P satisfies the constraints R of profile i of release D." C, R (or its digest), i and D are public; P and s stay private. P would be a fixed-width encoding: a language id, the Node major, package-manager and module-system ids, a framework bitmask, and fixed dependency slots of (name hash, major, minor, patch). C could also commit to a hash of the lockfile, for a later dispute.

**What it cannot say.** It cannot prove that P is the repository's real profile. The input is self-attested. ERC-8262's authors state the same limit for their compliance proofs: a self-attested prover "could in principle pass `signals = [0, ...]` and produce a valid 'low-risk' proof regardless of their true screening result" [20]. So a proof does not stop the attack that matters most to a warranty: a buyer claiming a fit it does not have, then claiming a refund. Today's profile is self-attested too; a proof hides it but does not make it truer.

**Bindings that could close the gap:**

- **GitHub Actions OIDC token** (the only one that looks practical soon). GitHub signs a token carrying `repository`, `repository_id`, `ref`, `workflow_sha` and `job_workflow_ref`, and `core.getIDToken(audience)` sets a custom audience [29]. A Lemma-owned reusable workflow would compute C from the checked-out repository and request a token whose audience is C. Lemma can check the token off chain, which is fast but tells Lemma which repository it is, or inside a Noir circuit with noir-jwt, which supports RS256 with 2048-bit keys [30] and has no published performance figures we could find. Either way it runs in CI, not per purchase, and only for repositories that use GitHub Actions. **UX gap: holds implementation** for anyone working locally. It lifts as an opt-in for teams whose CI already runs, with the workflow file written by one command and pinned by commit.
- **zkTLS** (proofs about HTTPS responses): Reclaim's zkFetch installs about 141.6 MB and relies on its attestor server [31]; TLSNotary runs as a Rust sidecar [21]. Trust moves to the attestor, and the repository path can leak through the URL. Not a near-term option.
- **TEE attestation:** not a near-term option.
- **Signed commits:** they bind content to a key, not to the repository's real lockfile.

### 2.3 What it costs

| System | Proving time | Install size | On-chain verification | Setup |
| --- | --- | --- | --- | --- |
| Noir with Barretenberg (UltraHonk) | 137.6 ms median for a trivial circuit in Node on 2 CPUs [21]; with the native prover (`bb` 0.63.0, on a laptop), 0.52 s at 2^12 gates, 1.13 s at 2^15 and 1.73 s at 2^16 [22] | `@aztec/bb.js` 5.2.0: 156,572,374 bytes unpacked (about 157 MB) [24]; the native `bb` binary about 44.6 MB [23] | About 2.43 million gas [20]; raw generated verifiers came out 64 to 65 bytes over the 24,576-byte contract limit until patched [20] | No per-circuit trusted setup |
| Circom with snarkjs (Groth16) | 143 ms for a trivial circuit [21]; 4.1 to 4.7 s for AegisClear's 115,066-constraint circuit [25] | `snarkjs` 0.7.6: 9,671,132 bytes unpacked (about 9.7 MB) [24], plus the circuit's files and proving key | 229,241 gas measured by AegisClear with 6 public inputs [25]; about 181,000 plus 6,150 per public input by the pairing prices of EIP-1108 [26] (derived) | A trusted setup: whoever runs a single-party setup can forge proofs [25] |
| zkVMs (SP1, RISC Zero) [28] | About 19 s for a trivial RISC Zero receipt on a CPU, and compressing it for on-chain use "needs GPU" [21] | Large | About 270,000 gas for an SP1 Groth16 proof, or 300,000 for PLONK, by Succinct's docs [28] | Ruled out for per-purchase use |

- **Per purchase** (derived from the native prover's figures above): a small predicate of 2^12 to 2^15 gates should prove in about 0.5 to 1.1 seconds. A trivial circuit in `bb.js` takes about 0.14 seconds, but a real predicate is larger. **UX gap: holds implementation.** It lifts when proving happens outside the purchase call, for example in the background right after a preview that found an offer, and is reused while the profile is unchanged, and when a measurement shows no added wait on the purchase path.
- **Install:** about 157 MB for the Noir prover package, or a 44.6 MB native binary, next to a bridge that is small today. **UX gap: holds implementation.** It lifts when the prover is an optional component installed only for users who opt in, with the default install unchanged. snarkjs is smaller, but Groth16 needs a trusted setup with several independent contributors.
- **Stylus does not make verification cheaper.** The pairing check is a precompile at the same price either way. A Groth16 verifier written for Stylus cost 256,334 gas against 194,396 in Solidity [27], and AegisClear kept its verifier in Solidity: "We do not claim that Stylus makes ZK cheaper" [25].
- **On-chain cost, and why to verify only in disputes** (estimates, assuming Arbitrum One's 0.02 gwei minimum base fee [14] and 3,000 USD per ETH): a Groth16 check is about 0.0000046 ETH (about 1.4 cents), and an UltraHonk check about 0.00005 ETH (about 15 cents) plus the L1 fee for a 14.6 KB proof. Charged on every purchase, 15 cents would cut the worked example's provider margin in [economic-gates.md](economic-gates.md) (about 0.34 USDC before evidence cost, with q = 0.10 and g = 0.01; assumptions, not data) to about 0.19 USDC. Verification belongs off chain by default, and on chain only in a dispute.
- **Privacy stays partial.** The constraints R are public, and the sender of an on-chain proof links purchases unless a relayer sends it.

### 2.4 The salted profile commitment it needs first

Today's `profileDigest` (core `profileDigest`, a keccak256 over the canonical JSON of the profile) is **unsalted**, and the space it covers is small: two languages, a few Node majors, three package managers, two module systems, a handful of frameworks, and released versions of a few dependencies. Anyone holding a published digest could try candidates until one matches. That is why Lemma keeps it off the chain and out of the public `ResolutionView`, and why no proof can be built on it.

A proof needs a **salted profile commitment** first:

- C = Poseidon(encode(P), s), with a random 32-byte salt s that the bridge makes per purchase and keeps in its inbox, as it will for the warranty claim secret.
- Poseidon over a fixed-width field encoding, because keccak256 over JSON is very expensive inside a circuit. Use the proving system's own standard implementation (Noir's standard library, or circomlib), never a new one.
- The encoding of P is fixed by core and shared with the circuit through test vectors, as the confidence engine shares its vectors.
- The bridge sends C with the purchase, and the server stores it in the `Resolution`. If the warranty registry should hold it, the provider's voucher carries it too.

**This is a schema change.** `Resolution` is a strict, versioned, persisted object, so adding the commitment means a new schema version, a deliberate update of `packages/core/test/vectors/digests.json` (`LEMMA_WRITE_VECTORS=1`) and a note in the PR. The voucher's typed-data layout belongs to the protocol owner. The commitment has no UX cost and can ship long before any proof.

### 2.5 The path

1. **The salted profile commitment** (section 2.4). No UX cost.
2. **An eligibility proof used only in warranty disputes.** When a buyer claims a refund, it proves that its committed profile fit the release, without revealing it publicly. The evaluator verifies it off chain, or the registry verifies it on chain only for disputes.
3. **CI-bound proofs for teams** that opt in, through the GitHub OIDC workflow.
4. **Later, private matching.** The bridge matches locally against the public catalog and sends only a proof. This would change the preview protocol, and the server's demand counts, which group previews by coarse repository class, would lose that class.

### 2.6 Checklist for starting

- [ ] Design the salted profile commitment and its fixed encoding in core, with shared test vectors. Make the schema change deliberately, with a PR note and the protocol owner's review for any voucher change.
- [ ] Run a spike that measures proving time on a reference laptop and the install size, for Noir (UltraHonk, no trusted setup) and for Circom (Groth16). Choose one.
- [ ] If Groth16: use a public phase-one ceremony and a phase-two ceremony with at least three independent contributors.
- [ ] Use the proving system's own standard library (Poseidon, comparisons) and its generated verifier. Write no cryptography by hand.
- [ ] Generate the circuit's constraints from the release manifest in `packages/catalog`, deterministically. Prove and refute the release's fixtures (exact, boundary, near-miss, unsupported) in tests.
- [ ] Decide where proofs are verified: off chain by the evaluator by default, on chain only in disputes, with the verifier under 24,576 bytes and its gas measured.
- [ ] Package the prover as an optional bridge component that is never on the purchase call's path.
- [ ] If CI binding is offered: a reusable workflow pinned by commit and reviewed with the `gha-security-review` skill.
- [ ] Update [security-model.md](security-model.md) with what the proof proves and what it does not.

## 3. UX gaps in one place

Each row holds implementation until the condition in the last column is met.

| Where | UX gap | What would lift it |
| --- | --- | --- |
| Bounded spending, path A | A short expiry makes the user renew by hand | A long default expiry (the daily cap bounds the risk), a warning code in preview answers ahead of time, and renewal by rerunning the one setup command |
| Bounded spending, path A | An emergency revoke is a transaction from the buyer's account and needs gas | A sponsored `lemma-mcp revoke` |
| Bounded spending, path B | Desktop extension only, a smart-account upgrade that may need ETH, a browser approval per grant, a renewal at each expiry | A proven one-click local grant page on Arbitrum Sepolia, a sponsored or ETH-free upgrade, a long expiry with a revoke button, and a working path without the extension |
| ERC-8004 validation requests from buyer agents ([arbitrum.md](arbitrum.md) section 6) | A transaction from the agent's owner for every adoption | A delegated, sponsored call through path A's machinery |
| ZK proofs | About 0.5 to 1.1 seconds of proving per purchase (2^12 to 2^15 gates, native prover) | Proving outside the purchase call, reused while the profile is unchanged, measured to add no wait |
| ZK proofs | About 157 MB for the Noir prover package | An optional prover installed only on opt-in |
| ZK proofs, CI binding | Needs a GitHub Actions run, so it is not hands-free for local work | An opt-in for teams whose CI already runs, set up by one command |

## Sources

1. [ERC-7715: Request Permissions from Wallets](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7715.md).
2. [ERC-7710: Smart Contract Delegation](https://github.com/ethereum/ERCs/blob/master/ERCS/erc-7710.md).
3. [MetaMask Delegation Framework](https://github.com/MetaMask/delegation-framework): the [deployment document](https://github.com/MetaMask/delegation-framework/blob/main/documents/Deployments.md), deployment receipts under `broadcast/`, the sources of `DelegationManager`, the enforcers and `EIP7702StatelessDeleGator`, and the `audits/` folder at the `v1.3.0` tag.
4. [MetaMask docs source for Smart Accounts Kit and Advanced Permissions](https://github.com/MetaMask/metamask-docs/tree/main/smart-accounts-kit).
5. [MetaMask Smart Accounts Kit](https://github.com/MetaMask/smart-accounts-kit), including `packages/x402` and its x402 guides.
6. [MetaMask extension changelog](https://github.com/MetaMask/metamask-extension/blob/main/CHANGELOG.md).
7. [MetaMask Mobile changelog](https://github.com/MetaMask/metamask-mobile/blob/main/CHANGELOG.md).
8. [Smart Accounts Kit issue #301](https://github.com/MetaMask/smart-accounts-kit/issues/301).
9. [x402 `exact` scheme on EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md).
10. [x402 EVM mechanisms (`@x402/evm`)](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/evm), and the installed 2.27.0 package.
11. [Fireblocks x402 facilitator](https://github.com/fireblocks/x402-facilitator).
12. [EIP-7702: Set EOA account code](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-7702.md).
13. [Arbitrum network upgrades](https://github.com/ArbitrumFoundation/docs/blob/main/docs/network-upgrades.md).
14. Arbitrum docs, ArbOS release notes: [ArbOS 40](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos40), [ArbOS 51](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos51) and [ArbOS 61](https://docs.arbitrum.io/run-arbitrum-node/arbos-releases/arbos61).
15. [Pimlico docs source](https://github.com/pimlicolabs/docs): pricing and supported chains.
16. [Coinbase Spend Permissions](https://github.com/coinbase/spend-permissions).
17. [Safe modules deployments](https://github.com/safe-global/safe-modules-deployments): allowance module v0.1.1.
18. [VeriPay](https://github.com/liunix61/veripay).
19. [viem's experimental ERC-7715 actions](https://github.com/wevm/viem/tree/main/src/experimental/erc7715).
20. [ERC-8262 and its reference implementation](https://github.com/xochi-fi/ERC-8262).
21. [mcp-verifiable-tools-demo benchmarks](https://github.com/ripple-node-lab/mcp-verifiable-tools-demo/blob/main/docs/BENCHMARKS.md).
22. [noir-benchmarks](https://github.com/Savio-Sou/noir-benchmarks).
23. [Barretenberg and bbup](https://github.com/AztecProtocol/aztec-packages/tree/master/barretenberg).
24. npm registry entries for [`@aztec/bb.js`](https://www.npmjs.com/package/@aztec/bb.js) and [`snarkjs`](https://www.npmjs.com/package/snarkjs), checked on September 27, 2026.
25. [AegisClear](https://github.com/mdlog/AegisClear), README and `docs/TOOLCHAIN.md`.
26. [EIP-1108: Reduce alt_bn128 precompile gas costs](https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1108.md).
27. [zk-sunade, a Groth16 verifier in Stylus](https://github.com/supernovahs/zk-sunade).
28. [SP1](https://github.com/succinctlabs/sp1), with its [proof types](https://docs.succinct.xyz/docs/sp1/generating-proofs/proof-types) for the verification gas, and [RISC Zero Ethereum contracts](https://github.com/risc0/risc0-ethereum).
29. [GitHub Actions OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc).
30. [noir-jwt](https://github.com/zkemail/noir-jwt).
31. [Reclaim zk-fetch](https://github.com/reclaimprotocol/zk-fetch).
32. [MetaMask support: Advanced Permissions](https://support.metamask.io/more-web3/dapps/advanced-permissions/) (search summary only; the page could not be opened).

Sources 1 to 31 were read on September 27, 2026 as raw files on GitHub or through the npm registry. The Arbitrum, MetaMask and GitHub docs were read from their source repositories, because their websites could not be opened from the build environment. One fact comes from a search summary only, and is marked where it appears: MetaMask's upgrade prompt in section 1.5 (source 32). Re-check it before quoting it. The SP1 verification gas in section 2.3 was re-read on Succinct's docs on October 1, 2026.
