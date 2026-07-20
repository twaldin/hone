// src/lib.rs
//
// Copyright (C) 2023-2025 James Petersen <m@jamespetersen.ca>
// Licensed under Apache 2.0 OR MIT. See LICENSE-APACHE or LICENSE-MIT

#![warn(missing_docs)]

//! This crate exists to provide a portable method to get any user's home
//! directory. The API is rather simple: there are two main functions,
//! [`home`] and [`my_home`]. The former can get the home directory
//! of any user provided you have their username. The latter can get the home
//! directory of the user executing this process.
//!
//! If all that is necessary is the home directory of the user executing this process,
//! then other crates may be better options, such as
//! [`directories`](https://crates.io/crates/directories). As well, using the home directory to find the
//! documents, downloads, pictures, etc. directories may not be accurate.
//!
//! This crate aims to work on both Windows and Unix systems. However,
//! Unix systems do not have a unified API. This crate may not work
//! on Unix systems which do not have the `getpwnam_r(3)`, `getpwuid_r(3)`,
//! and `getuid(2)` functions. This does not pose a problem on Linux and macOS.
//! As well, Windows has its own set of issues.
//! See [for Windows users](#for-windows-users).
//!
//! For Windows, the
//! [`windows`](https://docs.rs/homedir/latest/x86_64-pc-windows-msvc/homedir/windows/index.html)
//! module contains the implementation details. For Linux, macOS, and other Unix systems, the
//! [`unix`](https://docs.rs/homedir/latest/homedir/unix/index.html) module contains the
//! implementation details.
//!
//! # Usage
//! This crate is on [crates.io](https://crates.io/crates/homedir) and can be used by executing `cargo add homedir`
//! or adding the following to the dependencies in your `Cargo.toml` file.
//!
//! ```toml
//! [dependencies]
//! homedir = "0.3.6"
//! ```
//!
//! # Examples
//! ## Get the process' user's home directory.
//! ```no_run
//! use homedir::my_home;
//! use std::path::PathBuf;
//!
//! # fn main() -> Result<(), homedir::GetHomeError> {
//! // This assumes that the process' user has "/home/jpetersen" as home directory.
//! assert_eq!(
//!     Some(PathBuf::from("/home/jpetersen".to_owned())),
//!     my_home()?
//! );
//! # Ok(())
//! # }
//! ```
//!
//! ## Get an arbitrary user's home directory.
//! ```no_run
//! use homedir::home;
//! use std::path::PathBuf;
//!
//! # fn main() -> Result<(), homedir::GetHomeError> {
//! // This assumes there is a user named `Administrator` which has
//! // `C:\Users\Administrator` as a home directory.
//! assert_eq!(
//!     Some(PathBuf::from("C:\\Users\\Administrator".to_owned())),
//!     home("Administrator")?
//! );
//! assert!(home("NonExistentUser")?.is_none());
//! # Ok(())
//! # }
//! ```
//!
//! # Upgrading from 0.2.1 to 0.3
//! There is a major API restructuring in this version. `get_my_home` has been renamed to
//! [`my_home`] and `get_home` to [`home`]. As well, a cleaner implementation of a cross-platform
//! API has been written, with inspiration taken from the Rust standard library. The
//! [`UserIdentifier`] type now has a platform-agnostic implementation of the root of the crate.
//!
//! This version upgrade removes the `wmi` and `serde` dependencies which rendered this crate
//! larger on the Windows version.
//!
//! # For Windows Users
//! This crate uses the
//! [COM library](https://learn.microsoft.com/en-us/windows/win32/com/the-com-library)
//! to access the Windows Management Instrumentation for [`home`] (not [`my_home`]).
//! To use this library, it is required to call
//! [`CoInitializeEx`](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex)
//! (or `CoInitialize`), which has
//! [some issues](https://github.com/microsoft/windows-rs/issues/1169). When using this crate,
//! this will only *possibly* present an issue to programs that also use the COM library.
//!
//! Referencing the solution provided in the linked issue, the
//! way that this crate uses the COM library is as follows. It will try to
//! [create an
//! instance](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-cocreateinstance).
//! If this fails because the COM library is not yet initialized, it will call `CoInitializeEx`
//! using `COINIT_MULTITHREADED`, and it will not call `CoUninitialize` later. This will interfere
//! with libraries that use `OleInitialize`, which requires `COINIT_APARTMENTTHREADED`.
//!
//! To prevent these issues, the feature `windows-coinitialize` can be used. If it is specified,
//! then the program will call `CoInitializeEx` if `CoCreateInstance` fails. It is specified by
//! default. If you opt not to use it, in order to call
//! [`home`], it will be necessary to first call `CoInitializeEx` with whatever parameters are
//! required, or initialize the other libraries that use it (for example
//! [`wmi`](https://crates.io/crates/wmi)) first.
//!
//! Finally, this program has been tested on a regular Windows 11 installation. It has
//! not been tested within any Active Directory Windows installation, and the implementation does
//! not test for this or try to account for it in any way. If it does work on these, it will likely
//! return the local profile path of the specified user.

use std::fmt;
use std::path::PathBuf;

use cfg_if::cfg_if;

cfg_if! {
    if #[cfg(windows)] {
        /// Contains the implementation of the crate for Windows systems.
        pub mod windows;
        use windows::home as home_imp;
        use windows::my_home as my_home_imp;
        use windows::GetHomeError as GetHomeErrorImp;
        use windows::UserIdentifier as UserIdentifierImp;
    } else if #[cfg(unix)] {
        /// Contains the implementation of the crate for Unix systems.
        pub mod unix;
        use unix::home as home_imp;
        use unix::my_home as my_home_imp;
        use unix::GetHomeError as GetHomeErrorImp;
        use unix::UserIdentifier as UserIdentifierImp;
    } else {
        compile_error!("this crate only supports windows and unix systems");
    }
}

/// This structure represents a user's identifier.
///
/// # Example
/// ```no_run
/// use homedir::UserIdentifier;
///
/// # fn main() -> Result<(), homedir::GetHomeError> {
/// if let Some(identifier) = UserIdentifier::with_username("Administrator")? {
///     println!("{:?}", identifier.to_home()?);
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug)]
#[repr(transparent)]
pub struct UserIdentifier(UserIdentifierImp);

/// This structure contains the error type returned by the functions within this crate.
#[derive(Debug)]
#[repr(transparent)]
pub struct GetHomeError(GetHomeErrorImp);

/// Get the home directory of an arbitrary user. This will return the `Err` variant
/// if an error occurs. If no user with the given username can be found, `Ok(None)` is returned
/// instead.
///
/// There is an example of the usage of this function in the [crate documentation](crate).
pub fn home<S: AsRef<str>>(username: S) -> Result<Option<PathBuf>, GetHomeError> {
    home_imp(username.as_ref()).map_err(GetHomeError)
}

/// Get the home directory of the process' current user.
///
/// There is an example of the usage of this function in the [crate documentation](crate).
pub fn my_home() -> Result<Option<PathBuf>, GetHomeError> {
    my_home_imp().map_err(GetHomeError)
}

impl UserIdentifier {
    /// Get the user identifier of an arbitrary user.
    ///
    /// There is an example of the usage of this function in the
    /// [structure's documentation](UserIdentifier).
    pub fn with_username<S: AsRef<str>>(username: S) -> Result<Option<Self>, GetHomeError> {
        match UserIdentifierImp::with_username(username.as_ref()) {
            Ok(v) => Ok(v.map(Self)),
            Err(e) => Err(GetHomeError(e)),
        }
    }

    /// Get the user identifier of an arbitrary user.
    ///
    /// There is an example of the usage of this function in the
    /// [structure's documentation](UserIdentifier).
    pub fn to_home(&self) -> Result<Option<PathBuf>, GetHomeError> {
        self.0.to_home().map_err(GetHomeError)
    }

    /// Get the user identifier of the process' current user.
    pub fn my_id() -> Result<Self, GetHomeError> {
        match UserIdentifierImp::my_id() {
            Ok(v) => Ok(Self(v)),
            Err(e) => Err(GetHomeError(e)),
        }
    }
}

impl fmt::Display for GetHomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        <GetHomeErrorImp as fmt::Display>::fmt(&self.0, f)
    }
}

impl std::error::Error for GetHomeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.source()
    }
}

impl From<GetHomeError> for GetHomeErrorImp {
    fn from(value: GetHomeError) -> Self {
        value.0
    }
}

impl From<GetHomeErrorImp> for GetHomeError {
    fn from(value: GetHomeErrorImp) -> Self {
        Self(value)
    }
}

impl From<UserIdentifier> for UserIdentifierImp {
    fn from(value: UserIdentifier) -> Self {
        value.0
    }
}

impl From<UserIdentifierImp> for UserIdentifier {
    fn from(value: UserIdentifierImp) -> Self {
        Self(value)
    }
}
