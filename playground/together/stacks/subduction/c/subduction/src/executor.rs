//! The executor: single-threaded, run by the host. Tasks wait in a queue
//! until woken; timers wait on the host's clock, which moves only when it
//! calls `run`. Nothing here blocks, sleeps or starts a thread.
//!
//! Everything a node holds is behind one `Shared`, used from one thread at a
//! time (the host's calls are never concurrent: `subduction.h`), so its
//! cells are marked `Send` and `Sync` for the bounds Subduction puts on
//! spawners and timers, which it shares as it would across threads.

use alloc::{
    boxed::Box,
    collections::{BTreeMap, VecDeque},
    sync::Arc,
    task::Wake,
    vec::Vec,
};
use core::{
    cell::{Cell, RefCell},
    future::Future,
    pin::Pin,
    task::{Context, Poll, Waker},
    time::Duration,
};

use futures::{
    future::{Abortable, Either, LocalBoxFuture, select},
    stream::AbortHandle,
};
use subduction_core::{
    spawn::Spawn,
    timeout::{TimedOut, Timeout},
    timestamp::TimestampSeconds,
};

use crate::capi::Pending;

type Task = Pin<Box<dyn Future<Output = ()>>>;

/// The polls one `run` makes at most before it hands back to the host.
const BUDGET: usize = 100_000;

/// A node's state, the executor's and the host's queue of events.
pub(crate) struct Shared {
    tasks: RefCell<Vec<Option<Task>>>,
    free: RefCell<Vec<usize>>,
    ready: RefCell<VecDeque<usize>>,
    timers: RefCell<BTreeMap<(u64, u64), Waker>>,
    timer: Cell<u64>,
    now: Cell<u64>,
    pub(crate) events: RefCell<VecDeque<Pending>>,
}

// One thread at a time: see the module's comment.
unsafe impl Send for Shared {}
unsafe impl Sync for Shared {}

/// the wall clock the host last passed, in ms, for the send counter's seed (a plain fn)
static SEED: [core::sync::atomic::AtomicU32; 2] = [core::sync::atomic::AtomicU32::new(0), core::sync::atomic::AtomicU32::new(0)];

/// the counter a peer's sequence numbers start from: the wall clock in µs, as `wall_clock_seed`'s
pub(crate) fn seed() -> u64 {
    use core::sync::atomic::Ordering;
    let ms = (u64::from(SEED[0].load(Ordering::Relaxed)) << 32) | u64::from(SEED[1].load(Ordering::Relaxed));
    ms.saturating_mul(1000)
}

struct Wakes {
    id: usize,
    shared: Arc<Shared>,
}

impl Wake for Wakes {
    fn wake(self: Arc<Self>) {
        self.wake_by_ref();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.shared.ready.borrow_mut().push_back(self.id);
    }
}

impl Shared {
    pub(crate) fn new(now: u64) -> Arc<Self> {
        let shared = Arc::new(Self {
            tasks: RefCell::new(Vec::new()),
            free: RefCell::new(Vec::new()),
            ready: RefCell::new(VecDeque::new()),
            timers: RefCell::new(BTreeMap::new()),
            timer: Cell::new(0),
            now: Cell::new(0),
            events: RefCell::new(VecDeque::new()),
        });
        shared.set_now(now);
        shared
    }

    /// the host's clock: ms since the Unix epoch, never back
    fn set_now(&self, now: u64) {
        use core::sync::atomic::Ordering;
        let now = now.max(self.now.get());
        self.now.set(now);
        SEED[0].store((now >> 32) as u32, Ordering::Relaxed);
        SEED[1].store(now as u32, Ordering::Relaxed);
    }

    pub(crate) fn seconds(&self) -> TimestampSeconds {
        TimestampSeconds::new(self.now.get() / 1000)
    }

    pub(crate) fn push(&self, pending: Pending) {
        self.events.borrow_mut().push_back(pending);
    }

    pub(crate) fn spawn(self: &Arc<Self>, task: impl Future<Output = ()> + 'static) {
        let task: Task = Box::pin(task);
        let id = if let Some(id) = self.free.borrow_mut().pop() {
            self.tasks.borrow_mut()[id] = Some(task);
            id
        } else {
            let mut tasks = self.tasks.borrow_mut();
            tasks.push(Some(task));
            tasks.len() - 1
        };
        self.ready.borrow_mut().push_back(id);
    }

    /// Wakes the timers due by `now`, then polls what is ready until nothing
    /// is: the ms until a timer is due (0: more is ready; None: none waits).
    pub(crate) fn run(self: &Arc<Self>, now: u64) -> Option<u64> {
        self.set_now(now);
        let now = self.now.get();
        let due: Vec<Waker> = {
            let mut timers = self.timers.borrow_mut();
            let later = timers.split_off(&(now + 1, 0));
            core::mem::replace(&mut *timers, later).into_values().collect()
        };
        for waker in due {
            waker.wake();
        }
        for _ in 0..BUDGET {
            let Some(id) = self.ready.borrow_mut().pop_front() else { break };
            let Some(mut task) = self.tasks.borrow_mut().get_mut(id).and_then(Option::take) else { continue };
            let waker = Waker::from(Arc::new(Wakes { id, shared: self.clone() }));
            if task.as_mut().poll(&mut Context::from_waker(&waker)).is_pending() {
                self.tasks.borrow_mut()[id] = Some(task);
            } else {
                self.free.borrow_mut().push(id);
            }
        }
        if !self.ready.borrow().is_empty() {
            return Some(0);
        }
        self.timers.borrow().keys().next().map(|(at, _)| at.saturating_sub(now))
    }

    /// drops every task and timer, which hold this, so it can be freed
    pub(crate) fn clear(&self) {
        let tasks = core::mem::take(&mut *self.tasks.borrow_mut());
        drop(tasks);
        self.timers.borrow_mut().clear();
        self.ready.borrow_mut().clear();
        self.events.borrow_mut().clear();
    }

    fn sleep(self: &Arc<Self>, duration: Duration) -> Sleep {
        let ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        let key = self.timer.get() + 1;
        self.timer.set(key);
        Sleep { shared: self.clone(), at: self.now.get().saturating_add(ms), key }
    }
}

/// A timer: ready once the host's clock reaches it.
struct Sleep {
    shared: Arc<Shared>,
    at: u64,
    key: u64,
}

impl Future for Sleep {
    type Output = ();

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.shared.now.get() >= self.at {
            self.shared.timers.borrow_mut().remove(&(self.at, self.key));
            return Poll::Ready(());
        }
        self.shared.timers.borrow_mut().insert((self.at, self.key), cx.waker().clone());
        Poll::Pending
    }
}

impl Drop for Sleep {
    fn drop(&mut self) {
        if let Ok(mut timers) = self.shared.timers.try_borrow_mut() {
            timers.remove(&(self.at, self.key));
        }
    }
}

/// Subduction's spawner: tasks on this executor.
#[derive(Clone)]
pub(crate) struct Spawner(pub(crate) Arc<Shared>);

impl core::fmt::Debug for Spawner {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Spawner")
    }
}

impl Spawn<future_form::Local> for Spawner {
    fn spawn(&self, fut: LocalBoxFuture<'static, ()>) -> AbortHandle {
        let (handle, registration) = AbortHandle::new_pair();
        self.0.spawn(async move {
            let _ = Abortable::new(fut, registration).await;
        });
        handle
    }
}

/// Subduction's timeouts, on the host's clock.
#[derive(Clone)]
pub(crate) struct Timer(pub(crate) Arc<Shared>);

impl core::fmt::Debug for Timer {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Timer")
    }
}

impl Timeout<future_form::Local> for Timer {
    fn timeout<'a, T: 'a>(&'a self, dur: Duration, fut: LocalBoxFuture<'a, T>) -> LocalBoxFuture<'a, Result<T, TimedOut>> {
        let sleep = self.0.sleep(dur);
        Box::pin(async move {
            match select(fut, sleep).await {
                Either::Left((value, _)) => Ok(value),
                Either::Right(_) => Err(TimedOut),
            }
        })
    }
}

/// The ephemeral handler's wall clock: the host's.
#[derive(Clone)]
pub(crate) struct Clock(pub(crate) Arc<Shared>);

impl core::fmt::Debug for Clock {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("Clock")
    }
}

impl subduction_ephemeral::clock::Clock for Clock {
    fn now(&self) -> TimestampSeconds {
        self.0.seconds()
    }
}

/// A queue one task drains in order, woken as things are put in it.
pub(crate) struct Queue<T> {
    items: RefCell<VecDeque<T>>,
    waker: RefCell<Option<Waker>>,
}

impl<T> Queue<T> {
    pub(crate) fn new() -> Self {
        Self { items: RefCell::new(VecDeque::new()), waker: RefCell::new(None) }
    }

    pub(crate) fn put(&self, item: T) {
        self.items.borrow_mut().push_back(item);
        if let Some(waker) = self.waker.borrow_mut().take() {
            waker.wake();
        }
    }

    /// the next item, once there is one
    pub(crate) fn next(&self) -> impl Future<Output = T> + '_ {
        core::future::poll_fn(move |cx| {
            if let Some(item) = self.items.borrow_mut().pop_front() {
                return Poll::Ready(item);
            }
            *self.waker.borrow_mut() = Some(cx.waker().clone());
            Poll::Pending
        })
    }
}
