// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import {ICompatibilityEngine} from "./interfaces/ICompatibilityEngine.sol";

/// @title Lemma Resolution Warranty Registry
/// @notice Holds provider USDC bonds behind paid Compatibility Resolutions. A provider-signed
/// voucher reserves one resolution's warranty amount from its release's bond; the release's
/// evaluator then signs the outcome. PASSED and VOID release the bond, FAILED turns the reserved
/// amount into a withdrawal credit that only the holder of the purchase's claim secret can move.
/// @dev Storage keeps hashes and accounting only: no buyer or payer address is ever stored.
/// Every state change that a buyer needs (activation, finalization, credit withdrawal) can be
/// submitted by anyone, so a relayer pays the gas and agents never hold ETH.
/// Invariant: usdc.balanceOf(this) >= totalAvailable + totalReserved + totalCredits, and each total
/// equals its sum over releases (available, reserved) or resolutions (reserved, credits).
contract ResolutionWarrantyRegistry is EIP712, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    /// @notice A provider's promise to back one paid resolution. Signed with EIP-712 by the
    /// release's provider.
    /// @param resolutionId The resolution this warranty covers (each activates once).
    /// @param releaseDigest The Capability Release's content digest.
    /// @param profileIndex The release profile the resolution matched.
    /// @param amount Warranty amount in atomic USDC (six decimals), reserved from the bond.
    /// @param paymentRef Opaque salted commitment to the settled payment, chosen by the server; it
    /// is never a public function of payer and nonce. Each may activate once.
    /// @param claimHash keccak256(abi.encode(resolutionId, claimSecret, refundTo)) from the buyer.
    /// @param activateBy Last timestamp at which the voucher may be submitted.
    struct Voucher {
        bytes32 resolutionId;
        bytes32 releaseDigest;
        uint8 profileIndex;
        uint256 amount;
        bytes32 paymentRef;
        bytes32 claimHash;
        uint64 activateBy;
    }

    /// @notice An evaluator's verdict on one active resolution. Signed with EIP-712 by the
    /// release's evaluator.
    /// @param resolutionId The resolution being finalized.
    /// @param verdict 1 PASSED, 2 FAILED, 3 VOID.
    /// @param weightBps Weight of the outcome for the compatibility engine, 0 to 10000.
    /// @param evidenceHash Hash of the off-chain evidence file.
    /// @param validUntil Last timestamp at which the signed outcome may be submitted.
    struct Outcome {
        bytes32 resolutionId;
        uint8 verdict;
        uint16 weightBps;
        bytes32 evidenceHash;
        uint64 validUntil;
    }

    /// @notice A registered Capability Release. `provider` is zero for an unknown release.
    struct Release {
        address provider;
        uint32 claimWindowSeconds;
        bool active;
        address evaluator;
        uint256 available;
        uint256 reserved;
    }

    /// @notice Lifecycle of a resolution's warranty. `None` means never activated.
    enum Status {
        None,
        Active,
        Passed,
        Failed,
        Refunded,
        Voided,
        Expired
    }

    /// @notice An activated warranty. `amount` is reserved while Active and is the outstanding
    /// credit while Failed.
    /// @param claimDeadline The claim deadline set at activation. Every second the registry spends
    /// paused after activation moves it later: {claimDeadlineOf} returns the deadline in force.
    /// @param pausedSecondsAtActivation {pausedSeconds} when the warranty was activated.
    struct Resolution {
        bytes32 releaseDigest;
        bytes32 claimHash;
        uint256 amount;
        uint64 claimDeadline;
        uint8 profileIndex;
        Status status;
        uint64 pausedSecondsAtActivation;
    }

    // ---------------------------------------------------------------------------------------------
    // Constants and immutables
    // ---------------------------------------------------------------------------------------------

    /// @notice EIP-712 type hash of {Voucher}.
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(bytes32 resolutionId,bytes32 releaseDigest,uint8 profileIndex,uint256 amount,bytes32 paymentRef,bytes32 claimHash,uint64 activateBy)"
    );

    /// @notice EIP-712 type hash of {Outcome}.
    bytes32 public constant OUTCOME_TYPEHASH = keccak256(
        "Outcome(bytes32 resolutionId,uint8 verdict,uint16 weightBps,bytes32 evidenceHash,uint64 validUntil)"
    );

    /// @notice The acceptance recipe passed: the reserved bond returns to the provider's release.
    uint8 public constant VERDICT_PASSED = 1;
    /// @notice An eligible failure: the reserved amount becomes the resolution's withdrawal credit.
    uint8 public constant VERDICT_FAILED = 2;
    /// @notice Ineligible or abandoned: the bond is released and nothing is recorded.
    uint8 public constant VERDICT_VOID = 3;

    /// @notice Largest outcome weight (100%).
    uint16 public constant MAX_WEIGHT_BPS = 10_000;

    /// @notice Gas given to the compatibility engine's `record` call.
    uint256 public constant ENGINE_GAS_LIMIT = 300_000;

    /// @dev Gas that must remain before the engine call: the full engine budget after EIP-150
    /// keeps 1/64 back, plus room to finish finalization afterwards. It stops a relayer from
    /// starving the engine on purpose to suppress an outcome record.
    uint256 private constant ENGINE_GAS_RESERVE = ENGINE_GAS_LIMIT + ENGINE_GAS_LIMIT / 63 + 20_000;

    /// @notice The bond and credit token (USDC on Arbitrum Sepolia).
    IERC20 public immutable usdc;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    /// @notice Compatibility engine notified on finalized outcomes; zero disables the hook.
    address public engine;

    /// @notice True once a payment reference has activated a resolution.
    mapping(bytes32 paymentRef => bool used) public paymentRefUsed;

    mapping(bytes32 releaseDigest => Release) private _releases;
    mapping(bytes32 resolutionId => Resolution) private _resolutions;

    uint256 private _totalAvailable;
    uint256 private _totalReserved;
    uint256 private _totalCredits;

    /// @dev Seconds spent paused over every finished pause.
    uint64 private _pausedSecondsSettled;
    /// @dev When the current pause began; read only while paused.
    uint64 private _pauseStartedAt;

    // ---------------------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------------------

    event ReleaseRegistered(
        bytes32 indexed releaseDigest,
        address indexed provider,
        address indexed evaluator,
        uint32 claimWindowSeconds
    );
    event ReleaseDeactivated(bytes32 indexed releaseDigest, address indexed by);
    event EngineSet(address indexed previousEngine, address indexed newEngine);
    event BondDeposited(bytes32 indexed releaseDigest, address indexed from, uint256 amount);
    event BondWithdrawn(bytes32 indexed releaseDigest, address indexed to, uint256 amount);
    event ResolutionActivated(
        bytes32 indexed resolutionId,
        bytes32 indexed releaseDigest,
        uint8 profileIndex,
        uint256 amount,
        bytes32 paymentRef,
        uint64 claimDeadline
    );
    event OutcomeFinalized(
        bytes32 indexed resolutionId,
        bytes32 indexed releaseDigest,
        uint8 verdict,
        uint16 weightBps,
        bytes32 evidenceHash
    );
    event EngineRecordFailed(bytes32 indexed resolutionId);
    event ResolutionExpired(
        bytes32 indexed resolutionId, bytes32 indexed releaseDigest, uint256 amount
    );
    event CreditWithdrawn(bytes32 indexed resolutionId, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------------------

    error InvalidToken();
    error InvalidReleaseDigest();
    error InvalidRoles();
    error InvalidClaimWindow();
    error InvalidRecipient();
    error ZeroAmount();
    error ReleaseAlreadyRegistered(bytes32 releaseDigest);
    error UnknownRelease(bytes32 releaseDigest);
    error ReleaseNotActive(bytes32 releaseDigest);
    error NotProvider();
    error NotOwnerOrProvider();
    error EngineHasNoCode(address engine);
    error InsufficientAvailableBond(uint256 available, uint256 requested);
    error TransferAmountMismatch(uint256 expected, uint256 received);
    error VoucherExpired(uint64 activateBy);
    error InvalidVoucher();
    error ResolutionAlreadyExists(bytes32 resolutionId);
    error PaymentRefAlreadyUsed(bytes32 paymentRef);
    error InvalidProviderSignature();
    error ResolutionNotActive(bytes32 resolutionId);
    error InvalidVerdict(uint8 verdict);
    error InvalidWeight(uint16 weightBps);
    error OutcomeExpired(uint64 validUntil);
    error ClaimWindowClosed(uint64 claimDeadline);
    error ClaimWindowOpen(uint64 claimDeadline);
    error InvalidEvaluatorSignature();
    error InsufficientGasForEngine();
    error NoCredit(bytes32 resolutionId);
    error InvalidClaim();
    error RenounceOwnershipDisabled();

    // ---------------------------------------------------------------------------------------------
    // Construction and administration
    // ---------------------------------------------------------------------------------------------

    /// @param usdc_ The bond token. Must be a deployed contract.
    /// @param initialOwner The administrator (release registration, engine, pause). Nonzero.
    constructor(IERC20 usdc_, address initialOwner)
        EIP712("Lemma Warranty Registry", "1")
        Ownable(initialOwner)
    {
        if (address(usdc_).code.length == 0) {
            revert InvalidToken();
        }
        usdc = usdc_;
    }

    /// @notice Registers a release with its provider (voucher signer, bond owner), its evaluator
    /// (outcome signer) and its claim window. A digest registers once; a new version is a new
    /// digest.
    function registerRelease(
        bytes32 releaseDigest,
        address provider,
        address evaluator,
        uint32 claimWindowSeconds
    ) external onlyOwner {
        if (releaseDigest == bytes32(0)) revert InvalidReleaseDigest();
        if (provider == address(0) || evaluator == address(0) || provider == evaluator) {
            revert InvalidRoles();
        }
        if (claimWindowSeconds == 0) revert InvalidClaimWindow();
        Release storage r = _releases[releaseDigest];
        if (r.provider != address(0)) revert ReleaseAlreadyRegistered(releaseDigest);

        r.provider = provider;
        r.evaluator = evaluator;
        r.claimWindowSeconds = claimWindowSeconds;
        r.active = true;
        emit ReleaseRegistered(releaseDigest, provider, evaluator, claimWindowSeconds);
    }

    /// @notice Sets the compatibility engine; zero disables the hook. A nonzero engine must be a
    /// deployed contract.
    function setEngine(address newEngine) external onlyOwner {
        if (newEngine != address(0) && newEngine.code.length == 0) {
            revert EngineHasNoCode(newEngine);
        }
        emit EngineSet(engine, newEngine);
        engine = newEngine;
    }

    /// @notice Stops bond deposits, activations, finalizations and expiries, and stops the claim
    /// clock: every second paused is added to the claim deadline of each warranty activated
    /// before it, so a pause never runs out a buyer's window. Unreserved bond and buyer credits
    /// stay withdrawable.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes deposits, activations, finalizations and expiries.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Disabled: without an owner, a paused registry could never finalize again.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    // ---------------------------------------------------------------------------------------------
    // Bonds
    // ---------------------------------------------------------------------------------------------

    /// @notice Adds `amount` atomic USDC to an active release's bond, pulled from the caller.
    /// @dev Fails closed if the token delivers a different amount (a fee-on-transfer change).
    function depositBond(bytes32 releaseDigest, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        Release storage r = _releases[releaseDigest];
        if (r.provider == address(0)) revert UnknownRelease(releaseDigest);
        if (!r.active) revert ReleaseNotActive(releaseDigest);

        r.available += amount;
        _totalAvailable += amount;
        emit BondDeposited(releaseDigest, msg.sender, amount);

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;
        if (received != amount) revert TransferAmountMismatch(amount, received);
    }

    /// @notice Lets the release's provider take back bond that no warranty has reserved. Works
    /// on deactivated releases and while paused.
    function withdrawUnreservedBond(bytes32 releaseDigest, uint256 amount, address to)
        external
        nonReentrant
    {
        Release storage r = _releases[releaseDigest];
        if (r.provider == address(0)) revert UnknownRelease(releaseDigest);
        if (msg.sender != r.provider) revert NotProvider();
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (amount == 0) revert ZeroAmount();
        uint256 available = r.available;
        if (amount > available) revert InsufficientAvailableBond(available, amount);

        r.available = available - amount;
        _totalAvailable -= amount;
        emit BondWithdrawn(releaseDigest, to, amount);

        usdc.safeTransfer(to, amount);
    }

    /// @notice Stops new activations for a release. Active warranties keep running to their
    /// outcome or expiry, and the provider can still withdraw unreserved bond.
    function deactivateRelease(bytes32 releaseDigest) external {
        Release storage r = _releases[releaseDigest];
        if (r.provider == address(0)) revert UnknownRelease(releaseDigest);
        if (msg.sender != owner() && msg.sender != r.provider) revert NotOwnerOrProvider();
        if (!r.active) revert ReleaseNotActive(releaseDigest);

        r.active = false;
        emit ReleaseDeactivated(releaseDigest, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Warranties
    // ---------------------------------------------------------------------------------------------

    /// @notice Activates a provider-signed voucher: reserves `v.amount` from the release's bond
    /// and opens the claim window. Anyone may submit it (a relayer).
    function activateResolution(Voucher calldata v, bytes calldata providerSignature)
        external
        nonReentrant
        whenNotPaused
    {
        // Deadlines are hours to days long; sequencer timestamp drift cannot move them materially.
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > v.activateBy) revert VoucherExpired(v.activateBy);
        if (v.amount == 0) revert ZeroAmount();
        if (v.resolutionId == bytes32(0) || v.paymentRef == bytes32(0) || v.claimHash == bytes32(0))
        {
            revert InvalidVoucher();
        }
        Release storage r = _releases[v.releaseDigest];
        if (r.provider == address(0)) revert UnknownRelease(v.releaseDigest);
        if (!r.active) revert ReleaseNotActive(v.releaseDigest);
        Resolution storage res = _resolutions[v.resolutionId];
        if (res.status != Status.None) revert ResolutionAlreadyExists(v.resolutionId);
        if (paymentRefUsed[v.paymentRef]) revert PaymentRefAlreadyUsed(v.paymentRef);
        if (!SignatureChecker.isValidSignatureNowCalldata(
                r.provider, hashVoucher(v), providerSignature
            )) {
            revert InvalidProviderSignature();
        }
        uint256 available = r.available;
        if (available < v.amount) revert InsufficientAvailableBond(available, v.amount);

        uint64 claimDeadline = uint64(block.timestamp) + r.claimWindowSeconds;
        paymentRefUsed[v.paymentRef] = true;
        r.available = available - v.amount;
        r.reserved += v.amount;
        _totalAvailable -= v.amount;
        _totalReserved += v.amount;

        res.releaseDigest = v.releaseDigest;
        res.claimHash = v.claimHash;
        res.amount = v.amount;
        res.claimDeadline = claimDeadline;
        res.profileIndex = v.profileIndex;
        res.status = Status.Active;
        res.pausedSecondsAtActivation = pausedSeconds();

        emit ResolutionActivated(
            v.resolutionId, v.releaseDigest, v.profileIndex, v.amount, v.paymentRef, claimDeadline
        );
    }

    /// @notice Finalizes an evaluator-signed outcome for an active resolution. Anyone may submit
    /// it (a relayer). PASSED and FAILED outcomes with a nonzero weight are then recorded with the
    /// compatibility engine; an engine failure emits {EngineRecordFailed} and never reverts.
    /// @dev With an engine set, the caller must supply enough gas for the engine's full budget
    /// ({ENGINE_GAS_LIMIT}), or the call reverts with {InsufficientGasForEngine}.
    function finalizeOutcome(Outcome calldata o, bytes calldata evaluatorSignature)
        external
        nonReentrant
        whenNotPaused
    {
        Resolution storage res = _resolutions[o.resolutionId];
        if (res.status != Status.Active) revert ResolutionNotActive(o.resolutionId);
        if (o.verdict < VERDICT_PASSED || o.verdict > VERDICT_VOID) {
            revert InvalidVerdict(o.verdict);
        }
        if (o.weightBps > MAX_WEIGHT_BPS) revert InvalidWeight(o.weightBps);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > o.validUntil) revert OutcomeExpired(o.validUntil);
        uint64 claimDeadline = _claimDeadline(res);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp > claimDeadline) revert ClaimWindowClosed(claimDeadline);
        bytes32 releaseDigest = res.releaseDigest;
        Release storage r = _releases[releaseDigest];
        if (!SignatureChecker.isValidSignatureNowCalldata(
                r.evaluator, hashOutcome(o), evaluatorSignature
            )) {
            revert InvalidEvaluatorSignature();
        }

        uint256 amount = res.amount;
        r.reserved -= amount;
        _totalReserved -= amount;
        if (o.verdict == VERDICT_FAILED) {
            res.status = Status.Failed;
            _totalCredits += amount;
        } else {
            res.status = o.verdict == VERDICT_PASSED ? Status.Passed : Status.Voided;
            r.available += amount;
            _totalAvailable += amount;
        }
        emit OutcomeFinalized(o.resolutionId, releaseDigest, o.verdict, o.weightBps, o.evidenceHash);

        if (o.verdict != VERDICT_VOID && o.weightBps != 0) {
            _recordWithEngine(
                o.resolutionId,
                releaseDigest,
                res.profileIndex,
                o.verdict == VERDICT_PASSED,
                o.weightBps
            );
        }
    }

    /// @notice Releases the bond of a resolution whose claim window closed without an outcome.
    /// Anyone may call it. It is paused with finalization: a warranty cannot run out while its
    /// outcome cannot be submitted.
    function expireResolution(bytes32 resolutionId) external nonReentrant whenNotPaused {
        Resolution storage res = _resolutions[resolutionId];
        if (res.status != Status.Active) revert ResolutionNotActive(resolutionId);
        uint64 claimDeadline = _claimDeadline(res);
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp <= claimDeadline) revert ClaimWindowOpen(claimDeadline);

        bytes32 releaseDigest = res.releaseDigest;
        Release storage r = _releases[releaseDigest];
        uint256 amount = res.amount;
        res.status = Status.Expired;
        r.reserved -= amount;
        r.available += amount;
        _totalReserved -= amount;
        _totalAvailable += amount;
        emit ResolutionExpired(resolutionId, releaseDigest, amount);
    }

    /// @notice Pays a FAILED resolution's credit to `to`, once. Anyone holding the claim secret
    /// may submit it (a relayer); `to` is bound by the voucher's claimHash, so a relayer cannot
    /// redirect it. Works while paused: buyer funds are never frozen.
    function withdrawCredit(bytes32 resolutionId, bytes32 claimSecret, address to)
        external
        nonReentrant
    {
        Resolution storage res = _resolutions[resolutionId];
        if (res.status != Status.Failed) revert NoCredit(resolutionId);
        if (to == address(0) || to == address(this)) revert InvalidRecipient();
        if (keccak256(abi.encode(resolutionId, claimSecret, to)) != res.claimHash) {
            revert InvalidClaim();
        }

        uint256 amount = res.amount;
        res.status = Status.Refunded;
        _totalCredits -= amount;
        emit CreditWithdrawn(resolutionId, amount);

        usdc.safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    /// @notice The release registered under `releaseDigest` (provider zero when unknown).
    function release(bytes32 releaseDigest) external view returns (Release memory) {
        return _releases[releaseDigest];
    }

    /// @notice The warranty of `resolutionId` (status None when never activated).
    function resolution(bytes32 resolutionId) external view returns (Resolution memory) {
        return _resolutions[resolutionId];
    }

    /// @notice Sums of available bond, reserved bond and outstanding credits, in atomic USDC.
    function totals() external view returns (uint256 available, uint256 reserved, uint256 credits) {
        return (_totalAvailable, _totalReserved, _totalCredits);
    }

    /// @notice The claim deadline in force for an Active resolution: the deadline set at
    /// activation plus every second the registry has been paused since, an ongoing pause
    /// included. An outcome may be finalized up to and including it; the resolution may expire
    /// after it. Zero when the resolution is not Active.
    function claimDeadlineOf(bytes32 resolutionId) external view returns (uint64) {
        Resolution storage res = _resolutions[resolutionId];
        if (res.status != Status.Active) return 0;
        return _claimDeadline(res);
    }

    /// @notice Seconds the registry has spent paused since deployment, an ongoing pause counted
    /// up to now.
    function pausedSeconds() public view returns (uint64) {
        uint64 total = _pausedSecondsSettled;
        if (paused()) total += uint64(block.timestamp) - _pauseStartedAt;
        return total;
    }

    /// @notice The EIP-712 digest a provider signs for `v` under this registry's domain.
    function hashVoucher(Voucher calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VOUCHER_TYPEHASH,
                    v.resolutionId,
                    v.releaseDigest,
                    v.profileIndex,
                    v.amount,
                    v.paymentRef,
                    v.claimHash,
                    v.activateBy
                )
            )
        );
    }

    /// @notice The EIP-712 digest an evaluator signs for `o` under this registry's domain.
    function hashOutcome(Outcome calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    OUTCOME_TYPEHASH,
                    o.resolutionId,
                    o.verdict,
                    o.weightBps,
                    o.evidenceHash,
                    o.validUntil
                )
            )
        );
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    /// @dev Starts the pause clock (OpenZeppelin's hook, called by {pause}).
    function _pause() internal override {
        super._pause();
        _pauseStartedAt = uint64(block.timestamp);
    }

    /// @dev Adds the finished pause to the paused total (OpenZeppelin's hook, called by
    /// {unpause}).
    function _unpause() internal override {
        super._unpause();
        _pausedSecondsSettled += uint64(block.timestamp) - _pauseStartedAt;
    }

    /// @dev The deadline set at activation, moved later by the time paused since.
    function _claimDeadline(Resolution storage res) private view returns (uint64) {
        return res.claimDeadline + (pausedSeconds() - res.pausedSecondsAtActivation);
    }

    /// @dev Calls the engine with a fixed gas budget. State is final before the call and the
    /// caller holds the reentrancy lock, so the engine can neither re-enter nor change the result.
    function _recordWithEngine(
        bytes32 resolutionId,
        bytes32 releaseDigest,
        uint8 profileIndex,
        bool passed,
        uint16 weightBps
    ) private {
        address target = engine;
        if (target == address(0)) return;
        if (target.code.length == 0) {
            // Solidity checks the target's code before a high-level call, outside try/catch.
            emit EngineRecordFailed(resolutionId);
            return;
        }
        if (gasleft() < ENGINE_GAS_RESERVE) revert InsufficientGasForEngine();
        try ICompatibilityEngine(target).record{gas: ENGINE_GAS_LIMIT}(
            releaseDigest, profileIndex, passed, weightBps
        ) {}
        catch {
            emit EngineRecordFailed(resolutionId);
        }
    }
}
