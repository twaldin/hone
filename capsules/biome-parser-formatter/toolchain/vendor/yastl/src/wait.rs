use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Condvar, Mutex,
};

/// Synchronization primitive to await a set of actions.
#[derive(Default)]
pub(crate) struct WaitGroup {
    pending: AtomicUsize,
    poisoned: AtomicBool,
    lock: Mutex<()>,
    condvar: Condvar,
}

impl WaitGroup {
    /// Submit a job to this waitgroup, which can be awaited using `complete`.
    pub fn submit(&self) {
        self.pending.fetch_add(1, Ordering::SeqCst);
    }

    /// Complete a previous `submit` call and wake all threads that called `join`
    /// if there's no job left to wait for.
    pub fn complete(&self) {
        let old = self.pending.fetch_sub(1, Ordering::SeqCst);

        // release all joined threads if this is the last job
        if old == 1 {
            let _guard = self.lock.lock().unwrap();
            self.condvar.notify_all();
        }
    }

    /// Poisons this wait group and complete one job.
    ///
    /// This must be called if the executing job panics.
    pub fn poison(&self) {
        self.poisoned.store(true, Ordering::SeqCst);
        self.complete();
    }

    /// Wait for all jobs of this wait group to be completed.
    pub fn join(&self) {
        let mut lock = self.lock.lock().unwrap();

        while self.pending.load(Ordering::SeqCst) > 0 {
            lock = self.condvar.wait(lock).unwrap();
        }

        if self.poisoned.load(Ordering::SeqCst) {
            panic!("Worker Pool was poisoned")
        }
    }
}

/// Poisons the inner wait group if this sentinel is dropped before canceling.
pub(crate) struct Sentinel(pub(crate) Option<Arc<WaitGroup>>);

impl Sentinel {
    /// Cancels this sentinel, causing to not poison the wait group.
    pub fn cancel(mut self) {
        if let Some(wait) = self.0.take() {
            wait.complete();
        }
    }
}

impl Drop for Sentinel {
    fn drop(&mut self) {
        if let Some(ref wait) = self.0.take() {
            wait.poison();
        }
    }
}
