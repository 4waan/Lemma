//! Lemma compatibility confidence on Stylus.
//!
//! One entry per (release digest, profile index), stored under
//! `keccak256(abi.encode(releaseDigest, profileIndex))`: the decayed outcome sums
//! and the benchmark prior. The warranty registry records each finalized outcome
//! (`record`, which matches `ICompatibilityEngine`), the owner sets the prior from
//! the release's frozen benchmark (`setPrior`), and anyone reads the 90% lower bound
//! (`confidence`). The math is the `lemma-confidence` crate, the same code the Lemma
//! server runs as wasm, so the catalog and this contract agree to the wei for the same
//! prior, the same outcomes at the same block times and the same time.
//!
//! Storage holds release and profile keys and sums only: never a buyer, payer or
//! resolution id.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

extern crate alloc;

use alloc::vec::Vec;

use alloy_primitives::{Address, B256, U64, U128};
use alloy_sol_types::{SolType, sol, sol_data};
use lemma_confidence::{Stats, Weight};
use stylus_sdk::{crypto::keccak, prelude::*, storage::StorageU32};

sol! {
    /// The caller is not the owner.
    #[derive(Debug, PartialEq, Eq)]
    error NotOwner(address caller);
    /// The caller is not the registry, or no registry is set.
    #[derive(Debug, PartialEq, Eq)]
    error NotRegistry(address caller);
    /// The caller is not the address ownership was offered to, or no offer is open.
    #[derive(Debug, PartialEq, Eq)]
    error NotPendingOwner(address caller);
    /// The owner cannot be the zero address.
    #[derive(Debug, PartialEq, Eq)]
    error ZeroOwner();
    /// A weight above a full outcome (10 000 bps).
    #[derive(Debug, PartialEq, Eq)]
    error WeightTooLarge(uint16 weightBps);

    /// One outcome was added to a (release, profile).
    event OutcomeRecorded(bytes32 indexed releaseDigest, uint8 indexed profileIndex, bool passed, uint16 weightBps);
    /// The owner set a (release, profile)'s benchmark prior, citing its evidence.
    event PriorSet(bytes32 indexed releaseDigest, uint8 indexed profileIndex, uint32 passes, uint32 failures, bytes32 evidenceDigest);
    /// The address allowed to record outcomes changed (zero disables recording).
    event RegistrySet(address indexed registry);
    /// The owner offered ownership to `newOwner`, who must accept it; zero withdraws an offer.
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    /// Ownership moved.
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
}

/// Every revert this contract can produce.
#[derive(SolidityError, Debug, PartialEq, Eq)]
pub enum ConfidenceError {
    /// See [`NotOwner`].
    NotOwner(NotOwner),
    /// See [`NotRegistry`].
    NotRegistry(NotRegistry),
    /// See [`NotPendingOwner`].
    NotPendingOwner(NotPendingOwner),
    /// See [`ZeroOwner`].
    ZeroOwner(ZeroOwner),
    /// See [`WeightTooLarge`].
    WeightTooLarge(WeightTooLarge),
}

sol_storage! {
    /// The engine: an owner, the registry that may record, one entry per key, and an
    /// open ownership offer (after the mapping, so the first three slots keep their place).
    #[entrypoint]
    pub struct CompatibilityConfidence {
        address owner;
        address registry;
        mapping(bytes32 => Entry) entries;
        address pending_owner;
    }

    /// Two slots: the sums, then time and prior.
    pub struct Entry {
        uint128 pass_wad;
        uint128 fail_wad;
        uint64 last;
        uint32 prior_passes;
        uint32 prior_failures;
    }
}

/// The storage key for a (release, profile): `keccak256(abi.encode(releaseDigest, profileIndex))`.
pub fn entry_key(release_digest: B256, profile_index: u8) -> B256 {
    keccak(<(sol_data::FixedBytes<32>, sol_data::Uint<8>)>::abi_encode_params(&(release_digest, profile_index)))
}

impl CompatibilityConfidence {
    fn only_owner(&self) -> Result<(), ConfidenceError> {
        let caller = self.vm().msg_sender();
        if caller != self.owner.get() {
            return Err(ConfidenceError::NotOwner(NotOwner { caller }));
        }
        Ok(())
    }

    fn read(&self, key: B256) -> (Stats, u32, u32) {
        let entry = self.entries.getter(key);
        let stats = Stats { pass_wad: entry.pass_wad.get().to(), fail_wad: entry.fail_wad.get().to(), last: entry.last.get().to() };
        (stats, read_u32(&entry.prior_passes), read_u32(&entry.prior_failures))
    }
}

fn read_u32(slot: &StorageU32) -> u32 {
    slot.get().to()
}

#[public]
impl CompatibilityConfidence {
    /// Sets the owner (never zero) and the registry (zero leaves recording off until `setRegistry`).
    #[constructor]
    pub fn constructor(&mut self, owner: Address, registry: Address) -> Result<(), ConfidenceError> {
        if owner.is_zero() {
            return Err(ConfidenceError::ZeroOwner(ZeroOwner {}));
        }
        self.owner.set(owner);
        self.registry.set(registry);
        self.vm().log(OwnershipTransferred { previousOwner: Address::ZERO, newOwner: owner });
        self.vm().log(RegistrySet { registry });
        Ok(())
    }

    /// The owner, who sets priors and the registry.
    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    /// The only address that may record outcomes (zero: nobody).
    pub fn registry(&self) -> Address {
        self.registry.get()
    }

    /// The address ownership was offered to, until it accepts (zero: no offer).
    pub fn pending_owner(&self) -> Address {
        self.pending_owner.get()
    }

    /// Owner only: offers ownership to `new_owner`, who takes it with `acceptOwnership`.
    /// Two steps, as in OpenZeppelin's `Ownable2Step`, so a mistyped address cannot lock
    /// `setPrior` and `setRegistry` for good: a new offer replaces the old one, and zero
    /// withdraws it. The owner keeps every right until the offer is accepted.
    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), ConfidenceError> {
        self.only_owner()?;
        self.pending_owner.set(new_owner);
        self.vm().log(OwnershipTransferStarted { previousOwner: self.owner.get(), newOwner: new_owner });
        Ok(())
    }

    /// Only the address ownership was offered to: takes ownership and closes the offer.
    pub fn accept_ownership(&mut self) -> Result<(), ConfidenceError> {
        let caller = self.vm().msg_sender();
        let pending = self.pending_owner.get();
        if pending.is_zero() || caller != pending {
            return Err(ConfidenceError::NotPendingOwner(NotPendingOwner { caller }));
        }
        let previous = self.owner.get();
        self.owner.set(caller);
        self.pending_owner.set(Address::ZERO);
        self.vm().log(OwnershipTransferred { previousOwner: previous, newOwner: caller });
        Ok(())
    }

    /// Owner only: the address allowed to record (the warranty registry); zero turns recording off.
    pub fn set_registry(&mut self, new_registry: Address) -> Result<(), ConfidenceError> {
        self.only_owner()?;
        self.registry.set(new_registry);
        self.vm().log(RegistrySet { registry: new_registry });
        Ok(())
    }

    /// Owner only: the benchmark prior for a (release, profile), from its frozen evidence's
    /// treatment arm (`passes = passed`, `failures = runs - passed`), citing that evidence.
    pub fn set_prior(
        &mut self,
        release_digest: B256,
        profile_index: u8,
        passes: u32,
        failures: u32,
        evidence_digest: B256,
    ) -> Result<(), ConfidenceError> {
        self.only_owner()?;
        {
            let mut entry = self.entries.setter(entry_key(release_digest, profile_index));
            entry.prior_passes.set(U32::from(passes));
            entry.prior_failures.set(U32::from(failures));
        }
        self.vm().log(PriorSet {
            releaseDigest: release_digest,
            profileIndex: profile_index,
            passes,
            failures,
            evidenceDigest: evidence_digest,
        });
        Ok(())
    }

    /// Registry only: adds one finalized outcome at `block.timestamp`, weighted in bps of a full outcome.
    pub fn record(&mut self, release_digest: B256, profile_index: u8, passed: bool, weight_bps: u16) -> Result<(), ConfidenceError> {
        let caller = self.vm().msg_sender();
        let registry = self.registry.get();
        if registry.is_zero() || caller != registry {
            return Err(ConfidenceError::NotRegistry(NotRegistry { caller }));
        }
        let weight = Weight::from_bps(weight_bps).ok_or(ConfidenceError::WeightTooLarge(WeightTooLarge { weightBps: weight_bps }))?;
        let now = self.vm().block_timestamp();
        let key = entry_key(release_digest, profile_index);
        let (stats, _, _) = self.read(key);
        let next = lemma_confidence::record(stats, passed, weight, now);
        {
            let mut entry = self.entries.setter(key);
            entry.pass_wad.set(U128::from(next.pass_wad));
            entry.fail_wad.set(U128::from(next.fail_wad));
            entry.last.set(U64::from(next.last));
        }
        self.vm().log(OutcomeRecorded { releaseDigest: release_digest, profileIndex: profile_index, passed, weightBps: weight_bps });
        Ok(())
    }

    /// The 90% Wilson lower bound on the pass rate at `block.timestamp`, in bps, and the
    /// effective sample size in thousandths: `(confidenceBps, effectiveNMilli)`.
    pub fn confidence(&self, release_digest: B256, profile_index: u8) -> (u16, u64) {
        let (stats, passes, failures) = self.read(entry_key(release_digest, profile_index));
        lemma_confidence::confidence(passes, failures, stats, self.vm().block_timestamp())
    }

    /// The raw entry: `(passWad, failWad, last, priorPasses, priorFailures)`, sums valid at `last`.
    pub fn stats(&self, release_digest: B256, profile_index: u8) -> (u128, u128, u64, u32, u32) {
        let (stats, passes, failures) = self.read(entry_key(release_digest, profile_index));
        (stats.pass_wad, stats.fail_wad, stats.last, passes, failures)
    }
}

type U32 = alloy_primitives::Uint<32, 1>;

#[cfg(test)]
mod tests;
