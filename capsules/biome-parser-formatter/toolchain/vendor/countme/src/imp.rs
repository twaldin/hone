use std::{
    any::{type_name, TypeId},
    cell::RefCell,
    collections::HashMap,
    hash::BuildHasherDefault,
    os::raw::c_int,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed},
    sync::Arc,
};

use dashmap::DashMap;
use once_cell::sync::OnceCell;
use rustc_hash::FxHasher;

use crate::{AllCounts, Counts};

static ENABLE: AtomicBool = AtomicBool::new(cfg!(feature = "print_at_exit"));

type GlobalStore = DashMap<TypeId, Arc<Store>, BuildHasherDefault<FxHasher>>;

#[inline]
fn global_store() -> &'static GlobalStore {
    static MAP: OnceCell<GlobalStore> = OnceCell::new();
    MAP.get_or_init(|| {
        if cfg!(feature = "print_at_exit") {
            extern "C" {
                fn atexit(f: extern "C" fn()) -> c_int;
            }
            extern "C" fn print_at_exit() {
                eprint!("{}", get_all());
            }
            unsafe {
                atexit(print_at_exit);
            }
        }

        GlobalStore::default()
    })
}

thread_local! {
    static LOCAL: RefCell<HashMap<TypeId, Arc<Store>, BuildHasherDefault<FxHasher>>> = RefCell::default();
}

pub(crate) fn enable(yes: bool) {
    ENABLE.store(yes, Relaxed);
}

#[inline]
fn enabled() -> bool {
    ENABLE.load(Relaxed)
}

#[inline]
pub(crate) fn dec<T: 'static>() {
    if enabled() {
        do_dec(TypeId::of::<T>())
    }
}
#[inline(never)]
fn do_dec(key: TypeId) {
    LOCAL.with(|local| {
        // Fast path: we have needed store in thread local map
        if let Some(store) = local.borrow().get(&key) {
            store.dec();
            return;
        }

        let global = global_store();

        // Slightly slower: we don't have needed store in our thread local map,
        // but some other thread has already initialized the needed store in the global map
        if let Some(store) = global.get(&key) {
            let store = store.value();
            local.borrow_mut().insert(key, Arc::clone(store));
            store.inc();
            return;
        }

        // We only decrement counter after incremenrting it, so this line is unreachable
    })
}

#[inline]
pub(crate) fn inc<T: 'static>() {
    if enabled() {
        do_inc(TypeId::of::<T>(), type_name::<T>())
    }
}
#[inline(never)]
fn do_inc(key: TypeId, name: &'static str) {
    LOCAL.with(|local| {
        // Fast path: we have needed store in thread local map
        if let Some(store) = local.borrow().get(&key) {
            store.inc();
            return;
        }

        let global = global_store();

        let copy = match global.get(&key) {
            // Slightly slower path: we don't have needed store in our thread local map,
            // but some other thread has already initialized the needed store in the global map
            Some(store) => {
                let store = store.value();
                store.inc();
                Arc::clone(store)
            }
            // Slow path: we are the first to initialize both global and local maps
            None => {
                let store = global
                    .entry(key)
                    .or_insert_with(|| Arc::new(Store { name, ..Store::default() }))
                    .downgrade();
                let store = store.value();

                store.inc();
                Arc::clone(store)
            }
        };

        local.borrow_mut().insert(key, copy);
    });
}

pub(crate) fn get<T: 'static>() -> Counts {
    do_get(TypeId::of::<T>())
}
fn do_get(key: TypeId) -> Counts {
    global_store().entry(key).or_default().value().read()
}

pub(crate) fn get_all() -> AllCounts {
    let mut entries = global_store()
        .iter()
        .map(|entry| {
            let store = entry.value();
            (store.type_name(), store.read())
        })
        .collect::<Vec<_>>();
    entries.sort_by_key(|(name, _counts)| *name);
    AllCounts { entries }
}

#[derive(Default)]
struct Store {
    total: AtomicUsize,
    max_live: AtomicUsize,
    live: AtomicUsize,
    name: &'static str,
}

impl Store {
    fn inc(&self) {
        self.total.fetch_add(1, Relaxed);
        let live = self.live.fetch_add(1, Relaxed) + 1;
        self.max_live.fetch_max(live, Relaxed);
    }

    fn dec(&self) {
        self.live.fetch_sub(1, Relaxed);
    }

    fn read(&self) -> Counts {
        Counts {
            total: self.total.load(Relaxed),
            max_live: self.max_live.load(Relaxed),
            live: self.live.load(Relaxed),
        }
    }

    fn type_name(&self) -> &'static str {
        self.name
    }
}
