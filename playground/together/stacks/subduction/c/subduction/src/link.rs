//! The host's transport, as Subduction sees one: whole messages (a
//! WebSocket's binary messages) the host hands in, and messages to send it
//! takes out as events, as `subduction_wasm`'s `JsTransport` is one that
//! JavaScript owns.

use alloc::{collections::VecDeque, sync::Arc, vec::Vec};
use core::{
    cell::{Cell, RefCell},
    fmt,
    task::{Poll, Waker},
};

use future_form::Local;
use futures::future::LocalBoxFuture;
use subduction_core::{handshake::Handshake, transport::Transport};

use crate::{capi::Pending, executor::Shared};

/// One connection the host owns.
pub(crate) struct State {
    pub(crate) id: u64,
    inbound: RefCell<VecDeque<Vec<u8>>>,
    waiting: RefCell<Vec<Waker>>,
    closed: Cell<bool>,
}

// One thread at a time (executor.rs).
unsafe impl Send for State {}
unsafe impl Sync for State {}

impl State {
    pub(crate) fn new(id: u64) -> Arc<Self> {
        Arc::new(Self { id, inbound: RefCell::new(VecDeque::new()), waiting: RefCell::new(Vec::new()), closed: Cell::new(false) })
    }

    fn wake(&self) {
        for waker in self.waiting.borrow_mut().drain(..) {
            waker.wake();
        }
    }

    /// a message the host received
    pub(crate) fn received(&self, bytes: Vec<u8>) {
        if !self.closed.get() {
            self.inbound.borrow_mut().push_back(bytes);
            self.wake();
        }
    }

    /// the host's transport closed
    pub(crate) fn close(&self) {
        self.closed.set(true);
        self.wake();
    }
}

#[derive(Clone)]
pub(crate) struct Link {
    pub(crate) state: Arc<State>,
    pub(crate) shared: Arc<Shared>,
}

impl fmt::Debug for Link {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Link({})", self.state.id)
    }
}

impl PartialEq for Link {
    fn eq(&self, other: &Self) -> bool {
        self.state.id == other.state.id
    }
}

/// The transport is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Closed;

impl fmt::Display for Closed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the connection is closed")
    }
}

impl core::error::Error for Closed {}

impl Link {
    fn send(&self, bytes: Vec<u8>) -> Result<(), Closed> {
        if self.state.closed.get() {
            return Err(Closed);
        }
        self.shared.push(Pending::Send { conn: self.state.id, bytes });
        Ok(())
    }

    async fn recv(&self) -> Result<Vec<u8>, Closed> {
        core::future::poll_fn(|cx| {
            if let Some(bytes) = self.state.inbound.borrow_mut().pop_front() {
                return Poll::Ready(Ok(bytes));
            }
            if self.state.closed.get() {
                return Poll::Ready(Err(Closed));
            }
            let mut waiting = self.state.waiting.borrow_mut();
            if !waiting.iter().any(|w| w.will_wake(cx.waker())) {
                waiting.push(cx.waker().clone());
            }
            Poll::Pending
        })
        .await
    }
}

impl Transport<Local> for Link {
    type SendError = Closed;
    type RecvError = Closed;
    type DisconnectionError = Closed;

    fn send_bytes(&self, bytes: &[u8]) -> LocalBoxFuture<'_, Result<(), Closed>> {
        let sent = self.send(bytes.to_vec());
        alloc::boxed::Box::pin(async move { sent })
    }

    fn recv_bytes(&self) -> LocalBoxFuture<'_, Result<Vec<u8>, Closed>> {
        alloc::boxed::Box::pin(self.recv())
    }

    fn disconnect(&self) -> LocalBoxFuture<'_, Result<(), Closed>> {
        if !self.state.closed.get() {
            self.shared.push(Pending::Close { conn: self.state.id });
        }
        self.state.close();
        alloc::boxed::Box::pin(async { Ok(()) })
    }
}

impl Handshake<Local> for Link {
    type Error = Closed;

    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, Result<(), Closed>> {
        let sent = Link::send(self, bytes);
        alloc::boxed::Box::pin(async move { sent })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Result<Vec<u8>, Closed>> {
        alloc::boxed::Box::pin(Link::recv(self))
    }
}
