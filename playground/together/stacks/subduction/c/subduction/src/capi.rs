//! The C ABI, `subduction.h`. A call starts a task and returns its number;
//! `erm_sd_run` advances the tasks; what they answer, what Subduction does
//! by itself and the messages to send come out of `erm_sd_poll` as events.

use alloc::{
    boxed::Box,
    collections::BTreeMap,
    ffi::CString,
    rc::Rc,
    string::String,
    sync::Arc,
    vec::Vec,
};
use core::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_char, c_int, c_void},
    ptr,
    time::Duration,
};

use crate::{
    executor::{Queue, Shared},
    link::{self, Link},
    node::{Commit, Node},
    store::{ErmStore, HostStore},
};

const DONE: c_int = 1;
const CONNECTED: c_int = 2;
const COMMITS: c_int = 3;
const BLOB: c_int = 4;
const HEADS: c_int = 5;
const HEARD: c_int = 6;
const SEND: c_int = 7;
const CLOSE: c_int = 8;

/// `ErmSdCommit`
#[repr(C)]
pub struct ErmSdCommit {
    pub id: [u8; 32],
    pub digest: [u8; 32],
    pub parents: *const u8,
    pub parent_count: usize,
}

/// `ErmSdEvent`
#[repr(C)]
pub struct ErmSdEvent {
    pub kind: c_int,
    pub call: u64,
    pub conn: u64,
    pub ok: c_int,
    pub error: *const c_char,
    pub doc: [u8; 32],
    pub key: [u8; 32],
    pub topic: [u8; 32],
    pub bytes: *const u8,
    pub length: usize,
    pub found: c_int,
    pub commits: *const ErmSdCommit,
    pub count: usize,
    pub owned: *mut c_void,
}

/// an event as a task makes it, before the host takes it
pub(crate) enum Pending {
    Done { call: u64, error: Option<String> },
    Connected { call: u64, result: Result<[u8; 32], String> },
    Commits { call: u64, doc: [u8; 32], commits: Option<Vec<Commit>> },
    Blob { call: u64, doc: [u8; 32], result: Result<Option<Vec<u8>>, String> },
    Heads { doc: [u8; 32], peer: [u8; 32] },
    Heard { topic: [u8; 32], sender: [u8; 32], payload: Vec<u8> },
    Send { conn: u64, bytes: Vec<u8> },
    Close { conn: u64 },
}

/// what an event handed over holds, until erm_sd_free_event
struct Owned {
    error: Option<CString>,
    bytes: Option<Vec<u8>>,
    parents: Vec<Vec<u8>>,
    commits: Vec<ErmSdCommit>,
}

enum Lane {
    Subscribe([u8; 32]),
    Publish([u8; 32], Vec<u8>),
}

/// `ErmSd`
pub struct ErmSd {
    shared: Arc<Shared>,
    node: Rc<Node>,
    links: RefCell<BTreeMap<u64, Arc<link::State>>>,
    calls: Cell<u64>,
    lane: Rc<Queue<(u64, Lane)>>,
}

impl ErmSd {
    fn call(&self) -> u64 {
        let call = self.calls.get() + 1;
        self.calls.set(call);
        call
    }

    /// a task for the call, its answer queued as an event: the call's number
    fn spawn<F: Future<Output = Pending> + 'static>(&self, work: impl FnOnce(Rc<Node>, u64) -> F) -> u64 {
        let call = self.call();
        let shared = self.shared.clone();
        let future = work(self.node.clone(), call);
        self.shared.spawn(async move { shared.push(future.await) });
        call
    }
}

unsafe fn array(pointer: *const u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    if !pointer.is_null() {
        unsafe { ptr::copy_nonoverlapping(pointer, out.as_mut_ptr(), 32) };
    }
    out
}

/// `length` bytes; None for NULL with a length, which is never read from
unsafe fn vector(pointer: *const u8, length: usize) -> Option<Vec<u8>> {
    if length == 0 {
        return Some(Vec::new());
    }
    if pointer.is_null() {
        return None;
    }
    Some(unsafe { core::slice::from_raw_parts(pointer, length) }.to_vec())
}

/// `count` ids of 32 bytes; None for NULL with a count, which is never read from
unsafe fn arrays(pointer: *const u8, count: usize) -> Option<Vec<[u8; 32]>> {
    let bytes = unsafe { vector(pointer, count.checked_mul(32)?) }?;
    Some(bytes.chunks_exact(32).map(|id| id.try_into().unwrap_or([0; 32])).collect())
}

/// `erm_sd_new`
///
/// # Safety
///
/// `seed` points at 32 bytes; `store` at a store whose functions stay valid while the node lives.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_new(seed: *const u8, now: u64, store: *const ErmStore) -> *mut ErmSd {
    let Some(store) = (unsafe { store.as_ref() }).copied() else { return ptr::null_mut() };
    let seed = unsafe { array(seed) };
    let shared = Shared::new(now);
    let node = Rc::new(Node::new(&seed, HostStore::new(store), &shared));
    let lane = Rc::new(Queue::new());
    let (laned, queue, done) = (node.clone(), lane.clone(), shared.clone());
    shared.spawn(async move {
        loop {
            let (call, job) = queue.next().await;
            match job {
                Lane::Subscribe(topic) => laned.subscribe(topic).await,
                Lane::Publish(topic, payload) => laned.publish(topic, payload).await,
            }
            done.push(Pending::Done { call, error: None });
        }
    });
    Box::into_raw(Box::new(ErmSd { shared, node, links: RefCell::new(BTreeMap::new()), calls: Cell::new(0), lane }))
}

/// `erm_sd_free`
///
/// # Safety
///
/// `sd` is from erm_sd_new, or NULL, and is not used again.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_free(sd: *mut ErmSd) {
    if sd.is_null() {
        return;
    }
    let sd = unsafe { Box::from_raw(sd) };
    sd.shared.clear();
}

/// `erm_sd_key`
///
/// # Safety
///
/// `seed` points at 32 bytes, `out` at room for 32.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_key(seed: *const u8, out: *mut u8) {
    let key = crate::node::key(&unsafe { array(seed) });
    if !out.is_null() {
        unsafe { ptr::copy_nonoverlapping(key.as_ptr(), out, 32) };
    }
}

/// `erm_sd_run`
///
/// # Safety
///
/// `sd` is from erm_sd_new.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_run(sd: *mut ErmSd, now: u64) -> i64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return -1 };
    sd.shared.run(now).map_or(-1, |ms| i64::try_from(ms).unwrap_or(i64::MAX))
}

/// `erm_sd_poll`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `event` points at room for an event.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_poll(sd: *mut ErmSd, event: *mut ErmSdEvent) -> c_int {
    let (Some(sd), false) = (unsafe { sd.as_ref() }, event.is_null()) else { return 0 };
    let Some(pending) = sd.shared.events.borrow_mut().pop_front() else { return 0 };
    let mut out = ErmSdEvent {
        kind: DONE,
        call: 0,
        conn: 0,
        ok: 1,
        error: ptr::null(),
        doc: [0; 32],
        key: [0; 32],
        topic: [0; 32],
        bytes: ptr::null(),
        length: 0,
        found: 0,
        commits: ptr::null(),
        count: 0,
        owned: ptr::null_mut(),
    };
    let mut owned = Box::new(Owned { error: None, bytes: None, parents: Vec::new(), commits: Vec::new() });
    let mut error: Option<String> = None;
    match pending {
        Pending::Done { call, error: why } => {
            out.call = call;
            error = why;
        }
        Pending::Connected { call, result } => {
            out.kind = CONNECTED;
            out.call = call;
            out.conn = call;
            match result {
                Ok(key) => out.key = key,
                Err(why) => error = Some(why),
            }
        }
        Pending::Commits { call, doc, commits } => {
            out.kind = COMMITS;
            out.call = call;
            out.doc = doc;
            out.found = c_int::from(commits.is_some());
            for commit in commits.unwrap_or_default() {
                owned.parents.push(commit.parents.concat());
                owned.commits.push(ErmSdCommit { id: commit.id, digest: commit.digest, parents: ptr::null(), parent_count: commit.parents.len() });
            }
            for (commit, parents) in owned.commits.iter_mut().zip(&owned.parents) {
                commit.parents = parents.as_ptr();
            }
            out.commits = owned.commits.as_ptr();
            out.count = owned.commits.len();
        }
        Pending::Blob { call, doc, result } => {
            out.kind = BLOB;
            out.call = call;
            out.doc = doc;
            match result {
                Ok(blob) => owned.bytes = blob,
                Err(why) => error = Some(why),
            }
        }
        Pending::Heads { doc, peer } => {
            out.kind = HEADS;
            out.doc = doc;
            out.key = peer;
        }
        Pending::Heard { topic, sender, payload } => {
            out.kind = HEARD;
            out.topic = topic;
            out.key = sender;
            owned.bytes = Some(payload);
        }
        Pending::Send { conn, bytes } => {
            out.kind = SEND;
            out.conn = conn;
            owned.bytes = Some(bytes);
        }
        Pending::Close { conn } => {
            out.kind = CLOSE;
            out.conn = conn;
        }
    }
    owned.error = error.map(|why| CString::new(why.replace('\0', " ")).unwrap_or_default());
    if let Some(error) = &owned.error {
        out.ok = 0;
        out.error = error.as_ptr();
    }
    if let Some(bytes) = &owned.bytes {
        out.bytes = bytes.as_ptr(); // never NULL, even for no bytes
        out.length = bytes.len();
    }
    out.owned = Box::into_raw(owned).cast();
    unsafe { event.write(out) };
    1
}

/// `erm_sd_free_event`
///
/// # Safety
///
/// `event` was filled by erm_sd_poll, or is NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_free_event(event: *mut ErmSdEvent) {
    let Some(event) = (unsafe { event.as_mut() }) else { return };
    if !event.owned.is_null() {
        drop(unsafe { Box::from_raw(event.owned.cast::<Owned>()) });
    }
    event.owned = ptr::null_mut();
    event.error = ptr::null();
    event.bytes = ptr::null();
    event.commits = ptr::null();
    event.length = 0;
    event.count = 0;
}

/// `erm_sd_connect`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `service` is a C string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_connect(sd: *mut ErmSd, service: *const c_char) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let service = if service.is_null() { String::new() } else { String::from(unsafe { CStr::from_ptr(service) }.to_string_lossy()) };
    let shared = sd.shared.clone();
    let links = &sd.links;
    sd.spawn(|node, call| {
        let state = link::State::new(call);
        links.borrow_mut().insert(call, state.clone());
        let link = Link { state, shared };
        async move { Pending::Connected { call, result: node.connect(link, service).await } }
    })
}

/// `erm_sd_received`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `bytes` points at `length` bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_received(sd: *mut ErmSd, conn: u64, bytes: *const u8, length: usize) {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return };
    // NULL with a length: nothing to hand on
    if let (Some(state), Some(bytes)) = (sd.links.borrow().get(&conn), unsafe { vector(bytes, length) }) {
        state.received(bytes);
    }
}

/// `erm_sd_closed`
///
/// # Safety
///
/// `sd` is from erm_sd_new.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_closed(sd: *mut ErmSd, conn: u64) {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return };
    if let Some(state) = sd.links.borrow_mut().remove(&conn) {
        state.close();
    }
}

/// `erm_sd_add_commit`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `doc` and `commit` point at 32 bytes, `parents`
/// at `count` * 32, `blob` at `length`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_add_commit(sd: *mut ErmSd, doc: *const u8, commit: *const u8, parents: *const u8, count: usize, blob: *const u8, length: usize) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let (doc, commit) = (unsafe { array(doc) }, unsafe { array(commit) });
    let (Some(parents), Some(blob)) = (unsafe { arrays(parents, count) }, unsafe { vector(blob, length) }) else { return 0 };
    sd.spawn(|node, call| async move { Pending::Done { call, error: node.add_commit(doc, commit, &parents, blob).await.err() } })
}

/// `erm_sd_add_fragment`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `doc` and `head` point at 32 bytes, `boundary`
/// at `count` * 32, `checkpoints` at `checks` * 32, `blob` at `length`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_add_fragment(
    sd: *mut ErmSd,
    doc: *const u8,
    head: *const u8,
    boundary: *const u8,
    count: usize,
    checkpoints: *const u8,
    checks: usize,
    blob: *const u8,
    length: usize,
) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let (doc, head) = (unsafe { array(doc) }, unsafe { array(head) });
    let (Some(boundary), Some(checkpoints), Some(blob)) = (unsafe { arrays(boundary, count) }, unsafe { arrays(checkpoints, checks) }, unsafe { vector(blob, length) }) else {
        return 0;
    };
    sd.spawn(|node, call| async move { Pending::Done { call, error: node.add_fragment(doc, head, &boundary, &checkpoints, blob).await.err() } })
}

/// `erm_sd_sync`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `doc` points at 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_sync(sd: *mut ErmSd, doc: *const u8, subscribe: c_int, timeout: u64) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let doc = unsafe { array(doc) };
    let timeout = (timeout > 0).then(|| Duration::from_millis(timeout));
    sd.spawn(|node, call| async move { Pending::Done { call, error: node.sync(doc, subscribe != 0, timeout).await.err() } })
}

/// `erm_sd_commits`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `doc` points at 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_commits(sd: *mut ErmSd, doc: *const u8) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let doc = unsafe { array(doc) };
    sd.spawn(|node, call| async move { Pending::Commits { call, doc, commits: node.commits(doc).await } })
}

/// `erm_sd_blob`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `doc` and `digest` point at 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_blob(sd: *mut ErmSd, doc: *const u8, digest: *const u8) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let (doc, digest) = (unsafe { array(doc) }, unsafe { array(digest) });
    sd.spawn(|node, call| async move { Pending::Blob { call, doc, result: node.blob(doc, digest).await } })
}

/// `erm_sd_subscribe`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `topic` points at 32 bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_subscribe(sd: *mut ErmSd, topic: *const u8) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let call = sd.call();
    sd.lane.put((call, Lane::Subscribe(unsafe { array(topic) })));
    call
}

/// `erm_sd_publish`
///
/// # Safety
///
/// `sd` is from erm_sd_new; `topic` points at 32 bytes, `payload` at `length`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_publish(sd: *mut ErmSd, topic: *const u8, payload: *const u8, length: usize) -> u64 {
    let Some(sd) = (unsafe { sd.as_ref() }) else { return 0 };
    let Some(payload) = (unsafe { vector(payload, length) }) else { return 0 };
    let call = sd.call();
    sd.lane.put((call, Lane::Publish(unsafe { array(topic) }, payload)));
    call
}

// records (store.h), decoded with no task: for a host that reads the store itself ----------------------------

/// `ErmSdRecord`
#[repr(C)]
pub struct ErmSdRecord {
    pub fragment: c_int,
    pub id: [u8; 32],
    pub digest: [u8; 32],
    pub size: u64,
    pub issuer: [u8; 32],
    pub parents: *const u8,
    pub parent_count: usize,
    pub checkpoints: *const u8,
    pub checkpoint_count: usize,
    pub owned: *mut c_void,
}

/// what a decoded record holds, until erm_sd_free_record
struct Lists {
    parents: Vec<u8>,
    checkpoints: Vec<u8>,
}

/// `erm_sd_decode`
///
/// # Safety
///
/// `bytes` points at `length` bytes; `out` at room for a record.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_decode(kind: c_int, bytes: *const u8, length: usize, out: *mut ErmSdRecord) -> c_int {
    use sedimentree_core::{fragment::Fragment, loose_commit::LooseCommit};
    use subduction_crypto::signed::Signed;
    if out.is_null() || (bytes.is_null() && length > 0) {
        return 0;
    }
    let bytes = if length == 0 { &[][..] } else { unsafe { core::slice::from_raw_parts(bytes, length) } };
    let mut record = ErmSdRecord {
        fragment: 0,
        id: [0; 32],
        digest: [0; 32],
        size: 0,
        issuer: [0; 32],
        parents: ptr::null(),
        parent_count: 0,
        checkpoints: ptr::null(),
        checkpoint_count: 0,
        owned: ptr::null_mut(),
    };
    let mut lists = Box::new(Lists { parents: Vec::new(), checkpoints: Vec::new() });
    match kind {
        1 => {
            let Ok(signed) = Signed::<LooseCommit>::try_decode(bytes) else { return 0 };
            let Ok(commit) = signed.try_decode_trusted_payload() else { return 0 };
            record.id = *commit.head().as_bytes();
            record.digest = *commit.blob_meta().digest().as_bytes();
            record.size = commit.blob_meta().size_bytes();
            record.issuer = signed.issuer().to_bytes();
            for parent in commit.parents() {
                lists.parents.extend_from_slice(parent.as_bytes());
            }
            record.parent_count = commit.parents().len();
        }
        2 => {
            let Ok(signed) = Signed::<Fragment>::try_decode(bytes) else { return 0 };
            let Ok(fragment) = signed.try_decode_trusted_payload() else { return 0 };
            let meta = fragment.summary().blob_meta();
            record.fragment = 1;
            record.id = *fragment.head().as_bytes();
            record.digest = *meta.digest().as_bytes();
            record.size = meta.size_bytes();
            record.issuer = signed.issuer().to_bytes();
            for boundary in fragment.boundary() {
                lists.parents.extend_from_slice(boundary.as_bytes());
            }
            record.parent_count = fragment.boundary().len();
            for checkpoint in fragment.checkpoints() {
                lists.checkpoints.extend_from_slice(checkpoint.as_bytes());
            }
            record.checkpoint_count = fragment.checkpoints().len();
        }
        _ => return 0,
    }
    record.parents = lists.parents.as_ptr();
    record.checkpoints = lists.checkpoints.as_ptr();
    record.owned = Box::into_raw(lists).cast();
    unsafe { out.write(record) };
    1
}

/// `erm_sd_free_record`
///
/// # Safety
///
/// `record` was filled by erm_sd_decode, or is NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn erm_sd_free_record(record: *mut ErmSdRecord) {
    let Some(record) = (unsafe { record.as_mut() }) else { return };
    if !record.owned.is_null() {
        drop(unsafe { Box::from_raw(record.owned.cast::<Lists>()) });
    }
    record.owned = ptr::null_mut();
    record.parents = ptr::null();
    record.checkpoints = ptr::null();
}
