//! subduction_c: Subduction for a C host (`newcore/sync/TRANSPORT.tex`),
//! `no_std` with `alloc` and sans-IO, so it can go on a microcontroller.
//!
//! The host owns all I/O: it opens the WebSocket, hands in each message that
//! arrives and sends each one the library gives it; it passes the time and
//! runs the library's executor (`executor`), single-threaded, which advances
//! every task Subduction spawns, every timeout and channel only when called.
//! What Subduction keeps is in the host's store (`store`, `store.h`). Memory,
//! randomness and stopping on a panic are the host's hooks (`platform.h`:
//! `erm_host_malloc`, `_realloc`, `_free`, `_random`, `_abort`). The C ABI
//! is `capi` (`subduction.h`); `node` composes Subduction as the TypeScript
//! peer's `@automerge/subduction` (`subduction_wasm`) does, over the host's
//! transport (`link`) as `subduction_wasm`'s `connectTransport` does over
//! one JavaScript owns.

#![no_std]

extern crate alloc;

mod capi;
mod executor;
mod link;
mod memory;
mod node;
mod store;

// the host ----------------------------------------------------------------------------------------

// platform.h
unsafe extern "C" {
    pub(crate) fn erm_host_malloc(size: usize) -> *mut u8;
    pub(crate) fn erm_host_realloc(pointer: *mut u8, size: usize) -> *mut u8;
    pub(crate) fn erm_host_free(pointer: *mut u8);
    fn erm_host_abort() -> !;
    /// fills `length` bytes at `out` with cryptographically secure random bytes
    fn erm_host_random(out: *mut u8, length: usize);
}

/// `length` random bytes from the host
pub(crate) fn random(out: &mut [u8]) {
    unsafe { erm_host_random(out.as_mut_ptr(), out.len()) };
}

/// getrandom's (Subduction's request ids, its caches' keys) where there is no
/// operating system to ask; on one there is, getrandom 0.2 asks it instead
fn host_getrandom(out: &mut [u8]) -> Result<(), getrandom::Error> {
    random(out);
    Ok(())
}

getrandom::register_custom_getrandom!(host_getrandom);

#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unsafe { erm_host_abort() }
}

/// Rust's own `core`, prebuilt to unwind on targets with an operating
/// system, can name the unwinder's personality routine; nothing here unwinds
/// (panic = "abort"), so it is never called.
#[cfg(not(target_os = "none"))]
#[unsafe(no_mangle)]
pub extern "C" fn rust_eh_personality() {}

#[global_allocator]
static ALLOCATOR: memory::Host = memory::Host;
