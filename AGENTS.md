./README.md

## Rust builds

Remote cross-builds that ship a single crate directory do not work here: there is no root Cargo workspace, and crates depend on their siblings by relative path (`../log-types`, `../db`, ...), which the remote copy cannot resolve. Only leaf crates such as `crates/log-types` build that way. Build and test natively from each crate's directory (`cd crates/executors && cargo test`); `crates/server` is the manifest that builds the binary.
