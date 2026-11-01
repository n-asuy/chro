//! Derives `CONTRACT_REV` from the contract's own source, so the revision
//! changes exactly when the wire contract does and a CLI and server built from
//! different contracts refuse to talk instead of failing on a missing field.

use std::{env, fs, path::Path};

/// FNV-1a, 64 bit. Hand-rolled because the value must be identical across
/// toolchains, which `std`'s hasher does not promise.
fn fnv1a(bytes: &[u8], mut hash: u64) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn main() {
    let src = Path::new("src");
    println!("cargo:rerun-if-changed=src");

    let mut files: Vec<_> = fs::read_dir(src)
        .expect("read contract src")
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
        .collect();
    files.sort();

    let mut hash = 0xcbf2_9ce4_8422_2325;
    for path in &files {
        hash = fnv1a(path.file_name().unwrap().as_encoded_bytes(), hash);
        // Line endings differ between checkouts on different platforms; the
        // contract they describe does not.
        let text = fs::read_to_string(path).expect("read contract source");
        hash = fnv1a(text.replace("\r\n", "\n").as_bytes(), hash);
    }

    let version = env::var("CARGO_PKG_VERSION").unwrap();
    println!("cargo:rustc-env=CHRO_CONTRACT_REV={version}+{:08x}", hash >> 32);
}
