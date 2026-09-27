// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ResolutionWarrantyRegistry} from "../src/ResolutionWarrantyRegistry.sol";

/// @title Deploy the warranty registry to Arbitrum Sepolia, fail-closed
/// @notice Two steps, both run from `contracts/` (see contracts/README.md, "Deploy"):
///   1. `forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url arbitrum_sepolia --broadcast`
///      checks the chain, the USDC address and the roles, deploys, and reads the new contract
///      back. The deployer key comes from `DEPLOYER_PRIVATE_KEY` in the environment, never from a
///      command-line argument or a literal. Nothing is funded.
///   2. `forge script script/DeployRegistry.s.sol:DeployRegistry --sig "record()" --rpc-url arbitrum_sepolia`
///      needs no key: it reads step 1's broadcast, checks it against the chain, and writes the
///      secret-free deployment record.
contract DeployRegistry is Script {
    uint256 public constant ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
    address public constant ARBITRUM_SEPOLIA_USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    string public constant RECORD_SCHEMA = "lemma.contracts.deployment.v1";
    string public constant DEFAULT_RECORD_PATH =
        "deployments/arbitrum-sepolia/ResolutionWarrantyRegistry.json";
    string internal constant ARTIFACT_PATH =
        "out/ResolutionWarrantyRegistry.sol/ResolutionWarrantyRegistry.json";
    string internal constant BROADCAST_PATH =
        "broadcast/DeployRegistry.s.sol/421614/run-latest.json";

    /// @notice Addresses the deployment depends on, all read from the environment.
    /// @param usdc `USDC_ADDRESS`: must be the Arbitrum Sepolia USDC and have code.
    /// @param owner `REGISTRY_OWNER_ADDRESS`: the registry administrator; nonzero.
    /// @param expectedDeployer `DEPLOYER_ADDRESS` (optional): when set, the key must match it.
    struct Config {
        address usdc;
        address owner;
        address expectedDeployer;
    }

    error WrongChain(uint256 chainId);
    error WrongUsdc(address usdc);
    error UsdcHasNoCode(address usdc);
    error ZeroRole(string role);
    error DeployerMismatch(address expected, address actual);
    error DeploymentCheckFailed(string what);
    error BroadcastCheckFailed(string what);
    error InvalidSourceCommit(string commit);

    // ---------------------------------------------------------------------------------------------
    // Step 1: deploy
    // ---------------------------------------------------------------------------------------------

    function run() external returns (ResolutionWarrantyRegistry registry) {
        Config memory config = configFromEnv();
        registry = _deploy(config, vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @notice Reads the deployment addresses from the environment (never the key).
    function configFromEnv() public view returns (Config memory config) {
        config.usdc = vm.envAddress("USDC_ADDRESS");
        config.owner = vm.envAddress("REGISTRY_OWNER_ADDRESS");
        config.expectedDeployer = vm.envOr("DEPLOYER_ADDRESS", address(0));
    }

    /// @notice Fails closed on the wrong chain, the wrong USDC, or a zero or unexpected role.
    function check(Config memory config, address deployer) public view {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        if (config.usdc != ARBITRUM_SEPOLIA_USDC) revert WrongUsdc(config.usdc);
        if (config.usdc.code.length == 0) revert UsdcHasNoCode(config.usdc);
        if (config.owner == address(0)) revert ZeroRole("owner");
        if (deployer == address(0)) revert ZeroRole("deployer");
        if (config.expectedDeployer != address(0) && config.expectedDeployer != deployer) {
            revert DeployerMismatch(config.expectedDeployer, deployer);
        }
    }

    /// @notice Reads a registry back and fails unless it is freshly deployed with these
    /// constructor arguments on this chain.
    function verifyDeployment(ResolutionWarrantyRegistry registry, address usdc, address owner)
        public
        view
    {
        if (address(registry).code.length == 0) revert DeploymentCheckFailed("no code");
        if (address(registry.usdc()) != usdc) revert DeploymentCheckFailed("usdc");
        if (registry.owner() != owner) revert DeploymentCheckFailed("owner");
        if (registry.pendingOwner() != address(0)) revert DeploymentCheckFailed("pendingOwner");
        if (registry.engine() != address(0)) revert DeploymentCheckFailed("engine");
        if (registry.paused()) revert DeploymentCheckFailed("paused");
        (uint256 available, uint256 reserved, uint256 credits) = registry.totals();
        if (available != 0 || reserved != 0 || credits != 0) {
            revert DeploymentCheckFailed("funded");
        }
        (
            ,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,,
        ) = registry.eip712Domain();
        if (
            keccak256(bytes(name)) != keccak256("Lemma Warranty Registry")
                || keccak256(bytes(version)) != keccak256("1") || chainId != block.chainid
                || verifyingContract != address(registry)
        ) revert DeploymentCheckFailed("eip712Domain");
    }

    function _deploy(Config memory config, uint256 deployerKey)
        internal
        returns (ResolutionWarrantyRegistry registry)
    {
        address deployer = vm.addr(deployerKey);
        check(config, deployer);
        vm.startBroadcast(deployerKey);
        registry = new ResolutionWarrantyRegistry(IERC20(config.usdc), config.owner);
        vm.stopBroadcast();
        verifyDeployment(registry, config.usdc, config.owner);
        console2.log("deployer", deployer);
        console2.log("ResolutionWarrantyRegistry", address(registry));
    }

    // ---------------------------------------------------------------------------------------------
    // Step 2: record
    // ---------------------------------------------------------------------------------------------

    /// @notice Writes the secret-free deployment record from step 1's broadcast. Needs no key.
    /// Env: `LEMMA_SOURCE_COMMIT` (the 40-hex git commit deployed, required) and
    /// `DEPLOYMENT_RECORD_PATH` (optional, under `deployments/`).
    function record() external returns (string memory json) {
        if (block.chainid != ARBITRUM_SEPOLIA_CHAIN_ID) revert WrongChain(block.chainid);
        string memory sourceCommit = vm.envString("LEMMA_SOURCE_COMMIT");
        _checkCommit(sourceCommit);
        string memory recordPath = vm.envOr("DEPLOYMENT_RECORD_PATH", DEFAULT_RECORD_PATH);

        string memory broadcast = vm.readFile(BROADCAST_PATH);
        if (
            keccak256(bytes(vm.parseJsonString(broadcast, ".transactions[0].contractName")))
                    != keccak256("ResolutionWarrantyRegistry")
                || keccak256(
                        bytes(vm.parseJsonString(broadcast, ".transactions[0].transactionType"))
                    ) != keccak256("CREATE")
        ) revert BroadcastCheckFailed("first transaction is not the registry CREATE");

        ResolutionWarrantyRegistry registry = ResolutionWarrantyRegistry(
            vm.parseJsonAddress(broadcast, ".transactions[0].contractAddress")
        );
        bytes32 txHash = vm.parseJsonBytes32(broadcast, ".transactions[0].hash");
        if (vm.parseJsonBytes32(broadcast, ".receipts[0].transactionHash") != txHash) {
            revert BroadcastCheckFailed("receipt does not match the transaction");
        }
        if (vm.parseJsonUint(broadcast, ".receipts[0].status") != 1) {
            revert BroadcastCheckFailed("transaction failed");
        }
        address usdc = vm.parseJsonAddress(broadcast, ".transactions[0].arguments[0]");
        address owner = vm.parseJsonAddress(broadcast, ".transactions[0].arguments[1]");
        Config memory config = Config({usdc: usdc, owner: owner, expectedDeployer: address(0)});
        address deployer = vm.parseJsonAddress(broadcast, ".transactions[0].transaction.from");
        check(config, deployer);
        verifyDeployment(registry, usdc, owner);

        json = _recordJson(
            registry,
            deployer,
            txHash,
            vm.parseJsonUint(broadcast, ".receipts[0].blockNumber"),
            usdc,
            owner,
            sourceCommit
        );
        vm.createDir(_parentDir(recordPath), true);
        vm.writeJson(json, recordPath);
        console2.log("deployment record", recordPath);
    }

    function _recordJson(
        ResolutionWarrantyRegistry registry,
        address deployer,
        bytes32 txHash,
        uint256 blockNumber,
        address usdc,
        address owner,
        string memory sourceCommit
    ) internal returns (string memory) {
        string memory artifact = vm.readFile(ARTIFACT_PATH);
        string memory compiler = "compiler";
        vm.serializeString(
            compiler, "version", vm.parseJsonString(artifact, ".metadata.compiler.version")
        );
        vm.serializeBool(
            compiler,
            "optimizer",
            vm.parseJsonBool(artifact, ".metadata.settings.optimizer.enabled")
        );
        vm.serializeUint(
            compiler,
            "optimizerRuns",
            vm.parseJsonUint(artifact, ".metadata.settings.optimizer.runs")
        );
        vm.serializeString(
            compiler, "evmVersion", vm.parseJsonString(artifact, ".metadata.settings.evmVersion")
        );
        compiler = vm.serializeString(
            compiler,
            "bytecodeHash",
            vm.parseJsonString(artifact, ".metadata.settings.metadata.bytecodeHash")
        );

        string memory args = "constructorArgs";
        vm.serializeAddress(args, "usdc", usdc);
        args = vm.serializeAddress(args, "initialOwner", owner);

        string memory root = "record";
        vm.serializeString(root, "schema", RECORD_SCHEMA);
        vm.serializeString(root, "contract", "ResolutionWarrantyRegistry");
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "address", address(registry));
        vm.serializeAddress(root, "deployer", deployer);
        vm.serializeBytes32(root, "transactionHash", txHash);
        vm.serializeUint(root, "blockNumber", blockNumber);
        vm.serializeString(root, "constructorArgs", args);
        vm.serializeString(root, "eip712Name", "Lemma Warranty Registry");
        vm.serializeString(root, "eip712Version", "1");
        vm.serializeBytes32(root, "runtimeCodeHash", address(registry).codehash);
        vm.serializeString(root, "compiler", compiler);
        return vm.serializeString(root, "sourceCommit", sourceCommit);
    }

    /// A git commit is 40 lowercase hex characters.
    function _checkCommit(string memory commit) internal pure {
        bytes memory b = bytes(commit);
        if (b.length != 40) revert InvalidSourceCommit(commit);
        for (uint256 i = 0; i < b.length; i++) {
            bool digit = b[i] >= "0" && b[i] <= "9";
            bool lower = b[i] >= "a" && b[i] <= "f";
            if (!digit && !lower) revert InvalidSourceCommit(commit);
        }
    }

    function _parentDir(string memory path) internal pure returns (string memory) {
        bytes memory b = bytes(path);
        uint256 end = b.length;
        while (end > 0 && b[end - 1] != "/") end--;
        if (end == 0) return ".";
        bytes memory dir = new bytes(end - 1);
        for (uint256 i = 0; i < end - 1; i++) {
            dir[i] = b[i];
        }
        return string(dir);
    }
}
