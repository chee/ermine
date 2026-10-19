//! Subduction's `Storage` over the host's store (`store.h`): sedimentree
//! ids, loose commits and fragments as their `Signed` encodings, keyed by
//! tree and commit id (a fragment by its head), and blobs by digest.

use alloc::{sync::Arc, vec::Vec};
use core::{
    ffi::{c_int, c_void},
    fmt, ptr,
};

use future_form::{FutureForm, Local};
use futures::future::LocalBoxFuture;
use sedimentree_core::{
    blob::{Blob, has_meta::HasBlobMeta},
    codec::{decode::DecodeFields, encode::EncodeFields, error::DecodeError, schema::Schema},
    collections::Set,
    crypto::digest::Digest,
    fragment::Fragment,
    id::SedimentreeId,
    loose_commit::{LooseCommit, id::CommitId},
};
use subduction_core::storage::traits::Storage;
use subduction_crypto::{signed::Signed, verified_meta::VerifiedMeta};

const TREE: c_int = 0;
const COMMIT: c_int = 1;
const FRAGMENT: c_int = 2;
const BLOB: c_int = 3;

type Each = unsafe extern "C" fn(context: *mut c_void, id: *const u8);

/// `ErmStore`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct ErmStore {
    pub this: *mut c_void,
    pub put: Option<unsafe extern "C" fn(*mut c_void, c_int, *const u8, *const u8, *const u8, usize) -> c_int>,
    pub get: Option<unsafe extern "C" fn(*mut c_void, c_int, *const u8, *const u8, *mut *mut u8, *mut usize) -> c_int>,
    pub list: Option<unsafe extern "C" fn(*mut c_void, c_int, *const u8, Option<Each>, *mut c_void) -> c_int>,
    pub remove: Option<unsafe extern "C" fn(*mut c_void, c_int, *const u8, *const u8) -> c_int>,
}

/// What went wrong: the host's store, or a record it gave back.
#[derive(Debug, Clone, Copy)]
pub(crate) enum StoreError {
    Host(&'static str),
    Decode(DecodeError),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Host(what) => write!(f, "the store could not {what}"),
            Self::Decode(e) => write!(f, "a stored record does not decode: {e}"),
        }
    }
}

impl core::error::Error for StoreError {}

impl From<DecodeError> for StoreError {
    fn from(e: DecodeError) -> Self {
        Self::Decode(e)
    }
}

/// The host's store, shared by the node's parts.
#[derive(Clone)]
pub(crate) struct HostStore(Arc<ErmStore>);

// One thread at a time (executor.rs).
unsafe impl Send for HostStore {}
unsafe impl Sync for HostStore {}

impl fmt::Debug for HostStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("HostStore")
    }
}

fn tree_of(tree: Option<&SedimentreeId>) -> *const u8 {
    tree.map_or(ptr::null(), |t| t.as_bytes().as_ptr())
}

unsafe extern "C" fn collect(context: *mut c_void, id: *const u8) {
    let ids = unsafe { &mut *context.cast::<Vec<[u8; 32]>>() };
    let mut out = [0u8; 32];
    unsafe { ptr::copy_nonoverlapping(id, out.as_mut_ptr(), 32) };
    ids.push(out);
}

impl HostStore {
    pub(crate) fn new(store: ErmStore) -> Self {
        Self(Arc::new(store))
    }

    fn put(&self, kind: c_int, tree: Option<&SedimentreeId>, id: &[u8; 32], bytes: &[u8]) -> Result<(), StoreError> {
        let put = self.0.put.ok_or(StoreError::Host("put"))?;
        let done = unsafe { put(self.0.this, kind, tree_of(tree), id.as_ptr(), bytes.as_ptr(), bytes.len()) };
        if done == 0 { Ok(()) } else { Err(StoreError::Host("put")) }
    }

    fn get(&self, kind: c_int, tree: Option<&SedimentreeId>, id: &[u8; 32]) -> Result<Option<Vec<u8>>, StoreError> {
        let get = self.0.get.ok_or(StoreError::Host("get"))?;
        let (mut bytes, mut length) = (ptr::null_mut::<u8>(), 0usize);
        match unsafe { get(self.0.this, kind, tree_of(tree), id.as_ptr(), &raw mut bytes, &raw mut length) } {
            0 => Ok(None),
            1 => {
                let out = if bytes.is_null() || length == 0 { Vec::new() } else { unsafe { core::slice::from_raw_parts(bytes, length) }.to_vec() };
                if !bytes.is_null() {
                    unsafe { crate::erm_host_free(bytes.cast()) };
                }
                Ok(Some(out))
            }
            _ => Err(StoreError::Host("get")),
        }
    }

    fn list(&self, kind: c_int, tree: Option<&SedimentreeId>) -> Result<Vec<[u8; 32]>, StoreError> {
        let list = self.0.list.ok_or(StoreError::Host("list"))?;
        let mut ids: Vec<[u8; 32]> = Vec::new();
        let done = unsafe { list(self.0.this, kind, tree_of(tree), Some(collect), (&raw mut ids).cast()) };
        if done == 0 { Ok(ids) } else { Err(StoreError::Host("list")) }
    }

    fn remove(&self, kind: c_int, tree: Option<&SedimentreeId>, id: Option<&[u8; 32]>) -> Result<(), StoreError> {
        let remove = self.0.remove.ok_or(StoreError::Host("remove"))?;
        let done = unsafe { remove(self.0.this, kind, tree_of(tree), id.map_or(ptr::null(), |i| i.as_ptr())) };
        if done == 0 { Ok(()) } else { Err(StoreError::Host("remove")) }
    }

    /// A commit or fragment: its blob, then its signed bytes under the tree
    /// and key, then the tree, so a save that fails registers nothing. Two
    /// payloads under one key (equivocation): the one with the lowest content
    /// digest stays, whatever order they come in (as FsStorage keeps); one
    /// held that does not decode is replaced.
    fn save<T: Record>(&self, kind: c_int, tree: SedimentreeId, verified: VerifiedMeta<T>) -> Result<(), StoreError> {
        let (signed, payload, blob) = verified.into_full_parts();
        let key = payload.key();
        let held = self.signed::<T>(kind, tree, key.as_bytes()).ok().flatten().and_then(|held| held.try_decode_trusted_payload().ok());
        if held.is_none_or(|held| Digest::hash(&payload) < Digest::hash(&held)) {
            self.put(BLOB, None, &digest(&payload), blob.as_slice())?;
            self.put(kind, Some(&tree), key.as_bytes(), signed.as_bytes())?;
        }
        self.put(TREE, None, tree.as_bytes(), &[])
    }

    fn signed<T: Record>(&self, kind: c_int, tree: SedimentreeId, key: &[u8; 32]) -> Result<Option<Signed<T>>, StoreError> {
        match self.get(kind, Some(&tree), key)? {
            Some(bytes) => Ok(Some(Signed::<T>::try_decode(&bytes)?)),
            None => Ok(None),
        }
    }

    /// a commit or fragment with its blob; None when either is not there
    fn load<T: Record>(&self, kind: c_int, tree: SedimentreeId, key: &[u8; 32]) -> Result<Option<VerifiedMeta<T>>, StoreError> {
        let Some(signed) = self.signed::<T>(kind, tree, key)? else { return Ok(None) };
        let payload = signed.try_decode_trusted_payload()?;
        let Some(blob) = self.get(BLOB, None, &digest(&payload))? else { return Ok(None) };
        Ok(Some(VerifiedMeta::try_from_trusted(signed, Blob::new(blob))?))
    }

    fn load_all<T: Record>(&self, kind: c_int, tree: SedimentreeId) -> Result<Vec<VerifiedMeta<T>>, StoreError> {
        let mut out = Vec::new();
        for key in self.list(kind, Some(&tree))? {
            if let Some(verified) = self.load::<T>(kind, tree, &key)? {
                out.push(verified);
            }
        }
        Ok(out)
    }

    /// the payloads load_all gives, so a record whose blob is gone is left out of both (store.h has no cheaper way to know)
    fn metas<T: Record>(&self, kind: c_int, tree: SedimentreeId) -> Result<Vec<T>, StoreError> {
        Ok(self.load_all::<T>(kind, tree)?.into_iter().map(|verified| verified.into_full_parts().1).collect())
    }
}

/// A loose commit or a fragment: kept by its key (a commit's id, a fragment's head), its blob by digest.
trait Record: HasBlobMeta + Schema + EncodeFields + DecodeFields {
    fn key(&self) -> CommitId;
}

impl Record for LooseCommit {
    fn key(&self) -> CommitId {
        self.head()
    }
}

impl Record for Fragment {
    fn key(&self) -> CommitId {
        self.head()
    }
}

fn digest<T: HasBlobMeta>(payload: &T) -> [u8; 32] {
    *HasBlobMeta::blob_meta(payload).digest().as_bytes()
}

impl Storage<Local> for HostStore {
    type Error = StoreError;

    fn save_sedimentree_id(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.put(TREE, None, sedimentree_id.as_bytes(), &[]) })
    }

    fn delete_sedimentree_id(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.remove(TREE, None, Some(sedimentree_id.as_bytes())) })
    }

    fn load_all_sedimentree_ids(&self) -> LocalBoxFuture<'_, Result<Set<SedimentreeId>, StoreError>> {
        Local::from_future(async move { Ok(self.list(TREE, None)?.into_iter().map(SedimentreeId::new).collect()) })
    }

    fn contains_sedimentree_id(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<bool, StoreError>> {
        Local::from_future(async move { Ok(self.get(TREE, None, sedimentree_id.as_bytes())?.is_some()) })
    }

    fn save_loose_commit(&self, sedimentree_id: SedimentreeId, verified: VerifiedMeta<LooseCommit>) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.save(COMMIT, sedimentree_id, verified) })
    }

    fn list_commit_ids(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Set<CommitId>, StoreError>> {
        Local::from_future(async move { Ok(self.list(COMMIT, Some(&sedimentree_id))?.into_iter().map(CommitId::new).collect()) })
    }

    fn load_loose_commits(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Vec<VerifiedMeta<LooseCommit>>, StoreError>> {
        Local::from_future(async move { self.load_all(COMMIT, sedimentree_id) })
    }

    fn load_loose_commit_metas(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Vec<LooseCommit>, StoreError>> {
        Local::from_future(async move { self.metas(COMMIT, sedimentree_id) })
    }

    fn load_loose_commit(&self, sedimentree_id: SedimentreeId, commit_id: CommitId) -> LocalBoxFuture<'_, Result<Option<VerifiedMeta<LooseCommit>>, StoreError>> {
        Local::from_future(async move { self.load(COMMIT, sedimentree_id, commit_id.as_bytes()) })
    }

    fn delete_loose_commit(&self, sedimentree_id: SedimentreeId, commit_id: CommitId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.remove(COMMIT, Some(&sedimentree_id), Some(commit_id.as_bytes())) })
    }

    fn delete_loose_commits(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.remove(COMMIT, Some(&sedimentree_id), None) })
    }

    fn save_fragment(&self, sedimentree_id: SedimentreeId, verified: VerifiedMeta<Fragment>) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.save(FRAGMENT, sedimentree_id, verified) })
    }

    fn load_fragment(&self, sedimentree_id: SedimentreeId, fragment_head: CommitId) -> LocalBoxFuture<'_, Result<Option<VerifiedMeta<Fragment>>, StoreError>> {
        Local::from_future(async move { self.load(FRAGMENT, sedimentree_id, fragment_head.as_bytes()) })
    }

    fn list_fragment_ids(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Set<CommitId>, StoreError>> {
        Local::from_future(async move { Ok(self.list(FRAGMENT, Some(&sedimentree_id))?.into_iter().map(CommitId::new).collect()) })
    }

    fn load_fragments(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Vec<VerifiedMeta<Fragment>>, StoreError>> {
        Local::from_future(async move { self.load_all(FRAGMENT, sedimentree_id) })
    }

    fn load_fragment_metas(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<Vec<Fragment>, StoreError>> {
        Local::from_future(async move { self.metas(FRAGMENT, sedimentree_id) })
    }

    fn delete_fragment(&self, sedimentree_id: SedimentreeId, fragment_head: CommitId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.remove(FRAGMENT, Some(&sedimentree_id), Some(fragment_head.as_bytes())) })
    }

    fn delete_fragments(&self, sedimentree_id: SedimentreeId) -> LocalBoxFuture<'_, Result<(), StoreError>> {
        Local::from_future(async move { self.remove(FRAGMENT, Some(&sedimentree_id), None) })
    }

    fn save_batch(&self, sedimentree_id: SedimentreeId, commits: Vec<VerifiedMeta<LooseCommit>>, fragments: Vec<VerifiedMeta<Fragment>>) -> LocalBoxFuture<'_, Result<usize, StoreError>> {
        Local::from_future(async move {
            let count = commits.len() + fragments.len();
            for verified in commits {
                self.save(COMMIT, sedimentree_id, verified)?;
            }
            for verified in fragments {
                self.save(FRAGMENT, sedimentree_id, verified)?;
            }
            Ok(count)
        })
    }
}
