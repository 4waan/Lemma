// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {DeployRegistry} from "../script/DeployRegistry.s.sol";
import {ResolutionWarrantyRegistry} from "../src/ResolutionWarrantyRegistry.sol";
import {MockUSDC} from "./utils/MockUSDC.sol";

/// Exposes the key-taking step to tests only; the script itself reads the key from the env.
contract DeployRegistryHarness is DeployRegistry {
    function deployWith(Config memory config, uint256 deployerKey)
        external
        returns (ResolutionWarrantyRegistry)
    {
        return _deploy(config, deployerKey);
    }

    function checkCommit(string memory commit) external pure {
        _checkCommit(commit);
    }

    function parentDir(string memory path) external pure returns (string memory) {
        return _parentDir(path);
    }
}

contract DeployRegistryTest is Test {
    address internal constant USDC = 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d;

    DeployRegistryHarness internal script;
    address internal owner = makeAddr("registryOwner");
    address internal deployer;
    uint256 internal deployerKey;

    function setUp() public {
        vm.chainId(421614);
        vm.etch(USDC, address(new MockUSDC()).code);
        (deployer, deployerKey) = makeAddrAndKey("deployer");
        vm.deal(deployer, 1 ether);
        script = new DeployRegistryHarness();
    }

    function _config() internal view returns (DeployRegistry.Config memory) {
        return DeployRegistry.Config({usdc: USDC, owner: owner, expectedDeployer: deployer});
    }

    function test_constants_areArbitrumSepolia() public view {
        assertEq(script.ARBITRUM_SEPOLIA_CHAIN_ID(), 421614);
        assertEq(script.ARBITRUM_SEPOLIA_USDC(), USDC);
    }

    function test_deploy_deploysAndVerifiesTheRegistry() public {
        ResolutionWarrantyRegistry registry = script.deployWith(_config(), deployerKey);
        assertEq(address(registry.usdc()), USDC);
        assertEq(registry.owner(), owner);
        assertEq(registry.pendingOwner(), address(0));
        assertEq(registry.engine(), address(0));
    }

    function test_deploy_fundsNothing() public {
        uint256 ethBefore = deployer.balance;
        ResolutionWarrantyRegistry registry = script.deployWith(_config(), deployerKey);
        assertEq(MockUSDC(USDC).balanceOf(address(registry)), 0);
        assertEq(MockUSDC(USDC).allowance(deployer, address(registry)), 0);
        assertEq(address(registry).balance, 0);
        assertEq(deployer.balance, ethBefore); // tests run at gas price zero: no value moved
        assertEq(owner.balance, 0);
    }

    function test_deploy_failsOnTheWrongChain() public {
        vm.chainId(42161); // Arbitrum One
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.WrongChain.selector, 42161));
        script.deployWith(_config(), deployerKey);
    }

    function test_deploy_failsOnTheWrongUsdc() public {
        DeployRegistry.Config memory config = _config();
        config.usdc = address(new MockUSDC());
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.WrongUsdc.selector, config.usdc));
        script.deployWith(config, deployerKey);
    }

    function test_deploy_failsWhenUsdcHasNoCode() public {
        vm.etch(USDC, "");
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.UsdcHasNoCode.selector, USDC));
        script.deployWith(_config(), deployerKey);
    }

    function test_deploy_failsOnAZeroOwner() public {
        DeployRegistry.Config memory config = _config();
        config.owner = address(0);
        vm.expectRevert(abi.encodeWithSelector(DeployRegistry.ZeroRole.selector, "owner"));
        script.deployWith(config, deployerKey);
    }

    function test_deploy_failsWhenTheKeyIsNotTheExpectedDeployer() public {
        DeployRegistry.Config memory config = _config();
        config.expectedDeployer = makeAddr("someoneElse");
        vm.expectRevert(
            abi.encodeWithSelector(
                DeployRegistry.DeployerMismatch.selector, config.expectedDeployer, deployer
            )
        );
        script.deployWith(config, deployerKey);
    }

    function test_deploy_withoutAnExpectedDeployerSkipsThatCheck() public {
        DeployRegistry.Config memory config = _config();
        config.expectedDeployer = address(0);
        script.deployWith(config, deployerKey);
    }

    function test_verifyDeployment_rejectsAFundedOrForeignRegistry() public {
        ResolutionWarrantyRegistry registry = script.deployWith(_config(), deployerKey);
        vm.expectRevert(
            abi.encodeWithSelector(DeployRegistry.DeploymentCheckFailed.selector, "owner")
        );
        script.verifyDeployment(registry, USDC, makeAddr("notTheOwner"));
        vm.expectRevert(
            abi.encodeWithSelector(DeployRegistry.DeploymentCheckFailed.selector, "usdc")
        );
        script.verifyDeployment(registry, makeAddr("otherToken"), owner);
        vm.expectRevert(
            abi.encodeWithSelector(DeployRegistry.DeploymentCheckFailed.selector, "no code")
        );
        script.verifyDeployment(ResolutionWarrantyRegistry(makeAddr("empty")), USDC, owner);
    }

    /// The whole env path, once: addresses and the key come from the environment. This is the
    /// only test that sets these variables, so parallel tests cannot race on them.
    function test_run_readsAddressesAndTheKeyFromTheEnvironment() public {
        vm.setEnv("USDC_ADDRESS", vm.toString(USDC));
        vm.setEnv("REGISTRY_OWNER_ADDRESS", vm.toString(owner));
        vm.setEnv("DEPLOYER_ADDRESS", vm.toString(deployer));
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(deployerKey)));
        DeployRegistry.Config memory config = script.configFromEnv();
        assertEq(config.usdc, USDC);
        assertEq(config.owner, owner);
        assertEq(config.expectedDeployer, deployer);
        ResolutionWarrantyRegistry registry = script.run();
        assertEq(registry.owner(), owner);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", "");
    }

    function test_checkCommit_acceptsOnlyAFullLowercaseGitCommit() public {
        script.checkCommit("fe2d117aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        vm.expectRevert();
        script.checkCommit("fe2d117");
        vm.expectRevert();
        script.checkCommit("FE2D117AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        vm.expectRevert();
        script.checkCommit("fe2d117aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz");
    }

    function test_parentDir() public view {
        assertEq(
            script.parentDir("deployments/arbitrum-sepolia/X.json"), "deployments/arbitrum-sepolia"
        );
        assertEq(script.parentDir("X.json"), ".");
    }
}
