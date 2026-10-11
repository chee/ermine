//! The Subduction node: a signer and the host's store, open to every peer;
//! a sync handler with a remote-heads observer and an ephemeral handler over
//! each connection (as `subduction_wasm` composes them, and
//! `subduction_cli`'s open server); Keyhive frames dropped. Every call is
//! what the TypeScript peer asks of `@automerge/subduction`.

use alloc::{
    boxed::Box,
    collections::BTreeSet,
    format,
    string::{String, ToString},
    sync::Arc,
    vec::Vec,
};
use core::{fmt, time::Duration};

use future_form::Local;
use futures::future::LocalBoxFuture;
use nonempty::NonEmpty;
use sedimentree_core::{
    blob::Blob,
    codec::{
        decode::Decode,
        encode::Encode,
        error::{DecodeError, InvalidSchema},
    },
    crypto::digest::Digest,
    depth::CountLeadingZeroBytes,
    id::SedimentreeId,
    loose_commit::id::CommitId,
};
use subduction_core::{
    authenticated::Authenticated,
    connection::message::{
        BatchSyncResponse, MESSAGE_SCHEMA, SyncMessage, TryAsBatchSyncResponse, TryAsSubscribeRequest,
    },
    handler::{Handler, sync::SyncHandler},
    handshake::{self, audience::Audience},
    peer::{counter::PeerCounter, id::PeerId},
    policy::open::OpenPolicy,
    remote_heads::{RemoteHeads, RemoteHeadsNotifier, RemoteHeadsObserver},
    subduction::{
        Subduction,
        builder::SubductionBuilder,
        error::{IoError, ListenError},
    },
    timeout::call::CallTimeout,
    transport::message::MessageTransport,
};
use subduction_crypto::{nonce::Nonce, signed::Signed, signer::memory::MemorySigner};
use subduction_ephemeral::{
    config::EphemeralConfig,
    handler::EphemeralHandler,
    message::{EPHEMERAL_SCHEMA, EphemeralMessage, EphemeralPayload},
    policy::OpenEphemeralPolicy,
    topic::Topic,
};

use crate::{
    capi::Pending,
    executor::{Clock, Shared, Spawner, Timer},
    link::Link,
    store::HostStore,
};

/// A Keyhive wire frame's schema (`subduction_keyhive`'s `KEYHIVE_SCHEMA`).
const KEYHIVE_SCHEMA: [u8; 4] = *b"SUK\x00";

/// as `subduction_wasm`'s, small for a client
const SHARDS: usize = 4;

type Conn = MessageTransport<Link>;
type Ephemeral = EphemeralHandler<Local, Conn, OpenEphemeralPolicy, Clock, Spawner>;
type Syncing = SyncHandler<Local, HostStore, Conn, OpenPolicy, CountLeadingZeroBytes, Spawner, SHARDS, Heads>;
type Core = Subduction<'static, Local, HostStore, Conn, Composed, OpenPolicy, MemorySigner, Timer, Spawner, CountLeadingZeroBytes, SHARDS>;
type WireError = ListenError<Local, HostStore, Conn, Wire>;

/// A loose commit held: its id, its parents and its blob's digest.
pub(crate) struct Commit {
    pub(crate) id: [u8; 32],
    pub(crate) parents: Vec<[u8; 32]>,
    pub(crate) digest: [u8; 32],
}

/// The public key, and so the peer id, a seed signs as.
pub(crate) fn key(seed: &[u8; 32]) -> [u8; 32] {
    *PeerId::from(MemorySigner::from_bytes(seed).verifying_key()).as_bytes()
}

pub(crate) struct Node {
    core: Arc<Core>,
    ephemeral: Ephemeral,
    signer: MemorySigner,
    shared: Arc<Shared>,
}

impl Node {
    /// A node signing with the seed's key, keeping what it holds in the
    /// host's store, on the executor; what it hears and the heads it is told
    /// of become events.
    pub(crate) fn new(seed: &[u8; 32], store: HostStore, shared: &Arc<Shared>) -> Self {
        let signer = MemorySigner::from_bytes(seed);
        let (core, listener, manager, ephemeral) = SubductionBuilder::<_, _, _, _, _, _, SHARDS>::new()
            .signer(signer.clone())
            .storage(store, Arc::new(OpenPolicy))
            .spawner(Spawner(shared.clone()))
            .timer(Timer(shared.clone()))
            .heads_observer(Heads(shared.clone()))
            // from the wall clock, as the Wasm node's, so a restarted peer's sequence numbers stay above its last
            .send_counter(PeerCounter::with_seed(crate::executor::seed))
            .build_composed::<Local, Conn, Composed, Ephemeral>(|sync| {
                let (ephemeral, inbound) = EphemeralHandler::new(
                    sync.connections(),
                    OpenEphemeralPolicy,
                    EphemeralConfig::default(),
                    Clock(shared.clone()),
                    Spawner(shared.clone()),
                );
                let heard = shared.clone();
                shared.spawn(async move {
                    while let Ok(event) = inbound.recv().await {
                        heard.push(Pending::Heard { topic: *event.id.as_bytes(), sender: *event.sender.as_bytes(), payload: event.payload });
                    }
                });
                (Arc::new(Composed { sync, ephemeral: ephemeral.clone() }), ephemeral)
            });
        shared.spawn(async move {
            let _ = listener.await;
        });
        shared.spawn(async move {
            let _ = manager.await;
        });
        Self { core, ephemeral, signer, shared: shared.clone() }
    }

    /// The client's handshake over a transport the host opened, its audience
    /// discovered by the service name (the URL's host, as `connectDiscover`
    /// takes it), then the connection added: the server's key.
    pub(crate) async fn connect(&self, link: Link, service: String) -> Result<[u8; 32], String> {
        let mut nonce = [0u8; 16];
        crate::random(&mut nonce);
        let (authenticated, peer) = handshake::initiate::<Local, _, _, _, _>(
            link,
            |link, peer| (MessageTransport::new(link), peer),
            &self.signer,
            Audience::discover(service.as_bytes()),
            self.shared.seconds(),
            Nonce::from_u128(u128::from_le_bytes(nonce)),
        )
        .await
        .map_err(|e| format!("handshake: {e:?}"))?;
        let new = self.core.add_connection(authenticated).await.map_err(|e| e.to_string())?;
        if new {
            self.ephemeral.subscribe_peer(peer).await;
        }
        Ok(*peer.as_bytes())
    }

    /// `addCommit(id, commitId, parents, blob)`
    pub(crate) async fn add_commit(&self, doc: [u8; 32], commit: [u8; 32], parents: &[[u8; 32]], blob: Vec<u8>) -> Result<(), String> {
        let parents: BTreeSet<CommitId> = parents.iter().map(|p| CommitId::new(*p)).collect();
        self.core
            .add_commit(SedimentreeId::new(doc), CommitId::new(commit), parents, Blob::new(blob))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// `addFragment(id, head, boundary, checkpoints, blob)` (FRAGMENT.tex)
    pub(crate) async fn add_fragment(&self, doc: [u8; 32], head: [u8; 32], boundary: &[[u8; 32]], checkpoints: &[[u8; 32]], blob: Vec<u8>) -> Result<(), String> {
        let boundary: BTreeSet<CommitId> = boundary.iter().map(|b| CommitId::new(*b)).collect();
        let checkpoints: Vec<CommitId> = checkpoints.iter().map(|c| CommitId::new(*c)).collect();
        self.core
            .add_fragment(SedimentreeId::new(doc), CommitId::new(head), boundary, &checkpoints, Blob::new(blob))
            .await
            .map_err(|e| e.to_string())
    }

    /// `syncWithAllPeers(id, subscribe, timeout)`; no timeout: the node's default
    pub(crate) async fn sync(&self, doc: [u8; 32], subscribe: bool, timeout: Option<Duration>) -> Result<(), String> {
        let timeout = CallTimeout::from(timeout.map(|t| u64::try_from(t.as_millis()).unwrap_or(u64::MAX)));
        self.core
            .sync_with_all_peers(SedimentreeId::new(doc), subscribe, timeout)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// `getCommits(id)`: None when it holds none of the sedimentree
    pub(crate) async fn commits(&self, doc: [u8; 32]) -> Option<Vec<Commit>> {
        let commits = self.core.get_commits(SedimentreeId::new(doc)).await?;
        Some(
            commits
                .iter()
                .map(|c| Commit {
                    id: *c.head().as_bytes(),
                    parents: c.parents().iter().map(|p| *p.as_bytes()).collect(),
                    digest: *c.blob_meta().digest().as_bytes(),
                })
                .collect(),
        )
    }

    /// `getBlob(id, digest)`
    pub(crate) async fn blob(&self, doc: [u8; 32], digest: [u8; 32]) -> Result<Option<Vec<u8>>, String> {
        self.core
            .get_blob(SedimentreeId::new(doc), Digest::force_from_bytes(digest))
            .await
            .map(|blob| blob.map(Blob::into_contents))
            .map_err(|e| format!("{e:?}"))
    }

    /// `subscribeEphemeral([topic])`
    pub(crate) async fn subscribe(&self, topic: [u8; 32]) {
        self.ephemeral.subscribe(NonEmpty::new(Topic::new(topic))).await;
    }

    /// `publishEphemeral(topic, payload)`: signed, a random nonce, the host's clock
    pub(crate) async fn publish(&self, topic: [u8; 32], payload: Vec<u8>) {
        let mut nonce = [0u8; 8];
        crate::random(&mut nonce);
        let message = EphemeralPayload { id: Topic::new(topic), nonce: u64::from_le_bytes(nonce), timestamp: self.shared.seconds(), payload };
        let sealed = Signed::seal::<Local, _>(&self.signer, message).await;
        self.ephemeral.publish(EphemeralMessage::Ephemeral(Box::new(sealed.into_signed()))).await;
    }
}

/// The remote-heads observer: each report an event.
#[derive(Clone)]
pub(crate) struct Heads(Arc<Shared>);

impl fmt::Debug for Heads {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Heads")
    }
}

impl RemoteHeadsObserver for Heads {
    fn on_remote_heads(&self, id: SedimentreeId, peer: PeerId, _heads: RemoteHeads) {
        self.0.push(Pending::Heads { doc: *id.as_bytes(), peer: *peer.as_bytes() });
    }
}

/// What travels over a connection, told apart by schema: sync, ephemeral, or
/// a Keyhive frame, kept as its bytes and dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Wire {
    Sync(Box<SyncMessage>),
    Ephemeral(EphemeralMessage),
    Keyhive(Vec<u8>),
}

impl From<SyncMessage> for Wire {
    fn from(message: SyncMessage) -> Self {
        Self::Sync(Box::new(message))
    }
}

impl From<EphemeralMessage> for Wire {
    fn from(message: EphemeralMessage) -> Self {
        Self::Ephemeral(message)
    }
}

impl TryAsBatchSyncResponse for Wire {
    fn try_as_batch_sync_response(&self) -> Option<&BatchSyncResponse> {
        match self {
            Self::Sync(message) => message.try_as_batch_sync_response(),
            Self::Ephemeral(_) | Self::Keyhive(_) => None,
        }
    }
}

impl TryAsSubscribeRequest for Wire {
    fn try_as_subscribe_request(&self) -> Option<SedimentreeId> {
        match self {
            Self::Sync(message) => message.try_as_subscribe_request(),
            Self::Ephemeral(_) | Self::Keyhive(_) => None,
        }
    }
}

impl Encode for Wire {
    fn encode(&self) -> Vec<u8> {
        match self {
            Self::Sync(message) => Encode::encode(message.as_ref()),
            Self::Ephemeral(message) => message.encode(),
            Self::Keyhive(bytes) => bytes.clone(),
        }
    }

    fn encoded_size(&self) -> usize {
        match self {
            Self::Sync(message) => message.encoded_size(),
            Self::Ephemeral(message) => message.encoded_size(),
            Self::Keyhive(bytes) => bytes.len(),
        }
    }
}

impl Decode for Wire {
    const MIN_SIZE: usize = 8; // schema, then total size

    fn try_decode(buf: &[u8]) -> Result<Self, DecodeError> {
        let Some(schema) = buf.get(0..4).and_then(|s| <[u8; 4]>::try_from(s).ok()) else {
            return Err(DecodeError::MessageTooShort { type_name: "Wire schema", need: 4, have: buf.len() });
        };
        match schema {
            MESSAGE_SCHEMA => SyncMessage::try_decode(buf).map(|m| Self::Sync(Box::new(m))),
            EPHEMERAL_SCHEMA => EphemeralMessage::try_decode(buf).map(Self::Ephemeral),
            KEYHIVE_SCHEMA => Ok(Self::Keyhive(buf.to_vec())),
            got => Err(InvalidSchema { expected: MESSAGE_SCHEMA, got }.into()),
        }
    }
}

/// The sync and ephemeral handlers over one connection.
pub(crate) struct Composed {
    sync: Arc<Syncing>,
    ephemeral: Ephemeral,
}

impl fmt::Debug for Composed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Composed")
    }
}

impl RemoteHeadsNotifier for Composed {
    fn notify_remote_heads(&self, id: SedimentreeId, peer: PeerId, heads: RemoteHeads) {
        RemoteHeadsNotifier::notify_remote_heads(self.sync.as_ref(), id, peer, heads);
    }
}

impl Handler<Local, Conn> for Composed {
    type Message = Wire;
    type HandlerError = WireError;

    fn handle<'a>(&'a self, conn: &'a Authenticated<Conn, Local>, message: Wire) -> LocalBoxFuture<'a, Result<(), WireError>> {
        Box::pin(async move {
            match message {
                Wire::Sync(message) => Handler::<Local, Conn>::handle(self.sync.as_ref(), conn, *message).await.map_err(retyped),
                Wire::Ephemeral(message) => {
                    // an ephemeral handler's failure is not the connection's
                    let _ = Handler::<Local, Conn>::handle(&self.ephemeral, conn, message).await;
                    Ok(())
                }
                Wire::Keyhive(_) => Ok(()),
            }
        })
    }

    fn on_peer_disconnect(&self, peer: PeerId) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            Handler::<Local, Conn>::on_peer_disconnect(self.sync.as_ref(), peer).await;
            Handler::<Local, Conn>::on_peer_disconnect(&self.ephemeral, peer).await;
        })
    }
}

/// the sync handler's error as the wire's: a connection's errors do not depend on its message type
fn retyped(error: ListenError<Local, HostStore, Conn, SyncMessage>) -> WireError {
    match error {
        ListenError::IoError(error) => ListenError::IoError(match error {
            IoError::Storage(e) => IoError::Storage(e),
            IoError::ConnSend(e) => IoError::ConnSend(e),
            IoError::ConnRecv(e) => IoError::ConnRecv(e),
            IoError::ConnCall(e) => IoError::ConnCall(e),
            IoError::BlobMismatch(e) => IoError::BlobMismatch(e),
        }),
        ListenError::TrySendError => ListenError::TrySendError,
    }
}
