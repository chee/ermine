//! src/memory.rs over a host whose malloc aligns only to a word, as a board's
//! heap may (C asks malloc for max_align_t; ESP-IDF's gives 4 bytes on a
//! 32-bit chip): every allocation still aligned as Rust asked, its bytes kept
//! through realloc.

#[path = "../../src/memory.rs"]
mod memory;

use std::alloc::{GlobalAlloc, Layout};

const WORD: usize = size_of::<usize>();

/// a pointer one word past a multiple of two words: aligned to a word, never to two
pub(crate) unsafe fn erm_host_malloc(size: usize) -> *mut u8 {
    let block = unsafe { std::alloc::alloc(Layout::from_size_align(size + 4 * WORD, 4 * WORD).unwrap()) };
    if block.is_null() {
        return block;
    }
    let out = unsafe { block.add(3 * WORD) };
    unsafe { out.cast::<usize>().sub(1).write(size) };
    out
}

pub(crate) unsafe fn erm_host_free(pointer: *mut u8) {
    if pointer.is_null() {
        return;
    }
    let size = unsafe { pointer.cast::<usize>().sub(1).read() };
    unsafe { std::alloc::dealloc(pointer.sub(3 * WORD), Layout::from_size_align(size + 4 * WORD, 4 * WORD).unwrap()) };
}

pub(crate) unsafe fn erm_host_realloc(pointer: *mut u8, size: usize) -> *mut u8 {
    let out = unsafe { erm_host_malloc(size) };
    if !pointer.is_null() && !out.is_null() {
        let old = unsafe { pointer.cast::<usize>().sub(1).read() };
        unsafe { std::ptr::copy_nonoverlapping(pointer, out, old.min(size)) };
        unsafe { erm_host_free(pointer) };
    }
    out
}

#[test]
fn every_allocation_is_aligned_as_asked() {
    let host = memory::Host;
    for align in [1, 2, 4, 8, 16, 32, 64] {
        for size in [1, 3, 8, 16, 24, 100] {
            if size < align && align > WORD {
                // as from a u128 or a SIMD vector: size is a multiple of align
                continue;
            }
            let layout = Layout::from_size_align(size, align).unwrap();
            let p = unsafe { host.alloc(layout) };
            assert!(!p.is_null());
            assert_eq!(p as usize % align, 0, "alloc(size {size}, align {align}) gave {p:p}");
            for i in 0..size {
                unsafe { p.add(i).write(i as u8) };
            }
            let grown = size * 2 + 5;
            let q = unsafe { host.realloc(p, layout, grown) };
            assert_eq!(q as usize % align, 0, "realloc(size {size} -> {grown}, align {align}) gave {q:p}");
            for i in 0..size {
                assert_eq!(unsafe { q.add(i).read() }, i as u8);
            }
            unsafe { host.dealloc(q, Layout::from_size_align(grown, align).unwrap()) };
        }
    }
}
