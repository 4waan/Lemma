# Third-party bytecode for the end-to-end run

The local run (`npm run e2e`, [../README.md](../README.md)) puts two third-party systems on anvil exactly as they run on Arbitrum Sepolia: Circle's USDC and the official ERC-8004 registries. Their bytecode is committed here, so CI never clones or compiles those repositories. `provenance.json` is the record the run checks: `e2e/prepare.ts` and every load (`fixtures.ts`) recompute each file's sha256 and refuse a file that differs, is missing, is 200 KB or more, or is not listed.

## Files

| File | What it is | How the run uses it |
| --- | --- | --- |
| `bytecode/FiatTokenV2_2.runtime.hex` | Circle's FiatTokenV2_2, deployed (runtime) code, unlinked | `anvil_setCode` at the Arbitrum Sepolia USDC address `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, after its two `SignatureChecker` placeholders (byte offsets 18391 and 20106) are replaced with the library's address; then `initialize` through `initializeV2_2` and a minter |
| `bytecode/SignatureChecker.runtime.hex` | Circle's `SignatureChecker` library, deployed code | `anvil_setCode` at a fixed library address |
| `bytecode/HardhatMinimalUUPS.initcode.hex` | ERC-8004's minimal UUPS implementation, creation code | deployed; each registry's proxy starts on it (it sets the proxy's owner) |
| `bytecode/ERC1967Proxy.initcode.hex` | ERC-8004's ERC-1967 proxy, creation code | deployed twice, one proxy per registry |
| `bytecode/IdentityRegistryUpgradeable.initcode.hex` | The ERC-8004 identity registry, creation code | deployed, then the identity proxy is upgraded to it with `initialize()` |
| `bytecode/ReputationRegistryUpgradeable.initcode.hex` | The ERC-8004 reputation registry, creation code | deployed, then the reputation proxy is upgraded to it with `initialize(identityRegistry)` |

Each file is the named field of the contract's Foundry build artifact (`deployedBytecode.object` for runtime code, `bytecode.object` for creation code), lower case, followed by one newline. The ERC-8004 files are creation code, not runtime code: their constructors disable initializers and fix UUPS's own address (an immutable), so they are deployed the way their repository deploys them, not written with `anvil_setCode`.

## Sources, compilers and licenses

- **Circle stablecoin-evm** at `fc85788bc7c23cefe3df1a757133048bfddadeaa` ([github.com/circlefin/stablecoin-evm](https://github.com/circlefin/stablecoin-evm)), Apache-2.0. Built with the repository's own `foundry.toml` (optimizer on, 10,000,000 runs), solc 0.6.12+commit.27d51765 (binary sha256 `f6cb519b01dabc61cab4c184a3db11aa591d18151e362fcae850e42cffdfb09a`, as solc-bin publishes it), EVM istanbul, IPFS metadata hash, and @openzeppelin/contracts 3.4.2 from npm (MIT): `FOUNDRY_OFFLINE=true forge build contracts/v2/FiatTokenV2_2.sol`.
- **ERC-8004 contracts** at `b9e466c250744a7e06b13dff9d3c2844ed64f825` ([github.com/erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts)). Each source file is `SPDX-License-Identifier: MIT` (the repository README says CC0-1.0); with @openzeppelin/contracts and contracts-upgradeable 5.4.0 from its `package-lock.json` (MIT). The repository builds with Hardhat; the same settings in a `foundry.toml` (src `contracts`, libs `node_modules`, remapping `@openzeppelin/=node_modules/@openzeppelin/`, solc 0.8.24+commit.e11b9ed9 with binary sha256 `fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f`, via-IR, optimizer on, 200 runs, EVM shanghai, IPFS metadata hash): `FOUNDRY_OFFLINE=true forge build` of the four contract files.

Foundry 1.7.1 built both on 2026-09-27; a second build in a separate output directory gave byte-identical artifacts.

The bytecode redistributes these works in object form, so their license texts are kept in `LICENSES/`, each byte for byte as upstream publishes it at the pinned commit or tag:

- [`LICENSES/stablecoin-evm.LICENSE`](LICENSES/stablecoin-evm.LICENSE): Apache-2.0, from stablecoin-evm at `fc85788`, for `FiatTokenV2_2` and `SignatureChecker`. The repository has no NOTICE file at that commit.
- [`LICENSES/openzeppelin-contracts-3.4.2.LICENSE`](LICENSES/openzeppelin-contracts-3.4.2.LICENSE): MIT, from OpenZeppelin/openzeppelin-contracts at `v3.4.2`, compiled into the two Circle files.
- [`LICENSES/openzeppelin-contracts-5.4.0.LICENSE`](LICENSES/openzeppelin-contracts-5.4.0.LICENSE): MIT, from OpenZeppelin/openzeppelin-contracts at `v5.4.0`, compiled into the four ERC-8004 files; openzeppelin-contracts-upgradeable's LICENSE at `v5.4.0` is the same file (sha256 `13cd784a6c31361f0e0c6aa3b410a1cb9a079868b7314c13e3eb8a75351746b9`). The npm packages carry no LICENSE file.
- [`LICENSES/erc-8004-contracts.NOTICE`](LICENSES/erc-8004-contracts.NOTICE): the ERC-8004 sources' own terms. Each file is SPDX MIT with no copyright line, and the repository has no LICENSE file (its README says CC0-1.0), so the notice records that and gives the MIT permission notice.

## Checking and rebuilding

- `npx tsx e2e/prepare.ts --fixtures` checks every file against `provenance.json` and nothing else.
- To audit or re-derive them: build both repositories at those commits as above, then `npx tsx e2e/fixtures/extract.ts --circle <stablecoin-evm>/artifacts/foundry --erc8004 <erc-8004-contracts>/out`, which rewrites the files and their lengths and sha256 in `provenance.json`. `git diff` should then show nothing.
- Change a fixture only together with its provenance entry, in a commit that says why.
