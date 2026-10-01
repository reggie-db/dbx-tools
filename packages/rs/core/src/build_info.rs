//! Structured, post-link release version metadata.

use std::ptr;

const MAGIC: [u8; 12] = *b"DBXVERSION\0\0";
const SCHEMA: u16 = 1;
const VERSION_CAPACITY: usize = 64;

#[repr(C)]
struct VersionRecord {
    magic: [u8; 12],
    schema: u16,
    length: u16,
    version: [u8; VERSION_CAPACITY],
    reserved: [u8; 48],
}

const fn initial_version() -> [u8; VERSION_CAPACITY] {
    let mut version = [0; VERSION_CAPACITY];
    version[0] = b'0';
    version[1] = b'.';
    version[2] = b'0';
    version[3] = b'.';
    version[4] = b'0';
    version
}

#[cfg_attr(target_os = "macos", unsafe(link_section = "__DATA,__dbxver"))]
#[cfg_attr(target_os = "windows", unsafe(link_section = ".dbxver"))]
#[cfg_attr(
    not(any(target_os = "macos", target_os = "windows")),
    unsafe(link_section = ".dbxversion")
)]
#[used]
static VERSION_RECORD: VersionRecord = VersionRecord {
    magic: MAGIC,
    schema: SCHEMA,
    length: 5,
    version: initial_version(),
    reserved: [0; 48],
};

/// Return the release version stamped into the native binary.
pub fn version() -> &'static str {
    let record = ptr::addr_of!(VERSION_RECORD);
    let magic = unsafe { ptr::read_volatile(ptr::addr_of!((*record).magic)) };
    let schema = unsafe { ptr::read_volatile(ptr::addr_of!((*record).schema)) };
    let length = usize::from(unsafe { ptr::read_volatile(ptr::addr_of!((*record).length)) });
    if magic != MAGIC || schema != SCHEMA || length > VERSION_CAPACITY {
        return "unknown";
    }
    let version = unsafe { &(&(*record).version)[..length] };
    std::str::from_utf8(version).unwrap_or("unknown")
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_placeholder_before_release_stamping() {
        assert_eq!(super::version(), "0.0.0");
    }
}
