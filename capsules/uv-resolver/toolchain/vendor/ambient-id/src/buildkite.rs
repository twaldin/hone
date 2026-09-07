//! Buildkite OIDC token detection.

use crate::DetectionStrategy;

/// Possible errors during Buildkite OIDC token detection.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// An error occurred while executing the `buildkite-agent` command.
    #[error("failed to obtain OIDC token from `buildkite-agent` CLI")]
    Execution(#[from] std::io::Error),
}

pub(crate) struct Buildkite;

impl DetectionStrategy for Buildkite {
    type Error = Error;

    fn new(_state: &crate::DetectionState) -> Option<Self>
    where
        Self: Sized,
    {
        // https://buildkite.com/docs/pipelines/configure/environment-variables#buildkite-environment-variables
        std::env::var("BUILDKITE")
            .ok()
            .filter(|v| v == "true")
            .map(|_| Buildkite)
    }

    /// On Buildkite, the OIDC token is provided by the `buildkite-agent`
    /// tool. Specifically, we need to invoke:
    ///
    /// ```sh
    /// buildkite-agent oidc request-token --audience <audience>
    /// ```
    ///
    /// The standard output of this command is the ID token on success.
    async fn detect(&self, audience: &str) -> Result<crate::IdToken, Self::Error> {
        let output = std::process::Command::new("buildkite-agent")
            .args(&["oidc", "request-token", "--audience", audience])
            .output()?;

        if !output.status.success() {
            return Err(Error::Execution(std::io::Error::new(
                std::io::ErrorKind::Other,
                format!(
                    "`buildkite-agent` exited with code {status}: '{stderr}'",
                    status = output.status,
                    stderr = String::from_utf8_lossy(&output.stderr),
                ),
            )));
        }

        let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(crate::IdToken(token.into()))
    }
}

#[cfg(test)]
mod tests {
    use crate::{DetectionStrategy as _, buildkite::Buildkite, tests::EnvScope};

    #[tokio::test]
    async fn test_not_detected() {
        let mut scope = EnvScope::new();
        scope.unsetenv("BUILDKITE");

        let state = Default::default();
        assert!(Buildkite::new(&state).is_none());
    }

    #[tokio::test]
    async fn test_detected() {
        let mut scope = EnvScope::new();
        scope.setenv("BUILDKITE", "true");

        let state = Default::default();
        assert!(Buildkite::new(&state).is_some());
    }

    /// Happy path for Buildkite OIDC token detection.
    #[tokio::test]
    #[cfg_attr(not(feature = "test-buildkite-1p"), ignore)]
    async fn test_1p_detection_ok() {
        let _ = EnvScope::new();
        let state = Default::default();
        let detector = Buildkite::new(&state).expect("should detect Buildkite");
        let token = detector
            .detect("test_1p_detection_ok")
            .await
            .expect("should fetch token");

        assert!(token.reveal().starts_with("eyJ"));
    }
}
