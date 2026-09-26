# Lemma Warranty Registry

This Foundry workspace is reserved for the Arbitrum Sepolia contract that backs paid Compatibility Resolutions with provider-funded USDC.

The registry is not implemented. The current package contains only the compiler configuration and a scaffold test. Do not treat it as deployed, audited, or safe for funds.

## Target state machine

The provider registers a Capability Release and deposits USDC bond. After x402 settlement, a provider-signed voucher activates one warranty and reserves bond equal to the covered price.

A separate evaluator can finalize a pass or eligible failure during the claim window. A pass releases the reservation. A failure creates buyer withdrawal credit. If no outcome arrives, expiry releases the reservation without claiming that the software passed.

The MVP interface is expected to include:

- `registerRelease`
- `depositBond`
- `deactivateRelease`
- `withdrawUnreservedBond`
- `activateResolution`
- `finalizeOutcome`
- `expireResolution`
- `withdrawCredit`

Full manifests, profiles, patches, and test output remain offchain. The contract stores identifiers, typed-signature commitments, role addresses, deadlines, and accounting state.

## Required invariants

- Vouchers and outcomes use EIP-712 domain separation bound to chain and contract.
- Resolution ids, payment references, and authorizations cannot be replayed.
- The buyer, evaluator, release, payload, amount, and expiry must match the signed data.
- Reserved bond cannot be withdrawn by the provider.
- Release deactivation does not invalidate an active warranty.
- Withdrawals use pull credits and reentrancy protection.
- USDC balance always covers available bond, reserved bond, and withdrawal credits.
- Six-decimal accounting is tested explicitly.

The evaluator remains a separate team-operated key for the MVP. This is bounded recourse, not decentralized correctness arbitration.

## Development

From the repository root:

```bash
npm run contracts:build
npm run contracts:test
```

The implementation milestone requires unit, fuzz, and invariant coverage, a deployment script that reads roles from the environment, verified Arbitrum Sepolia bytecode, and one demonstrated pass and refunded failure.

Deployment records must contain only public chain data, compiler settings, and the source commit. Keys and RPC credentials must never enter command arguments, source control, broadcast artifacts, or logs.
