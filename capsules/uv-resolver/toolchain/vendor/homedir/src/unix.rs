// src/unix.rs
//
// Copyright (C) 2023-2024 James Petersen <m@jamespetersen.ca>
// Licensed under Apache 2.0 OR MIT. See LICENSE-APACHE or LICENSE-MIT

use std::env::var_os;
use std::path::PathBuf;

use nix::unistd::Uid;
use nix::unistd::User;

/// The error type returned by this library when errors occur.
pub type GetHomeError = nix::errno::Errno;

/// An identifier for a user.
#[derive(Debug, Clone)]
#[repr(transparent)]
pub struct UserIdentifier(Uid);

/// Get a user's home directory path.
///
/// If some error occurs when obtaining the path, `Err` is returned. If no user
/// associated with `username` could be found, `Ok(None)` is returned. Otherwise,
/// the path to the user's home directory is returned.
///
/// This function uses the [`User::from_name`](nix::unistd::User::from_name)
/// method provided by the nix crate. That method uses the
/// [`getpwnam_r(3)`](https://man7.org/linux/man-pages/man3/getpwnam.3.html)
/// library function to get the home directory from the `/etc/passwd` file.
///
/// # Example
/// ```no_run
/// use homedir::unix::home;
/// use std::path::PathBuf;
///
/// # fn main() -> Result<(), homedir::unix::GetHomeError> {
/// // This assumes there is a user named `root` which has
/// // `/root` as a home directory.
/// assert_eq!(
///     Some(PathBuf::from("/root".to_owned())),
///     home("root")?
/// );
/// assert!(home("nonexistentuser")?.is_none());
/// # Ok(())
/// # }
/// ```
pub fn home<S: AsRef<str>>(username: S) -> Result<Option<PathBuf>, GetHomeError> {
    Ok(User::from_name(username.as_ref())?.map(|user| user.dir))
}

/// Get this process' user's home directory path.
///
/// This function will first check the `$HOME` environment variable. If this variable
/// does not exist, then the `/etc/passwd` file is checked.
///
/// The behaviour of this function is different from that of version 0.1.0.
/// Previously, this function would check the `/etc/passwd` file first, and,
/// should that fail, it would only check the `$HOME` environemnt variable if
/// the `check_env` feature was set. Now, it will check the `$HOME` environment
/// variable first, falling back on the `/etc/passwd` file should that fail.
/// To replicate the original behaviour of the function, do `UserIdentifier::my_id()?.to_home()?`.
/// Note that this can still return `None`, should the `/etc/passwd` file be missing an
/// entry for the user id of the program.
///
/// # Example
/// ```no_run
/// # fn main() -> Result<(), homedir::unix::GetHomeError> {
/// use homedir::unix::my_home;
///
/// // This assumes that the HOME environment variable is set to "/home/jpetersen".
/// assert_eq!(
///     std::path::Path::new("/home/jpetersen"),
///     my_home()?.unwrap().as_path()
/// );
/// # Ok(())
/// # }
/// ```
pub fn my_home() -> Result<Option<PathBuf>, GetHomeError> {
    match var_os("HOME") {
        Some(s) => Ok(Some(PathBuf::from(s))),
        None => Ok(User::from_uid(Uid::current())?.map(|user| user.dir)),
    }
}

impl UserIdentifier {
    /// Get a user's id from their username. This function operates identically to
    /// the [`home`] function, except it reads the `uid` field
    /// from the [`User`] structure instead of the `dir` field. Because of this,
    /// doing `UserIdentifier::with_username(name)?.unwrap().to_home()` is not recommended. Instead,
    /// `home(name)` should be used.
    pub fn with_username<S: AsRef<str>>(username: S) -> Result<Option<Self>, GetHomeError> {
        Ok(User::from_name(username.as_ref())?.map(|user| UserIdentifier(user.uid)))
    }

    /// Get the current process' real user id. This uses the nix crate's [`Uid::current`](nix::unistd::Uid::current)
    /// method, which uses [`getuid(3)`](https://man7.org/linux/man-pages/man3/getuid.3p.html).
    /// This function will never return the `Err` variant on Unix systems. However,
    /// the error is kept so that the API remains the same on both Unix and Windows.
    ///
    /// This function was added to allow programs to obtain the original behaviour of the [`my_home`]
    /// function as it was in version 0.1.0. This behaviour can be obtained by calling `UserIdentifier::get_my_id().unwrap().unwrap().to_home()`.
    pub fn my_id() -> Result<UserIdentifier, GetHomeError> {
        Ok(Self(Uid::current()))
    }

    /// Get a user's home directory path from their user identifier.
    ///
    /// If some error cocurs when obtaining the path, `Err` is returned. If no user
    /// is associated with `id` could be found, `Ok(None)` is returned. Otherwise,
    /// the path to the user's home directory is returned.
    ///
    /// This function uses the [`User::from_uid`](nix::unistd::User::from_uid)
    /// method provided by the nix crate. That method uses the
    /// [`getpwuid_r(3)`](https://man7.org/linux/man-pages/man3/getpwnam.3.html)
    /// library function to get the home directory from the `/etc/passwd` file.
    ///
    /// # Example
    /// ```no_run
    /// use homedir::unix::UserIdentifier;
    /// use nix::unistd::Uid;
    /// use std::path::PathBuf;
    ///
    /// # fn main() -> Result<(), homedir::unix::GetHomeError> {
    /// // This only works on Unix systems, and assumes that the root user's home
    /// // directory is located at /root.
    /// assert_eq!(
    ///     Some(PathBuf::from("/root".to_owned())),
    ///     // See nix::unistd::Uid::from_raw
    ///     UserIdentifier::from(Uid::from_raw(0)).to_home()?,
    /// );
    /// # Ok(())
    /// # }
    /// ```
    pub fn to_home(&self) -> Result<Option<PathBuf>, GetHomeError> {
        Ok(User::from_uid(self.0)?.map(|user| user.dir))
    }
}

impl AsRef<Uid> for UserIdentifier {
    fn as_ref(&self) -> &Uid {
        &self.0
    }
}

impl From<Uid> for UserIdentifier {
    fn from(value: Uid) -> Self {
        Self(value)
    }
}

impl From<UserIdentifier> for Uid {
    fn from(value: UserIdentifier) -> Self {
        value.0
    }
}
