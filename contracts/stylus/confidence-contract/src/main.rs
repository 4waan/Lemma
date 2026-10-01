// `cargo stylus export-abi` runs this binary natively with the `export-abi` feature
// to print the contract's Solidity interface. On wasm it is an empty entry point.
#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]

#[cfg(not(any(test, feature = "export-abi")))]
#[unsafe(no_mangle)]
pub extern "C" fn main() {}

#[cfg(feature = "export-abi")]
fn main() {
    confidence_contract::print_from_args();
}
