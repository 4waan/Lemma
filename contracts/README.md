# Lemma Warranty Contracts

## Purpose and economic role

This Foundry project will contain the Arbitrum Sepolia registry that makes a paid Compatibility Resolution more than a reputation claim. The provider deposits USDC bond capital, and an eligible evaluator-confirmed failure converts reserved bond into buyer withdrawal credit.

x402 remains the payment rail. The contract provides bounded recourse after payment rather than replacing x402 with a custom escrow scheme.

## Responsibilities

- Register versioned Capability Releases and their provider and evaluator roles.
- Hold provider USDC bonds.
- Activate provider-signed Resolution Vouchers after x402 settlement.
- Reserve one resolution's warranty amount from its release bond.
- Finalize evaluator-signed pass or failure outcomes.
- Release reserved bond on pass or expiry.
- Credit the buyer on an eligible failure.
- Support pull-based withdrawals, pause, and release deactivation.

## Outside this boundary

- Storing patch payloads or repository profiles in plaintext.
- Verifying historical USDC logs inside Solidity.
- Determining software correctness directly.
- Pricing resolutions.
- Operating the x402 facilitator.
- Open governance or a protocol token.

## Planned public interface

The planned contract is `ResolutionWarrantyRegistry` with these operations:

- `registerRelease`
- `depositBond`
- `deactivateRelease`
- `withdrawUnreservedBond`
- `activateResolution`
- `finalizeOutcome`
- `expireResolution`
- `withdrawCredit`

The current package contains only a trivial Foundry scaffold test.

## Dependencies

The implementation will pin OpenZeppelin Contracts and forge-std in `lib`. No external Solidity dependency is installed during scaffolding.

## Environment variables

Foundry uses `ARBITRUM_SEPOLIA_RPC_URL`. Deployment will also require the public USDC address and a deployer key, supplied outside source control.

## Development and tests

From the Lemma root:

- `npm run contracts:build`
- `npm run contracts:test`

## Security constraints

- Use EIP-712 domain separation with chain and contract binding.
- Reject expired vouchers, replayed resolution IDs, replayed payment hashes, wrong buyers, and wrong evaluators.
- Require warranty amount to equal the covered price for the MVP.
- Keep reserved bond unavailable to provider withdrawal.
- Use pull credits and reentrancy protection.
- Preserve active warranties when a release is deactivated.
- Maintain `USDC balance >= available bond + reserved bond + withdrawal credits`.
- Test six-decimal token accounting explicitly.

## Later completion criteria

The contract is complete when unit, fuzz, and invariant tests cover the full state machine, deployed bytecode is verified on Arbitrum Sepolia, and a real paid resolution can demonstrate both pass and refundable failure paths.
