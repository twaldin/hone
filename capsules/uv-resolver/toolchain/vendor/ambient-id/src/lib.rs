//! Detects ambient OIDC credentials in a variety of environments.
//!
//! # Supported Environments
//!
//! * GitHub Actions (with `id-token: write`)
//! * GitLab CI
//! * Buildkite
//!
//! # Usage
//!
//! ```rust,ignore
//! let audience = "my-service";
//! let detector = ambient_id::Detector::new();
//! match detector.detect(audience).await? {
//!     Some(token) => println!("Detected ID token: {}", token.reveal()),
//!     None => println!("No ambient ID token detected"),
//! }
//! ```

#![deny(rustdoc::broken_intra_doc_links)]
#![deny(missing_docs)]
#![deny(unsafe_code)]

use reqwest_middleware::ClientWithMiddleware;
use secrecy::{ExposeSecret, SecretString};

mod buildkite;
mod circleci;
mod github;
mod gitlab;

pub use buildkite::Error as BuildkiteError;
pub use github::Error as GitHubError;
pub use gitlab::Error as GitLabError;

/// A detected ID token.
///
/// This is a newtype around a [`SecretString`] that ensures zero-on-drop
/// semantics for the token.
///
/// The only way to get the token's value is via [`reveal`](IdToken::reveal).
pub struct IdToken(SecretString);

impl IdToken {
    /// Reveals the detected ID token.
    ///
    /// This returns a reference to the inner token, which is a secret
    /// and must be handled with care.
    pub fn reveal(&self) -> &str {
        self.0.expose_secret()
    }
}

/// Errors that can occur during detection.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An error occurred while detecting GitHub Actions credentials.
    #[error("GitHub Actions detection error")]
    GitHubActions(#[from] GitHubError),
    /// An error occurred while detecting GitLab CI credentials.
    #[error("GitLab CI detection error")]
    GitLabCI(#[from] GitLabError),
    /// An error occurred while detecting Buildkite credentials.
    #[error("Buildkite detection error")]
    Buildkite(#[from] buildkite::Error),
    /// An error occurred while detecting CircleCI credentials.
    #[error("CircleCI detection error")]
    CircleCI(#[from] circleci::Error),
}

#[derive(Default)]
struct DetectionState {
    client: ClientWithMiddleware,
}

/// A trait for detecting ambient OIDC credentials.
trait DetectionStrategy {
    type Error;

    fn new(state: &DetectionState) -> Option<Self>
    where
        Self: Sized;

    async fn detect(&self, audience: &str) -> Result<IdToken, Self::Error>;
}

/// Detector for ambient OIDC credentials.
pub struct Detector {
    state: DetectionState,
}

impl Detector {
    /// Creates a new detector with default settings.
    pub fn new() -> Self {
        Detector {
            state: Default::default(),
        }
    }

    /// Creates a new detector with the given HTTP client middleware stack.
    pub fn new_with_client(client: impl Into<ClientWithMiddleware>) -> Self {
        Detector {
            state: DetectionState {
                client: client.into(),
            },
        }
    }

    /// Detects ambient OIDC credentials in the current environment.
    ///
    /// The given `audience` controls the `aud` claim in the returned ID token.
    ///
    /// This function runs a series of detection strategies and returns
    /// the first successful one. If no credentials are found,
    /// it returns `Ok(None)`.
    ///
    /// If any (hard) errors occur during detection, it returns `Err`.
    pub async fn detect(&self, audience: &str) -> Result<Option<IdToken>, Error> {
        macro_rules! detect {
        ($detector:path) => {
            if let Some(detector) = <$detector>::new(&self.state) {
                detector.detect(audience).await.map_err(Into::into).map(Some)
            } else {
                Ok(None)
            }
        };
        ($detector:path, $($rest:path),+) => {
            if let Some(detector) = <$detector>::new(&self.state) {
                detector.detect(audience).await.map_err(Into::into).map(Some)
            } else {
                detect!($($rest),+)
            }
        };
    }

        detect!(
            github::GitHubActions,
            gitlab::GitLabCI,
            buildkite::Buildkite,
            circleci::CircleCI
        )
    }
}

#[cfg(test)]
mod tests {
    use crate::Detector;

    /// An environment variable delta.
    enum EnvDelta {
        /// Set an environment variable to a value.
        Add(String, String),
        /// Unset an environment variable.
        Remove(String),
    }

    /// A RAII guard for setting and unsetting environment variables.
    ///
    /// This maintains a stack of changes to unwind on drop; changes
    /// are unwound the reverse order of application
    pub(crate) struct EnvScope {
        changes: Vec<EnvDelta>,
    }

    impl EnvScope {
        pub fn new() -> Self {
            EnvScope { changes: vec![] }
        }

        /// Sets an environment variable for the duration of this scope.
        #[allow(unsafe_code)]
        pub fn setenv(&mut self, key: &str, value: &str) {
            match std::env::var(key) {
                // Key was set before; restore old value on drop.
                Ok(old) => self.changes.push(EnvDelta::Add(key.to_string(), old)),
                // Key was not set before; remove it on drop.
                Err(_) => self.changes.push(EnvDelta::Remove(key.to_string())),
            }

            unsafe { std::env::set_var(key, value) };
        }

        /// Removes an environment variable for the duration of this scope.
        #[allow(unsafe_code)]
        pub fn unsetenv(&mut self, key: &str) {
            match std::env::var(key) {
                // Key was set before; restore old value on drop.
                Ok(old) => self.changes.push(EnvDelta::Add(key.to_string(), old)),
                // Key was not set before; nothing to do.
                Err(_) => {}
            }

            unsafe { std::env::remove_var(key) };
        }
    }

    impl Drop for EnvScope {
        #[allow(unsafe_code)]
        fn drop(&mut self) {
            // Unwind changes in reverse order.
            for change in self.changes.drain(..).rev() {
                match change {
                    EnvDelta::Add(key, value) => unsafe { std::env::set_var(key, value) },
                    EnvDelta::Remove(key) => unsafe { std::env::remove_var(key) },
                }
            }
        }
    }

    #[tokio::test]
    async fn test_no_detection() {
        let mut scope = EnvScope::new();
        scope.unsetenv("GITHUB_ACTIONS");
        scope.unsetenv("GITLAB_CI");
        scope.unsetenv("BUILDKITE");
        scope.unsetenv("CIRCLECI");

        let detector = Detector::new();

        assert!(
            detector
                .detect("bupkis")
                .await
                .expect("should not error")
                .is_none()
        );
    }
}
