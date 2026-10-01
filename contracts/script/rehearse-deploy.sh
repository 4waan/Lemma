#!/usr/bin/env bash
# Rehearses the Arbitrum Sepolia deployment end to end on a local anvil that poses as chain
# 421614, with mock USDC code at the real USDC address and a throwaway deployer key made at run
# time. It runs both steps of script/DeployRegistry.s.sol, then checks the deployment record.
#
# Nothing touches a real network. The throwaway key stays in this shell's memory and the
# environment of forge: never on disk, in a log, or on a command line.
#
# Usage (from the repository root): npm run contracts:rehearse
# Needs forge, anvil, cast (Foundry) and jq on PATH.
set -euo pipefail

cd "$(dirname "$0")/.."

port="${REHEARSAL_PORT:-8545}"
rpc="http://127.0.0.1:${port}"
usdc=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
broadcast_dir=broadcast/DeployRegistry.s.sol/421614
# forge keeps the RPC URL of a broadcast here ("sensitive values"); git ignores cache/.
sensitive_dir=cache/DeployRegistry.s.sol/421614
record_dir=deployments/rehearsal
record="${record_dir}/ResolutionWarrantyRegistry.json"

if [ -e "$broadcast_dir" ] && [ "${REHEARSAL_OVERWRITE:-}" != "1" ]; then
  echo "rehearse-deploy: ${broadcast_dir} exists (a real deployment's broadcast?)." >&2
  echo "rehearse-deploy: move it away, or set REHEARSAL_OVERWRITE=1 to replace it." >&2
  exit 1
fi

export FOUNDRY_OFFLINE=true
forge build

anvil --chain-id 421614 --port "$port" --silent &
anvil_pid=$!
cleanup() {
  kill "$anvil_pid" 2>/dev/null || true
  rm -rf "$broadcast_dir" "$sensitive_dir" "$record_dir"
  rmdir broadcast/DeployRegistry.s.sol cache/DeployRegistry.s.sol deployments 2>/dev/null || true
}
trap cleanup EXIT

for _ in $(seq 1 100); do
  if cast chain-id --rpc-url "$rpc" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
test "$(cast chain-id --rpc-url "$rpc")" = "421614"

# Mock USDC runtime code at the real Arbitrum Sepolia USDC address.
cast rpc --rpc-url "$rpc" anvil_setCode "$usdc" \
  "$(jq -r .deployedBytecode.object out/MockUSDC.sol/MockUSDC.json)" >/dev/null

# Throwaway deployer (funded with test ETH on anvil only) and owner.
wallet_json="$(cast wallet new --json)"
DEPLOYER_PRIVATE_KEY="$(jq -r '.[0].private_key' <<<"$wallet_json")"
DEPLOYER_ADDRESS="$(jq -r '.[0].address' <<<"$wallet_json")"
unset wallet_json
REGISTRY_OWNER_ADDRESS="$(cast wallet new --json | jq -r '.[0].address')"
USDC_ADDRESS="$usdc"
cast rpc --rpc-url "$rpc" anvil_setBalance "$DEPLOYER_ADDRESS" 0xde0b6b3a7640000 >/dev/null

# Step 1: deploy. The key reaches forge through its environment only.
DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" DEPLOYER_ADDRESS="$DEPLOYER_ADDRESS" \
  USDC_ADDRESS="$USDC_ADDRESS" REGISTRY_OWNER_ADDRESS="$REGISTRY_OWNER_ADDRESS" \
  forge script script/DeployRegistry.s.sol:DeployRegistry --rpc-url "$rpc" --broadcast

# Step 2: record. No key in this environment.
key_hex="${DEPLOYER_PRIVATE_KEY#0x}"
unset DEPLOYER_PRIVATE_KEY
LEMMA_SOURCE_COMMIT="$(git rev-parse HEAD)" DEPLOYMENT_RECORD_PATH="$record" \
  forge script script/DeployRegistry.s.sol:DeployRegistry --sig "record()" --rpc-url "$rpc"

# The record names the right chain, contract, roles and code, and holds no key.
registry="$(jq -r .address "$record")"
jq -e \
  --arg deployer "$DEPLOYER_ADDRESS" \
  --arg owner "$REGISTRY_OWNER_ADDRESS" \
  --arg usdc "$usdc" \
  --arg commit "$(git rev-parse HEAD)" \
  '.schema == "lemma.contracts.deployment.v1"
   and .chainId == 421614
   and .contract == "ResolutionWarrantyRegistry"
   and (.deployer | ascii_downcase) == ($deployer | ascii_downcase)
   and (.constructorArgs.initialOwner | ascii_downcase) == ($owner | ascii_downcase)
   and (.constructorArgs.usdc | ascii_downcase) == ($usdc | ascii_downcase)
   and (.transactionHash | test("^0x[0-9a-f]{64}$"))
   and .blockNumber > 0
   and .compiler.version == "0.8.30+commit.73712a01"
   and .compiler.evmVersion == "cancun"
   and .sourceCommit == $commit' "$record" >/dev/null
test "$(jq -r .runtimeCodeHash "$record")" = "$(cast keccak "$(cast code --rpc-url "$rpc" "$registry")")"
if grep -qiF -f <(printf '%s\n' "$key_hex") "$record"; then
  echo "rehearse-deploy: the deployment record contains the deployer key" >&2
  exit 1
fi
unset key_hex

echo "rehearse-deploy: ok (registry ${registry}; record checked and removed)"
