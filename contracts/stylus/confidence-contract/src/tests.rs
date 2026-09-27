use alloy_primitives::{U256, keccak256};
use alloy_sol_types::SolEvent;
use lemma_confidence::{HALF_LIFE_SECONDS, WAD};
use stylus_sdk::testing::TestVM;

use super::*;

const OWNER: Address = Address::repeat_byte(0x0a);
const REGISTRY: Address = Address::repeat_byte(0x0b);
const STRANGER: Address = Address::repeat_byte(0x0c);
const RELEASE: B256 = B256::repeat_byte(0x11);
const EVIDENCE: B256 = B256::repeat_byte(0x22);
const T0: u64 = 1_760_000_000;
const DAY: u64 = 86_400;

fn deployed() -> (TestVM, CompatibilityConfidence) {
    let vm = TestVM::default();
    let mut engine = CompatibilityConfidence::from(&vm);
    vm.set_block_timestamp(T0);
    engine.constructor(OWNER, REGISTRY).unwrap();
    (vm, engine)
}

fn as_owner(vm: &TestVM) {
    vm.set_sender(OWNER);
}

fn as_registry(vm: &TestVM) {
    vm.set_sender(REGISTRY);
}

#[test]
fn the_constructor_sets_the_roles_and_refuses_a_zero_owner() {
    let (vm, engine) = deployed();
    assert_eq!((engine.owner(), engine.registry()), (OWNER, REGISTRY));
    let logs = vm.get_emitted_logs();
    assert_eq!(logs[0].0[0], OwnershipTransferred::SIGNATURE_HASH);
    assert_eq!(logs[1].0, vec![RegistrySet::SIGNATURE_HASH, REGISTRY.into_word()]);

    let vm = TestVM::default();
    let mut engine = CompatibilityConfidence::from(&vm);
    assert_eq!(engine.constructor(Address::ZERO, REGISTRY), Err(ConfidenceError::ZeroOwner(ZeroOwner {})));
}

#[test]
fn only_the_owner_sets_the_registry_the_prior_and_offers_ownership() {
    let (vm, mut engine) = deployed();
    for caller in [REGISTRY, STRANGER] {
        vm.set_sender(caller);
        let refused = Err(ConfidenceError::NotOwner(NotOwner { caller }));
        assert_eq!(engine.set_registry(caller), refused);
        assert_eq!(engine.set_prior(RELEASE, 0, 19, 1, EVIDENCE), refused);
        assert_eq!(engine.transfer_ownership(caller), refused);
    }
    as_owner(&vm);
    engine.set_prior(RELEASE, 0, 19, 1, EVIDENCE).unwrap();
    assert_eq!(engine.stats(RELEASE, 0), (0, 0, 0, 19, 1));
    engine.set_registry(STRANGER).unwrap();
    assert_eq!(engine.registry(), STRANGER);
}

#[test]
fn ownership_moves_only_when_the_new_owner_accepts() {
    let (vm, mut engine) = deployed();
    as_owner(&vm);
    engine.transfer_ownership(STRANGER).unwrap();
    // Offered, not moved: the owner keeps every right until the offer is accepted.
    assert_eq!((engine.owner(), engine.pending_owner()), (OWNER, STRANGER));
    engine.set_registry(REGISTRY).unwrap();
    for caller in [OWNER, REGISTRY] {
        vm.set_sender(caller);
        assert_eq!(engine.accept_ownership(), Err(ConfidenceError::NotPendingOwner(NotPendingOwner { caller })));
    }
    vm.set_sender(STRANGER);
    engine.accept_ownership().unwrap();
    assert_eq!((engine.owner(), engine.pending_owner()), (STRANGER, Address::ZERO));
    // The offer is closed, and the previous owner has no rights left.
    assert_eq!(engine.accept_ownership(), Err(ConfidenceError::NotPendingOwner(NotPendingOwner { caller: STRANGER })));
    as_owner(&vm);
    assert_eq!(engine.set_registry(OWNER), Err(ConfidenceError::NotOwner(NotOwner { caller: OWNER })));

    let logs = vm.get_emitted_logs();
    let started = OwnershipTransferStarted { previousOwner: OWNER, newOwner: STRANGER }.encode_log_data();
    let moved = OwnershipTransferred { previousOwner: OWNER, newOwner: STRANGER }.encode_log_data();
    assert_eq!(logs.len(), 5);
    assert_eq!(logs[2], (started.topics().to_vec(), started.data.to_vec()));
    assert_eq!(logs[4], (moved.topics().to_vec(), moved.data.to_vec()));
}

#[test]
fn a_mistyped_offer_can_be_replaced_or_withdrawn() {
    let typo = Address::repeat_byte(0x0d);
    let (vm, mut engine) = deployed();
    as_owner(&vm);
    engine.transfer_ownership(typo).unwrap();
    engine.transfer_ownership(STRANGER).unwrap();
    vm.set_sender(typo);
    assert_eq!(engine.accept_ownership(), Err(ConfidenceError::NotPendingOwner(NotPendingOwner { caller: typo })));
    as_owner(&vm);
    engine.transfer_ownership(Address::ZERO).unwrap();
    assert_eq!(engine.pending_owner(), Address::ZERO);
    // With no offer open nobody can accept, not even the zero address.
    for caller in [STRANGER, Address::ZERO] {
        vm.set_sender(caller);
        assert_eq!(engine.accept_ownership(), Err(ConfidenceError::NotPendingOwner(NotPendingOwner { caller })));
    }
    assert_eq!(engine.owner(), OWNER);
}

#[test]
fn only_the_registry_records_and_a_zero_registry_records_nothing() {
    let (vm, mut engine) = deployed();
    for caller in [OWNER, STRANGER, Address::ZERO] {
        vm.set_sender(caller);
        assert_eq!(engine.record(RELEASE, 0, true, 10_000), Err(ConfidenceError::NotRegistry(NotRegistry { caller })));
    }
    as_owner(&vm);
    engine.set_registry(Address::ZERO).unwrap();
    vm.set_sender(Address::ZERO);
    assert_eq!(engine.record(RELEASE, 0, true, 10_000), Err(ConfidenceError::NotRegistry(NotRegistry { caller: Address::ZERO })));
    assert_eq!(engine.stats(RELEASE, 0), (0, 0, 0, 0, 0));
}

#[test]
fn a_weight_above_a_full_outcome_is_refused() {
    let (vm, mut engine) = deployed();
    as_registry(&vm);
    assert_eq!(engine.record(RELEASE, 0, true, 10_001), Err(ConfidenceError::WeightTooLarge(WeightTooLarge { weightBps: 10_001 })));
    engine.record(RELEASE, 0, true, 10_000).unwrap();
}

#[test]
fn records_at_block_time_and_scores_like_the_library() {
    let (vm, mut engine) = deployed();
    as_owner(&vm);
    engine.set_prior(RELEASE, 3, 18, 2, EVIDENCE).unwrap();
    as_registry(&vm);
    let outcomes = [(T0, true, 10_000u16), (T0 + 5 * DAY, false, 10_000), (T0 + 20 * DAY, true, 5_000), (T0 + 20 * DAY, true, 10_000)];
    let mut expected = Stats::default();
    for (at, passed, weight) in outcomes {
        vm.set_block_timestamp(at);
        engine.record(RELEASE, 3, passed, weight).unwrap();
        expected = lemma_confidence::record(expected, passed, Weight::from_bps(weight).unwrap(), at);
    }
    assert_eq!(engine.stats(RELEASE, 3), (expected.pass_wad, expected.fail_wad, expected.last, 18, 2));
    for now in [T0 + 20 * DAY, T0 + 45 * DAY, T0 + 400 * DAY] {
        vm.set_block_timestamp(now);
        assert_eq!(engine.confidence(RELEASE, 3), lemma_confidence::confidence(18, 2, expected, now));
    }
    // Other keys are untouched.
    assert_eq!(engine.stats(RELEASE, 2), (0, 0, 0, 0, 0));
    assert_eq!(engine.confidence(B256::repeat_byte(0x12), 3), (0, 0));
}

#[test]
fn a_new_prior_keeps_the_recorded_sums() {
    let (vm, mut engine) = deployed();
    as_registry(&vm);
    engine.record(RELEASE, 0, true, 10_000).unwrap();
    vm.set_block_timestamp(T0 + 3 * DAY);
    engine.record(RELEASE, 0, false, 5_000).unwrap();
    let (pass, fail, last, _, _) = engine.stats(RELEASE, 0);
    as_owner(&vm);
    engine.set_prior(RELEASE, 0, 18, 2, EVIDENCE).unwrap();
    assert_eq!(engine.stats(RELEASE, 0), (pass, fail, last, 18, 2));
    let sums = Stats { pass_wad: pass, fail_wad: fail, last };
    assert_eq!(engine.confidence(RELEASE, 0), lemma_confidence::confidence(18, 2, sums, T0 + 3 * DAY));
    // Another prior replaces the first, and the sums still do not move.
    engine.set_prior(RELEASE, 0, 9, 1, EVIDENCE).unwrap();
    assert_eq!(engine.stats(RELEASE, 0), (pass, fail, last, 9, 1));
}

#[test]
fn a_zero_weight_record_adds_nothing_but_moves_time() {
    let (vm, mut engine) = deployed();
    as_registry(&vm);
    engine.record(RELEASE, 0, true, 10_000).unwrap();
    vm.set_block_timestamp(T0 + 5_222);
    engine.record(RELEASE, 0, false, 0).unwrap();
    // The pass decays to the new time and nothing is added, so a list of outcomes that
    // leaves this record out would compute other sums.
    let one_pass = Stats { pass_wad: WAD, fail_wad: 0, last: T0 };
    let expected = lemma_confidence::record(one_pass, false, Weight::from_bps(0).unwrap(), T0 + 5_222);
    assert!(expected.pass_wad < WAD);
    assert_eq!(engine.stats(RELEASE, 0), (expected.pass_wad, 0, T0 + 5_222, 0, 0));
    let zero = OutcomeRecorded { releaseDigest: RELEASE, profileIndex: 0, passed: false, weightBps: 0 }.encode_log_data();
    assert_eq!(vm.get_emitted_logs().last(), Some(&(zero.topics().to_vec(), zero.data.to_vec())));
}

#[test]
fn emits_the_events_the_registry_and_indexers_expect() {
    let (vm, mut engine) = deployed();
    as_owner(&vm);
    engine.set_prior(RELEASE, 1, 9, 1, EVIDENCE).unwrap();
    as_registry(&vm);
    engine.record(RELEASE, 1, false, 7_500).unwrap();
    let logs = vm.get_emitted_logs();
    let prior = PriorSet { releaseDigest: RELEASE, profileIndex: 1, passes: 9, failures: 1, evidenceDigest: EVIDENCE }.encode_log_data();
    let outcome = OutcomeRecorded { releaseDigest: RELEASE, profileIndex: 1, passed: false, weightBps: 7_500 }.encode_log_data();
    assert_eq!(logs[2], (prior.topics().to_vec(), prior.data.to_vec()));
    assert_eq!(logs[3], (outcome.topics().to_vec(), outcome.data.to_vec()));
    assert_eq!(outcome.topics()[2], B256::from(U256::from(1u8)));
}

#[test]
fn the_key_is_abi_encode_of_digest_and_index_and_storage_is_solidity_laid_out() {
    let mut encoded = [0u8; 64];
    encoded[..32].copy_from_slice(RELEASE.as_slice());
    encoded[63] = 7;
    let key = entry_key(RELEASE, 7);
    assert_eq!(key, keccak256(encoded));

    let (vm, mut engine) = deployed();
    as_owner(&vm);
    engine.set_prior(RELEASE, 7, 0x0102_0304, 0x0506_0708, EVIDENCE).unwrap();
    as_registry(&vm);
    engine.record(RELEASE, 7, true, 10_000).unwrap();
    vm.set_block_timestamp(T0 + HALF_LIFE_SECONDS);
    engine.record(RELEASE, 7, false, 2_500).unwrap();

    // owner is slot 0, registry slot 1, the mapping slot 2 (entry at keccak256(key . 2)),
    // and an open ownership offer slot 3.
    as_owner(&vm);
    engine.transfer_ownership(STRANGER).unwrap();
    assert_eq!(vm.get_storage(U256::ZERO), OWNER.into_word());
    assert_eq!(vm.get_storage(U256::from(1u8)), REGISTRY.into_word());
    assert_eq!(vm.get_storage(U256::from(3u8)), STRANGER.into_word());
    let mut preimage = [0u8; 64];
    preimage[..32].copy_from_slice(key.as_slice());
    preimage[63] = 2;
    let base = U256::from_be_bytes(keccak256(preimage).0);
    let sums = U256::from_be_bytes(vm.get_storage(base).0);
    let rest = U256::from_be_bytes(vm.get_storage(base + U256::from(1u8)).0);
    let (pass, fail) = (WAD / 2, WAD / 4);
    assert_eq!(sums, U256::from(pass) | (U256::from(fail) << 128));
    assert_eq!(rest, U256::from(T0 + HALF_LIFE_SECONDS) | (U256::from(0x0102_0304u32) << 64) | (U256::from(0x0506_0708u32) << 96));
}

#[test]
fn the_exported_interface_keeps_the_registry_hook() {
    // Track D's ICompatibilityEngine: record(bytes32,uint8,bool,uint16).
    let abi = include_str!("../ICompatibilityConfidence.sol");
    assert!(abi.contains("function record(bytes32 release_digest, uint8 profile_index, bool passed, uint16 weight_bps) external;"));
    assert!(abi.contains("function confidence(bytes32 release_digest, uint8 profile_index) external view returns (uint16, uint64);"));
}
