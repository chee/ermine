//! One request per line in, one answer per line out. Ids are 64 lowercase hex digits; a list is
//! comma-separated (may be empty).
//!
//!   build|COMMITS|HEADS|KNOWN  ->  FRAGMENT;FRAGMENT;...   (the fresh ones, sorted by head)
//!   walk|COMMITS|HEAD|KNOWN    ->  FRAGMENT | !missing | !depth-zero
//!
//! COMMITS  id:parent,parent;id:;...      the commits here
//! KNOWN    FRAGMENT;FRAGMENT;...         fragments here already
//! FRAGMENT head/members/boundary/checkpoints, each list sorted bytewise
//!
//! build is `CommitStore::build_fragment_store`, walk is `CommitStore::fragment`, both with
//! `CountLeadingZeroBytes`. Nothing here decides anything.

use std::collections::{BTreeMap, BTreeSet};
use std::convert::Infallible;
use std::io::{BufRead, Write};

use sedimentree_core::commit::{CommitStore, FragmentError, FragmentState};
use sedimentree_core::depth::CountLeadingZeroBytes;
use sedimentree_core::loose_commit::id::CommitId;

type Node = BTreeSet<CommitId>;

struct Store(BTreeMap<CommitId, Node>);

impl<'a> CommitStore<'a> for Store {
    type Node = Node;
    type LookupError = Infallible;
    fn lookup(&self, id: CommitId) -> Result<Option<Node>, Infallible> {
        Ok(self.0.get(&id).cloned())
    }
}

fn id(s: &str) -> CommitId {
    assert_eq!(s.len(), 64, "an id is 64 hex digits: {s}");
    let mut b = [0u8; 32];
    for (i, x) in b.iter_mut().enumerate() {
        *x = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex");
    }
    CommitId::new(b)
}

fn hex(c: &CommitId) -> String {
    c.as_bytes().iter().map(|x| format!("{x:02x}")).collect()
}

fn ids(s: &str) -> Vec<CommitId> {
    s.split(',').filter(|x| !x.is_empty()).map(id).collect()
}

fn list<'x>(c: impl Iterator<Item = &'x CommitId>) -> String {
    let set: BTreeSet<&CommitId> = c.collect();
    set.into_iter().map(hex).collect::<Vec<_>>().join(",")
}

fn show(f: &FragmentState<Node>) -> String {
    format!(
        "{}/{}/{}/{}",
        hex(&f.head_id()),
        list(f.members().iter()),
        list(f.boundary().keys()),
        list(f.checkpoints().iter())
    )
}

fn commits(s: &str) -> Store {
    let mut m = BTreeMap::new();
    for c in s.split(';').filter(|x| !x.is_empty()) {
        let (i, ps) = c.split_once(':').expect("id:parents");
        m.insert(id(i), ids(ps).into_iter().collect());
    }
    Store(m)
}

fn known(s: &str) -> BTreeMap<CommitId, FragmentState<Node>> {
    let mut m = BTreeMap::new();
    for f in s.split(';').filter(|x| !x.is_empty()) {
        let parts: Vec<&str> = f.split('/').collect();
        assert_eq!(parts.len(), 4, "head/members/boundary/checkpoints");
        let head = id(parts[0]);
        // the boundary's nodes are never read, only its keys
        let boundary = ids(parts[2]).into_iter().map(|b| (b, Node::new())).collect();
        let state = FragmentState::new(
            head,
            ids(parts[1]).into_iter().collect(),
            ids(parts[3]).into_iter().collect(),
            boundary,
        );
        m.insert(head, state);
    }
    m
}

fn answer(line: &str) -> String {
    let parts: Vec<&str> = line.split('|').collect();
    assert_eq!(parts.len(), 4, "op|commits|heads|known");
    let store = commits(parts[1]);
    let mut known = known(parts[3]);
    match parts[0] {
        "build" => {
            let fresh = store
                .build_fragment_store(&ids(parts[2]), &mut known, &CountLeadingZeroBytes)
                .unwrap_or_else(|e| panic!("build failed: {e}"));
            let mut out: Vec<&FragmentState<Node>> = fresh;
            out.sort_by_key(|f| f.head_id());
            out.into_iter().map(show).collect::<Vec<_>>().join(";")
        }
        "walk" => match store.fragment(id(parts[2]), &known, &CountLeadingZeroBytes) {
            Ok(f) => show(&f),
            Err(FragmentError::MissingCommit(_)) => "!missing".into(),
            Err(FragmentError::DepthZeroHead(_)) => "!depth-zero".into(),
            Err(FragmentError::LookupError(e)) => match e {},
        },
        op => panic!("unknown op {op}"),
    }
}

fn main() {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("stdin");
        if line.trim().is_empty() {
            continue;
        }
        writeln!(out, "{}", answer(line.trim())).expect("stdout");
    }
}
