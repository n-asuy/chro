use std::ffi::{CStr, CString};
use std::os::raw::c_char;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn version() -> &'static str {
    VERSION
}

pub fn echo(input: &str) -> String {
    format!("rust:{input}")
}

#[no_mangle]
pub extern "C" fn chro_mobile_version() -> *mut c_char {
    string_to_ptr(version())
}

#[no_mangle]
pub unsafe extern "C" fn chro_mobile_echo(input: *const c_char) -> *mut c_char {
    if input.is_null() {
        return string_to_ptr("rust:");
    }

    let input = unsafe { CStr::from_ptr(input) }.to_string_lossy();
    string_to_ptr(&echo(&input))
}

#[no_mangle]
pub unsafe extern "C" fn chro_mobile_free_string(value: *mut c_char) {
    if value.is_null() {
        return;
    }

    drop(unsafe { CString::from_raw(value) });
}

fn string_to_ptr(value: &str) -> *mut c_char {
    CString::new(value)
        .expect("native strings must not contain interior nul bytes")
        .into_raw()
}

#[cfg(test)]
mod tests {
    use super::{echo, version};

    #[test]
    fn returns_package_version() {
        assert_eq!(version(), "0.1.0");
    }

    #[test]
    fn echoes_with_rust_prefix() {
        assert_eq!(echo("mobile"), "rust:mobile");
    }
}
