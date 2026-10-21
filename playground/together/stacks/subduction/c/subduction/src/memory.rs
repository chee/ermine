//! The library's memory: the host's malloc, realloc and free (platform.h).

use core::alloc::{GlobalAlloc, Layout};

use crate::{erm_host_free, erm_host_malloc, erm_host_realloc};

/// The host's memory: what malloc is sure to align (a word: a board's heap
/// may give no more, though C asks for max_align_t), else over-allocated, the
/// pointer malloc gave kept just below the one handed out.
pub(crate) struct Host;

const MIN_ALIGN: usize = core::mem::size_of::<usize>();

fn plain(layout: &Layout) -> bool {
    layout.align() <= MIN_ALIGN && layout.align() <= layout.size()
}

unsafe impl GlobalAlloc for Host {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if plain(&layout) {
            return unsafe { erm_host_malloc(layout.size()) };
        }
        let word = core::mem::size_of::<usize>();
        let Some(total) = layout.size().checked_add(layout.align() + word) else { return core::ptr::null_mut() };
        let raw = unsafe { erm_host_malloc(total) };
        if raw.is_null() {
            return raw;
        }
        let start = raw as usize + word;
        let aligned = (start + layout.align() - 1) & !(layout.align() - 1);
        unsafe { ((aligned - word) as *mut usize).write_unaligned(raw as usize) };
        aligned as *mut u8
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        if plain(&layout) {
            unsafe { erm_host_free(pointer) };
        } else {
            let word = core::mem::size_of::<usize>();
            let raw = unsafe { ((pointer as usize - word) as *const usize).read_unaligned() };
            unsafe { erm_host_free(raw as *mut u8) };
        }
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        let Ok(new) = Layout::from_size_align(size, layout.align()) else { return core::ptr::null_mut() };
        if plain(&layout) && plain(&new) {
            return unsafe { erm_host_realloc(pointer, size) };
        }
        let out = unsafe { self.alloc(new) };
        if !out.is_null() {
            unsafe { core::ptr::copy_nonoverlapping(pointer, out, layout.size().min(size)) };
            unsafe { self.dealloc(pointer, layout) };
        }
        out
    }
}

