use crate::{Message, Pool, Thunk, WaitGroup};
use std::{marker::PhantomData, sync::Arc};

/// A scope represents a bunch of jobs that must be finished if this scope is dropped.
pub struct Scope<'scope> {
    pool: Pool,
    wait: Arc<WaitGroup>,
    // make `'scope` lifetime invariant
    __variance: PhantomData<*mut &'scope ()>,
}

// Safety
//
// We need `Send` + `Sync` bounds, but they are negated by the `__variance` field.
// However the `__variance` field should only modify the variance of the `'scope` lifetime
// and should ignore the trait bounds.
unsafe impl Send for Scope<'_> {}
unsafe impl Sync for Scope<'_> {}

impl<'scope> Scope<'scope> {
    /// Create a Scope which lasts forever.
    #[inline]
    pub fn forever(pool: Pool) -> Scope<'static> {
        Scope {
            pool,
            wait: Arc::new(WaitGroup::default()),
            __variance: PhantomData,
        }
    }

    /// Add a job to this scope.
    ///
    /// Subsequent calls to `join` will wait for this job to complete.
    pub fn execute<F>(&self, job: F)
    where
        F: FnOnce() + Send + 'scope,
    {
        self.wait.submit();

        let task = unsafe {
            // Safety
            // we make sure that the task execution finished before `'scope` goes
            // out of scope
            std::mem::transmute::<Thunk<'scope>, Thunk<'static>>(Box::new(job))
        };

        // send the task to the worker threads
        self.pool
            .inner
            .msg_tx
            .send(Message::Job(task, self.wait.clone()))
            .expect("failed to send message via channel");
    }

    /// Add a job to this scope, which will also get access to this scope and thus can spawn more
    /// jobs that belong to this scope.
    pub fn recurse<F>(&self, job: F)
    where
        F: FnOnce(&Self) + Send + 'scope,
    {
        let this = self.private_clone();
        self.execute(move || job(&this));
    }

    /// Awaits all jobs submitted on this Scope to be completed.
    ///
    /// Only guaranteed to join jobs which where executed logically
    /// prior to `join`. Jobs executed concurrently with `join` may
    /// or may not be completed before `join` returns.
    pub fn join(&self) {
        self.wait.join()
    }

    /// Create a new subscope, bound to a lifetime smaller than our existing Scope.
    ///
    /// The subscope has a different job set, and is joined before zoom returns.
    pub fn zoom<'smaller, F, R>(&self, job: F) -> R
    where
        F: FnOnce(&Scope<'smaller>) -> R,
        'scope: 'smaller,
    {
        let scope = self.refine();

        // the subscope must finish at the same time this scope finishes
        scopeguard::defer!(scope.join());

        job(&scope)
    }

    /// Clone this scope, but don't expose this functionality to the user.
    fn private_clone(&self) -> Self {
        Scope {
            pool: self.pool.clone(),
            wait: self.wait.clone(),
            __variance: PhantomData,
        }
    }

    /// Create a new scope with a smaller lifetime.
    fn refine<'other>(&self) -> Scope<'other>
    where
        'scope: 'other,
    {
        Scope {
            pool: self.pool.clone(),
            wait: Arc::new(WaitGroup::default()),
            __variance: PhantomData,
        }
    }
}
