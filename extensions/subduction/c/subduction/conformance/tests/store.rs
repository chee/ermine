//! src/store.rs (Subduction's Storage over store.h) against subduction_core's
//! own conformance helpers, over store_memory.c and store_files.c, and the
//! Storage contract's rules the helpers leave out: one deterministic
//! representative under equivocation (as FsStorage keeps), and the
//! metadata-only loads agreeing with the full ones when a blob is missing.

extern crate alloc;

#[path = "../../src/store.rs"]
#[allow(dead_code)]
mod store;

use std::{
    collections::BTreeSet,
    ffi::{CString, c_char, c_int, c_void},
    sync::atomic::{AtomicUsize, Ordering},
};

use future_form::Local;
use futures::executor::block_on;
use sedimentree_core::{
    blob::{Blob, verified::VerifiedBlobMeta},
    crypto::digest::Digest,
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_core::storage::{conformance, traits::Storage};
use subduction_crypto::{signer::memory::MemorySigner, verified_meta::VerifiedMeta};

use store::{ErmStore, HostStore};

// platform.h and store.h, from the C build.rs compiles
#[link(name = "subduction_c_host", kind = "static")]
unsafe extern "C" {
    pub(crate) fn erm_host_free(pointer: *mut u8);
    fn ermStoreMemory() -> ErmStore;
    fn ermStoreFiles(root: *const c_char, out: *mut ErmStore, error: *mut *const c_char) -> c_int;
}

const BLOB: c_int = 3;

fn memory() -> ErmStore {
    unsafe { ermStoreMemory() }
}

/// a files store in a fresh folder
fn files() -> ErmStore {
    static N: AtomicUsize = AtomicUsize::new(0);
    let root = format!("{}/store-{}-{}", env!("CARGO_TARGET_TMPDIR"), std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    let _ = std::fs::remove_dir_all(&root);
    let path = CString::new(root).unwrap();
    let mut out = std::mem::MaybeUninit::<ErmStore>::uninit();
    let mut error: *const c_char = std::ptr::null();
    assert_eq!(unsafe { ermStoreFiles(path.as_ptr(), out.as_mut_ptr(), &raw mut error) }, 0);
    unsafe { out.assume_init() }
}

fn tree(n: u8) -> SedimentreeId {
    SedimentreeId::new([n; 32])
}

fn signer() -> MemorySigner {
    MemorySigner::from_bytes(&[42u8; 32])
}

async fn commit(tree: SedimentreeId, id: u8, blob: Vec<u8>) -> VerifiedMeta<LooseCommit> {
    VerifiedMeta::<LooseCommit>::seal::<Local, _>(&signer(), (tree, CommitId::new([id; 32]), BTreeSet::new()), VerifiedBlobMeta::new(Blob::new(blob))).await
}

async fn fragment(tree: SedimentreeId, head: u8, boundary: u8, blob: Vec<u8>) -> VerifiedMeta<Fragment> {
    VerifiedMeta::<Fragment>::seal::<Local, _>(
        &signer(),
        (tree, CommitId::new([head; 32]), BTreeSet::from([CommitId::new([boundary; 32])]), vec![CommitId::new([head ^ 0xff; 32])]),
        VerifiedBlobMeta::new(Blob::new(blob)),
    )
    .await
}

fn each(test: impl Fn(fn() -> ErmStore)) {
    test(memory);
    test(files);
}

#[test]
fn saves_register_the_tree() {
    each(|make| {
        block_on(async {
            let s = HostStore::new(make());
            conformance::assert_commit_save_registers_tree_id::<Local, _>(&s, commit(tree(0x21), 1, vec![1, 2, 3]).await).await;
            conformance::assert_fragment_save_registers_tree_id::<Local, _>(&s, fragment(tree(0x22), 2, 3, vec![4, 5, 6]).await).await;
            conformance::assert_batch_save_registers_tree_id::<Local, _>(&s, tree(0x23), vec![commit(tree(0x23), 5, vec![7]).await], Vec::new()).await;
        });
    });
}

// a store whose put fails for one kind, else the inner store's ------------------------------------

struct Poisoned {
    inner: ErmStore,
    kind: c_int,
}

unsafe extern "C" fn poisoned_put(this: *mut c_void, kind: c_int, tree: *const u8, id: *const u8, bytes: *const u8, length: usize) -> c_int {
    let p = unsafe { &*this.cast::<Poisoned>() };
    if kind == p.kind {
        return -1;
    }
    unsafe { (p.inner.put.unwrap())(p.inner.this, kind, tree, id, bytes, length) }
}

unsafe extern "C" fn poisoned_get(this: *mut c_void, kind: c_int, tree: *const u8, id: *const u8, bytes: *mut *mut u8, length: *mut usize) -> c_int {
    let p = unsafe { &*this.cast::<Poisoned>() };
    unsafe { (p.inner.get.unwrap())(p.inner.this, kind, tree, id, bytes, length) }
}

unsafe extern "C" fn poisoned_list(this: *mut c_void, kind: c_int, tree: *const u8, each: Option<unsafe extern "C" fn(*mut c_void, *const u8)>, context: *mut c_void) -> c_int {
    let p = unsafe { &*this.cast::<Poisoned>() };
    unsafe { (p.inner.list.unwrap())(p.inner.this, kind, tree, each, context) }
}

unsafe extern "C" fn poisoned_remove(this: *mut c_void, kind: c_int, tree: *const u8, id: *const u8) -> c_int {
    let p = unsafe { &*this.cast::<Poisoned>() };
    unsafe { (p.inner.remove.unwrap())(p.inner.this, kind, tree, id) }
}

fn poisoned(inner: ErmStore, kind: c_int) -> ErmStore {
    let this = Box::into_raw(Box::new(Poisoned { inner, kind })).cast();
    ErmStore { this, put: Some(poisoned_put), get: Some(poisoned_get), list: Some(poisoned_list), remove: Some(poisoned_remove) }
}

#[test]
fn a_failed_save_does_not_register_the_tree() {
    each(|make| {
        block_on(async {
            // the record's write fails, after its blob's
            let s = HostStore::new(poisoned(make(), 1));
            conformance::assert_failed_commit_save_does_not_register_tree_id::<Local, _>(&s, commit(tree(0x31), 1, vec![1]).await).await;
            // the blob's write fails
            let s = HostStore::new(poisoned(make(), BLOB));
            conformance::assert_failed_commit_save_does_not_register_tree_id::<Local, _>(&s, commit(tree(0x32), 1, vec![1]).await).await;
        });
    });
}

#[test]
fn metas_match_the_full_load() {
    each(|make| {
        block_on(async {
            let raw = make();
            let s = HostStore::new(raw);
            let id = tree(0x24);
            for i in 0..4u8 {
                s.save_loose_commit(id, commit(id, i, vec![i; 64]).await).await.unwrap();
            }
            s.save_fragment(id, fragment(id, 0xaa, 0xbb, vec![9; 128]).await).await.unwrap();
            conformance::assert_metas_match_full_load::<Local, _>(&s, id).await;

            // a commit whose blob is gone from the store
            let lost = commit(id, 7, vec![0x77; 16]).await;
            let digest = *lost.payload().blob_meta().digest().as_bytes();
            s.save_loose_commit(id, lost).await.unwrap();
            assert_eq!(unsafe { (raw.remove.unwrap())(raw.this, BLOB, std::ptr::null(), digest.as_ptr()) }, 0);
            conformance::assert_metas_match_full_load::<Local, _>(&s, id).await;
        });
    });
}

/// Two payloads under one id (equivocation): whatever order they come in,
/// the store keeps the same one, the lowest content digest (FsStorage's), and
/// saving it again changes nothing.
#[test]
fn equivocation_keeps_one_deterministic_representative() {
    each(|make| {
        block_on(async {
            let id = tree(0x41);
            let (a, b) = (commit(id, 1, vec![0xa]).await, commit(id, 1, vec![0xb]).await);
            let lowest = Digest::hash(a.payload()).min(Digest::hash(b.payload()));
            for order in [[a.clone(), b.clone()], [b.clone(), a.clone()]] {
                let s = HostStore::new(make());
                for c in order {
                    s.save_loose_commit(id, c).await.unwrap();
                }
                let kept = s.load_loose_commit(id, CommitId::new([1; 32])).await.unwrap().unwrap();
                assert_eq!(Digest::hash(kept.payload()), lowest, "commits: the representative depends on the order saved");
            }

            let (a, b) = (fragment(id, 2, 3, vec![0xa]).await, fragment(id, 2, 4, vec![0xb]).await);
            let lowest = Digest::hash(a.payload()).min(Digest::hash(b.payload()));
            for order in [[a.clone(), b.clone()], [b.clone(), a.clone()]] {
                let s = HostStore::new(make());
                s.save_batch(id, Vec::new(), order.to_vec()).await.unwrap();
                let kept = s.load_fragment(id, CommitId::new([2; 32])).await.unwrap().unwrap();
                assert_eq!(Digest::hash(kept.payload()), lowest, "fragments: the representative depends on the order saved");
            }
        });
    });
}
