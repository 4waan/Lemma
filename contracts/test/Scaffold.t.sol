// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

contract ScaffoldTest {
    function testScaffoldIsConfigured() public pure {
        bytes32 expected = keccak256("lemma.scaffold.v1");
        require(expected != bytes32(0), "invalid scaffold marker");
    }
}
