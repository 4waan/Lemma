# Contract Scripts

Deployment and operational scripts will live here.

The first deployment script must accept addresses and keys from the environment, deploy the warranty registry, verify constructor arguments, fund no account implicitly, and write a secret-free deployment record containing chain ID, deployer address, contract address, transaction hash, block number, compiler settings, and source commit.

Scripts must fail closed when the chain ID, USDC contract, or required role address is wrong.
