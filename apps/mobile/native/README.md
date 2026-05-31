# Chro Mobile Native

Rust crate for the bare React Native app's native boundary.

Current ABI:

- `chro_mobile_version`
- `chro_mobile_echo`
- `chro_mobile_free_string`

Next bridge step:

1. Build this crate for iOS and Android targets.
2. Add Swift/Kotlin implementations for the `ChroNative` TurboModule.
3. Forward `getVersion` and `echo` into this library.
